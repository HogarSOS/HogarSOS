import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    // findFirst: revisión adversarial final — procesarEventoDisputa lo
    // usa para distinguir "duplicado" de "payment_no_encontrado" cuando
    // el UPDATE guardado afecta 0 filas.
    payment: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    professional: { findFirst: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: { webhooks: { constructEvent: jest.fn() } },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/email.service', () => ({
  enviarEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/professional.service', () => ({
  sincronizarEstadoCuentaStripe: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { stripeWebhook } from '../payment.controller';
import { enviarNotificacion } from '../../services/notification.service';
import { enviarEmail } from '../../services/email.service';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;
const mockEnviarEmail = enviarEmail as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(): Request {
  return { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
}

describe('stripeWebhook — precondiciones de estado (auditoría, hallazgo #6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  // Stripe no garantiza el orden de entrega de webhooks. Un evento
  // payment_failed/canceled que llega DESPUÉS de que releasePayments ya
  // capturó o liberó esa misma autorización no debe degradarla — la
  // única defensa posible desde este lado es exigir que la fila siga en
  // 'retenido' en el propio WHERE del updateMany.
  it('payment_intent.payment_failed solo puede degradar una fila "pendiente" o "retenido"', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1' } },
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_1', estado: { in: ['pendiente', 'retenido'] } },
      data: { estado: 'fallido' },
    });
  });

  it('payment_intent.canceled solo puede degradar una fila "pendiente" o "retenido"', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_1' } },
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_1', estado: { in: ['pendiente', 'retenido'] } },
      data: { estado: 'reembolsado' },
    });
  });

  // B5: tras reautorizarPaymentIntent, la fila Payment ya no tiene el
  // stripePaymentIntentId viejo (se sobrescribió por el nuevo) — un
  // webhook `canceled` tardío del PaymentIntent viejo que llega DESPUÉS
  // de la reautorización no encuentra ninguna fila con ese id (count: 0)
  // y no debe tocar ni revertir la fila ya reautorizada.
  it('un webhook canceled tardío del PaymentIntent viejo tras reautorizar (B5) no encuentra fila y no revierte nada', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_viejo_canceled' } },
    });
    // La fila ya fue reautorizada: su stripePaymentIntentId ahora es
    // 'pi_nuevo_2', así que el updateMany por 'pi_viejo_canceled' no
    // encuentra ninguna coincidencia.
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await stripeWebhook(fakeReq(), res);

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_viejo_canceled', estado: { in: ['pendiente', 'retenido'] } },
      data: { estado: 'reembolsado' },
    });
    // No lanza, responde igual que cualquier webhook procesado sin más efecto.
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  // Bug real encontrado en QA (2026-08-08): createEscrowPaymentIntent crea
  // la fila Payment en 'pendiente' en cuanto se crea el PaymentIntent en
  // Stripe, ANTES de que el cliente confirme nada — si nunca confirma
  // (Payment Sheet cancelado/abandonado), sin este webhook la fila se
  // quedaría en 'pendiente' para siempre, que es justo el estado correcto
  // en ese caso. Solo cuando Stripe confirma la autorización de verdad
  // (amount_capturable_updated) debe subir a 'retenido'.
  describe('payment_intent.amount_capturable_updated', () => {
    it('sube la fila de "pendiente" a "retenido" y notifica al profesional', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'payment_intent.amount_capturable_updated',
        data: { object: { id: 'pi_1' } },
      });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pago-1',
        serviceRequestId: 'sr-1',
        serviceRequest: { profesionalId: 'prof-1' },
      });

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_1', estado: 'pendiente' },
        data: { estado: 'retenido' },
      });
      expect(enviarNotificacion).toHaveBeenCalledWith(
        'prof-1',
        'pago_autorizado',
        {},
        { solicitudId: 'sr-1' }
      );
    });

    it('no notifica dos veces si el webhook se reintenta (la fila ya no está "pendiente")', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue({
        type: 'payment_intent.amount_capturable_updated',
        data: { object: { id: 'pi_1' } },
      });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockPrisma.payment.findUnique).not.toHaveBeenCalled();
      expect(enviarNotificacion).not.toHaveBeenCalled();
    });
  });

  it('responde 400 si la firma del webhook es inválida', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('firma inválida');
    });
    const res = fakeRes();

    await stripeWebhook(fakeReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * P2 #7: charge.dispute.created/updated/closed comparten una única
 * función de escritura (procesarEventoDisputa), idempotente y segura
 * ante desorden — condicionada a que event.created sea más reciente que
 * el último evento de disputa ya aplicado a esa fila.
 */
describe('stripeWebhook — charge.dispute.* (P2 #7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.SMTP_USER = 'soporte@hogarsos.es';
  });

  function disputaEvento(overrides: Record<string, unknown> = {}, eventCreated = 1000, eventId = 'evt_1') {
    return {
      id: eventId,
      type: 'charge.dispute.created',
      created: eventCreated,
      data: {
        object: {
          id: 'dp_1',
          amount: 4500,
          currency: 'eur',
          status: 'needs_response',
          reason: 'fraudulent',
          payment_intent: 'pi_1',
          evidence_details: { due_by: 2000 },
          ...overrides,
        },
      },
    };
  }

  it('created la primera vez: escribe id/estado/monto/evento/eventoId y avisa por log y email', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue(disputaEvento());
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: {
        stripePaymentIntentId: 'pi_1',
        OR: [
          { stripeDisputeUltimoEventoEn: null },
          { stripeDisputeUltimoEventoEn: { lt: new Date(1000 * 1000) } },
          {
            stripeDisputeUltimoEventoEn: new Date(1000 * 1000),
            OR: [{ stripeDisputeUltimoEventoId: null }, { stripeDisputeUltimoEventoId: { not: 'evt_1' } }],
          },
        ],
      },
      data: {
        stripeDisputeId: 'dp_1',
        stripeDisputeStatus: 'needs_response',
        stripeDisputeMonto: 45,
        stripeDisputeUltimoEventoEn: new Date(1000 * 1000),
        stripeDisputeUltimoEventoId: 'evt_1',
      },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('CONTRACARGO'));
    expect(mockEnviarEmail).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  describe('revisión adversarial final — desempate por event.id (Hallazgo 1)', () => {
    it('mismo event.id + mismo event.created (redelivery exacta): no reescribe ni reenvía el email', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(disputaEvento({}, 1000, 'evt_1'));
      // Redelivery exacta: el UPDATE guardado no encuentra ninguna fila
      // (mismo segundo, mismo event.id ya aplicado antes).
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
      // El payment_intent SÍ existe — es un duplicado genuino, no un
      // fallo de reconciliación.
      mockPrisma.payment.findFirst.mockResolvedValue({ id: 'pago-1' });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockEnviarEmail).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining('CONTRACARGO'));

      consoleErrorSpy.mockRestore();
    });

    it('event.id DISTINTO + mismo event.created (evento nuevo en el mismo segundo): SÍ se aplica', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        disputaEvento({ status: 'under_review' }, 1000, 'evt_2')
      );
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                stripeDisputeUltimoEventoEn: new Date(1000 * 1000),
                OR: [{ stripeDisputeUltimoEventoId: null }, { stripeDisputeUltimoEventoId: { not: 'evt_2' } }],
              },
            ]),
          }),
          data: expect.objectContaining({ stripeDisputeUltimoEventoId: 'evt_2' }),
        })
      );
      expect(mockEnviarEmail).toHaveBeenCalledTimes(1);

      consoleErrorSpy.mockRestore();
    });

    it('evento antiguo (event.created menor): se ignora', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(disputaEvento({}, 500, 'evt_viejo'));
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.payment.findFirst.mockResolvedValue({ id: 'pago-1' });

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockEnviarEmail).not.toHaveBeenCalled();
    });

    it('evento nuevo (event.created mayor): se aplica', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(disputaEvento({}, 5000, 'evt_nuevo'));
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockEnviarEmail).toHaveBeenCalledTimes(1);
    });

    // Nuevo → antiguo: el WHERE por sí mismo es lo que garantiza que el
    // estado final se queda en el más nuevo — un evento antiguo llegado
    // después simplemente no encuentra fila que actualizar.
    it('evento nuevo y después uno antiguo: el estado nuevo permanece (el antiguo no encuentra fila)', async () => {
      // 1) Evento nuevo se aplica.
      mockStripe.webhooks.constructEvent.mockReturnValue(disputaEvento({ status: 'under_review' }, 5000, 'evt_nuevo'));
      mockPrisma.payment.updateMany.mockResolvedValueOnce({ count: 1 });
      await stripeWebhook(fakeReq(), fakeRes());

      // 2) Evento antiguo llega después: su WHERE exige
      // stripeDisputeUltimoEventoEn < 3000, pero ya hay un 5000 guardado
      // (fuera del alcance de este mock simular el estado real de BD,
      // así que se refleja devolviendo count:0 — el mismo resultado que
      // produciría el WHERE real contra la fila ya actualizada).
      mockStripe.webhooks.constructEvent.mockReturnValue(disputaEvento({ status: 'needs_response' }, 3000, 'evt_viejo'));
      mockPrisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.payment.findFirst.mockResolvedValue({ id: 'pago-1' });
      await stripeWebhook(fakeReq(), fakeRes());

      // El segundo intento (evento viejo) nunca llegó a escribir nada —
      // solo se llamó una vez con éxito real (el evento nuevo).
      expect(mockEnviarEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('revisión adversarial final — payment_intent sin Payment local (Hallazgo 2)', () => {
    it('dispute con payment_intent que no coincide con ningún Payment: NO se silencia, se alerta explícitamente', async () => {
      // event.id propio (no el default 'evt_1'): el dedup de alertas de
      // payment_no_encontrado vive en un Set en memoria a nivel de
      // módulo que persiste entre tests de este archivo — cada test que
      // ejercita ese camino necesita su propio event.id para no
      // contaminar a los demás.
      mockStripe.webhooks.constructEvent.mockReturnValue(
        disputaEvento({ payment_intent: 'pi_desconocido' }, 1000, 'evt_no_match_1')
      );
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
      // Ninguna fila tiene ese payment_intent — fallo de reconciliación real.
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await stripeWebhook(fakeReq(), fakeRes());

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('SIN Payment local asociado')
      );
      expect(mockEnviarEmail).toHaveBeenCalledTimes(1);
      const [, asunto, cuerpo] = mockEnviarEmail.mock.calls[0];
      expect(asunto).toContain('SIN pago asociado');
      expect(cuerpo).toContain('dp_1');
      expect(cuerpo).toContain('pi_desconocido');

      consoleErrorSpy.mockRestore();
    });

    it('redelivery del mismo evento sin Payment asociado: no duplica el email de alerta', async () => {
      // Mismo event.id en ambas llamadas — es literalmente Stripe
      // reintentando la entrega del mismo webhook (p. ej. porque no
      // recibió el 200 a tiempo). No hay ningún Payment donde guardar
      // "ya se avisó de este evento" (a diferencia del camino
      // 'aplicado', que se apoya en stripeDisputeUltimoEventoId), así
      // que el dedup se hace con eventosSinPaymentYaAlertados, un Set en
      // memoria keyed por event.id.
      mockStripe.webhooks.constructEvent.mockReturnValue(
        disputaEvento({ payment_intent: 'pi_desconocido' }, 1000, 'evt_no_match_redelivery')
      );
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      await stripeWebhook(fakeReq(), fakeRes());
      await stripeWebhook(fakeReq(), fakeRes());

      // Solo la primera entrega alerta — la redelivery exacta del mismo
      // event.id no debe duplicar el correo a soporte.
      expect(mockEnviarEmail).toHaveBeenCalledTimes(1);
    });

    it('closed/updated con payment_intent sin match: NO envían el aviso específico de .created (fuera de alcance de esta ronda)', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue({
        ...disputaEvento({ payment_intent: 'pi_desconocido', status: 'won' }, 3000, 'evt_no_match_closed'),
        type: 'charge.dispute.closed',
      });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      await stripeWebhook(fakeReq(), fakeRes());

      // .closed no aplica el evento (payment_no_encontrado !== 'aplicado')
      // y no envía el email de resolución habitual. Al ser un
      // event.id distinto de los demás tests de este bloque, tampoco
      // interfiere con el dedup del camino .created.
      expect(mockEnviarEmail).not.toHaveBeenCalled();
    });
  });

  it('updated: actualiza el estado sin log ni email propios', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      ...disputaEvento({ status: 'under_review' }, 2000),
      type: 'charge.dispute.updated',
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeDisputeStatus: 'under_review' }) })
    );
    expect(mockEnviarEmail).not.toHaveBeenCalled();
  });

  it('closed/won: actualiza el estado y avisa (sin mensaje de pérdida permanente)', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      ...disputaEvento({ status: 'won' }, 3000),
      type: 'charge.dispute.closed',
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeDisputeStatus: 'won' }) })
    );
    expect(mockEnviarEmail).toHaveBeenCalledTimes(1);
    const [, asunto, cuerpo] = mockEnviarEmail.mock.calls[0];
    expect(asunto.toLowerCase()).toContain('ganada');
    expect(cuerpo).not.toContain('perdido de forma permanente');
  });

  it('closed/lost: actualiza el estado y el email advierte de la pérdida permanente', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      ...disputaEvento({ status: 'lost' }, 3000),
      type: 'charge.dispute.closed',
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeDisputeStatus: 'lost' }) })
    );
    const [, asunto, cuerpo] = mockEnviarEmail.mock.calls[0];
    expect(asunto.toLowerCase()).toContain('perdida');
    expect(cuerpo).toContain('perdido de forma permanente');
  });

  it('warning_closed: actualiza el estado (libera el guard — probado en payment.service.test.ts)', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      ...disputaEvento({ status: 'warning_closed' }, 3000),
      type: 'charge.dispute.closed',
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeDisputeStatus: 'warning_closed' }) })
    );
  });

  it('evento antiguo entregado después de uno más nuevo ya aplicado: el UPDATE no encuentra fila (guarda por event.created), estado no regresiona', async () => {
    // Un .updated con event.created MÁS ANTIGUO que el .closed ya
    // aplicado — el WHERE exige stripeDisputeUltimoEventoEn < event.created,
    // así que si ya hay un valor más reciente guardado, este UPDATE
    // simplemente no encuentra ninguna fila que cumpla la condición.
    mockStripe.webhooks.constructEvent.mockReturnValue({
      ...disputaEvento({ status: 'under_review' }, 500), // más antiguo que el 'won' ya aplicado
      type: 'charge.dispute.updated',
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await stripeWebhook(fakeReq(), fakeRes());

    // No hay ninguna forma de "revertir" desde aquí — el propio WHERE
    // ya impidió la escritura. Confirmamos que se intentó con el WHERE
    // correcto (comparando contra el timestamp de ESTE evento, no el
    // que ya está guardado, que este código no conoce).
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { stripeDisputeUltimoEventoEn: null },
            { stripeDisputeUltimoEventoEn: { lt: new Date(500 * 1000) } },
            {
              stripeDisputeUltimoEventoEn: new Date(500 * 1000),
              OR: [{ stripeDisputeUltimoEventoId: null }, { stripeDisputeUltimoEventoId: { not: 'evt_1' } }],
            },
          ],
        }),
      })
    );

    consoleErrorSpy.mockRestore();
  });

  describe('sin payment_intent en el evento (caso distinto de payment_intent inexistente)', () => {
    // procesarEventoDisputa corta antes de tocar la BD cuando el evento
    // no trae payment_intent en absoluto — comparte el mismo resultado
    // 'payment_no_encontrado' que un payment_intent que no matchea
    // ningún Payment, así que .created también debe alertar aquí.
    it('no modifica la BD', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        disputaEvento({ payment_intent: undefined }, 1000, 'evt_sin_pi_1')
      );

      await stripeWebhook(fakeReq(), fakeRes());

      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it('genera log y alerta por email (mismo camino que payment_intent inexistente)', async () => {
      // event.id propio: ver nota de aislamiento entre tests en el
      // bloque "payment_intent sin Payment local" de arriba — mismo Set
      // de dedup en memoria, mismo requisito.
      mockStripe.webhooks.constructEvent.mockReturnValue(
        disputaEvento({ payment_intent: undefined }, 1000, 'evt_sin_pi_2')
      );
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await stripeWebhook(fakeReq(), fakeRes());

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('SIN Payment local asociado'));
      expect(mockEnviarEmail).toHaveBeenCalledTimes(1);
      const [, , cuerpo] = mockEnviarEmail.mock.calls[0];
      expect(cuerpo).toContain('no incluido en el evento');

      consoleErrorSpy.mockRestore();
    });

    it('no lanza una excepción destructiva: la petición responde con éxito (200, received:true)', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(
        disputaEvento({ payment_intent: undefined }, 1000, 'evt_sin_pi_3')
      );
      const res = fakeRes();

      await stripeWebhook(fakeReq(), res);

      expect(res.json).toHaveBeenCalledWith({ received: true });
      expect(res.status).not.toHaveBeenCalledWith(500);
    });
  });
});
