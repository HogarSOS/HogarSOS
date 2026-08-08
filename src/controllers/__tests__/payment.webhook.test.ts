import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    payment: { findUnique: jest.fn(), updateMany: jest.fn() },
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

const mockPrisma = prisma as any;
const mockStripe = stripe as any;

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
