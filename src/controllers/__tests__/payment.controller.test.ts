import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: { paymentIntents: { retrieve: jest.fn() } },
}));

jest.mock('../../services/payment.service', () => ({
  createEscrowPaymentIntent: jest.fn(),
  reautorizarPaymentIntent: jest.fn(),
  obtenerOCrearStripeCustomerId: jest.fn(),
  crearEphemeralKey: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import {
  createEscrowPaymentIntent,
  reautorizarPaymentIntent,
  obtenerOCrearStripeCustomerId,
  crearEphemeralKey,
} from '../../services/payment.service';
import { createPaymentIntent } from '../payment.controller';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;
const mockCreateEscrow = createEscrowPaymentIntent as jest.Mock;
const mockReautorizar = reautorizarPaymentIntent as jest.Mock;
const mockObtenerCustomerId = obtenerOCrearStripeCustomerId as jest.Mock;
const mockCrearEphemeralKey = crearEphemeralKey as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string, body: Record<string, unknown>): Request {
  return { params: {}, user: { userId }, body } as unknown as Request;
}

const SR_ID = '11111111-1111-1111-1111-111111111111';

function solicitud(overrides: {
  clienteId?: string;
  estado?: string;
  pagos?: Record<string, unknown>[];
  presupuesto?: Record<string, unknown> | null;
  ampliaciones?: Record<string, unknown>[];
}) {
  const presupuesto = overrides.presupuesto === undefined ? { id: 'pres-1', tipo: 'cerrado', monto: 180 } : overrides.presupuesto;
  return {
    id: SR_ID,
    clienteId: overrides.clienteId ?? 'cliente-1',
    estado: overrides.estado ?? 'aceptada',
    pagos: overrides.pagos ?? [],
    presupuestos: presupuesto ? [{ ...presupuesto, ampliaciones: overrides.ampliaciones ?? [] }] : [],
  };
}

describe('createPaymentIntent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateEscrow.mockResolvedValue({
      pago: { id: 'pago-1', montoBase: 95.24, montoTotal: 100, comisionPlataforma: 10 },
      clientSecret: 'secret_123',
      customerId: 'cus_123',
      ephemeralKeySecret: 'ek_123',
    });
    mockObtenerCustomerId.mockResolvedValue('cus_123');
    mockCrearEphemeralKey.mockResolvedValue('ek_123');
  });

  it('usa el monto del presupuesto cerrado aceptado (autorización inicial)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({ presupuesto: { id: 'pres-1', tipo: 'cerrado', monto: 180 } })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockCreateEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ serviceRequestId: SR_ID, presupuestoId: 'pres-1', montoBase: 180, ampliacionId: undefined })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  /**
   * Caso normal (auditoría B5, punto 3): un trabajo de 1 día nunca tiene
   * un pago previo para ese presupuesto, así que jamás entra en la rama
   * de reintento/reautorización — el fix de B5 no debe cambiar nada aquí.
   */
  it('caso normal (sin autorización previa): no consulta Stripe ni pasa por reautorización', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({ presupuesto: { id: 'pres-1', tipo: 'cerrado', monto: 500 } })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(mockReautorizar).not.toHaveBeenCalled();
    expect(mockCreateEscrow).toHaveBeenCalledWith(expect.objectContaining({ montoBase: 500 }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('usa tarifaHora * horasEstimadas para un presupuesto por horas aceptado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({ presupuesto: { id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 } })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockCreateEscrow).toHaveBeenCalledWith(expect.objectContaining({ montoBase: 100 }));
  });

  it('devuelve 409 si no hay ningún presupuesto aceptado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ presupuesto: null }));

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('devuelve 403 si no es el cliente de la solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ clienteId: 'otro-cliente' }));

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('devuelve 409 si la solicitud no está aceptada ni en progreso', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ estado: 'pendiente' }));

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 409 si ya hay pago inicial y no hay ninguna ampliación aceptada sin autorizar', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({ pagos: [{ presupuestoId: 'pres-1', ampliacionId: null }] })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('autoriza el importe de una ampliación aceptada cuando ya existe la autorización inicial', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({
        presupuesto: { id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 },
        pagos: [{ presupuestoId: 'pres-1', ampliacionId: null }],
        ampliaciones: [{ id: 'ampl-1', horasAdicionales: 2 }],
      })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockCreateEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ presupuestoId: 'pres-1', ampliacionId: 'ampl-1', montoBase: 50 })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('"cerrado": autoriza el montoAdicional de una ampliación aceptada', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({
        presupuesto: { id: 'pres-1', tipo: 'cerrado', monto: 250 },
        pagos: [{ presupuestoId: 'pres-1', ampliacionId: null }],
        ampliaciones: [{ id: 'ampl-1', montoAdicional: 40 }],
      })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockCreateEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ presupuestoId: 'pres-1', ampliacionId: 'ampl-1', montoBase: 40 })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('devuelve 409 si la ampliación aceptada ya tiene su propia autorización', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({
        presupuesto: { id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 },
        pagos: [
          { presupuestoId: 'pres-1', ampliacionId: null },
          { presupuestoId: 'pres-1', ampliacionId: 'ampl-1' },
        ],
        ampliaciones: [{ id: 'ampl-1', horasAdicionales: 2 }],
      })
    );

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });
});

/**
 * REVISIÓN FINAL PRE-LANZAMIENTO (2026-08-04): 3D Secure.
 *
 * En modo test las tarjetas no disparan 3DS salvo que se usen las
 * específicas, así que este escenario casi no aparecía. En Stripe Live,
 * la mayoría de tarjetas europeas SÍ lo disparan por PSD2/SCA — pasa a
 * ser el caso normal, no la excepción.
 */
describe('createPaymentIntent — reintento tras 3D Secure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObtenerCustomerId.mockResolvedValue('cus_1');
    mockCrearEphemeralKey.mockResolvedValue('ek_1');
  });

  const pagoPendiente = {
    id: 'pago-1',
    presupuestoId: 'pres-1',
    ampliacionId: null,
    stripePaymentIntentId: 'pi_1',
    montoBase: 180,
    montoTotal: 189,
    comisionPlataforma: 9,
  };

  /**
   * El cliente abrió el 3DS de su banco y cerró la app. Antes de este
   * arreglo, el endpoint no consideraba `requires_action` reintentable y
   * acababa devolviendo 409 "No hay nada pendiente de autorizar" — el
   * cliente se quedaba sin poder pagar, con un mensaje que decía justo
   * lo contrario de lo que pasaba.
   */
  it('deja retomar el pago si el 3DS quedó a medias (requires_action)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ pagos: [pagoPendiente] }));
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      status: 'requires_action',
      client_secret: 'secret_retomar',
    });
    const res = fakeRes();

    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'secret_retomar', paymentId: 'pago-1' })
    );
    // Se reutiliza el MISMO PaymentIntent: crear uno nuevo dejaría el
    // anterior colgando y podría acabar en doble autorización.
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('también deja retomar si quedó en requires_confirmation', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ pagos: [pagoPendiente] }));
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      status: 'requires_confirmation',
      client_secret: 'secret_confirmar',
    });
    const res = fakeRes();

    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  /** Una autorización YA confirmada no debe poder reintentarse: eso sí sería doble cobro. */
  it('NO deja reintentar una autorización ya confirmada (requires_capture)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ pagos: [pagoPendiente] }));
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture', client_secret: 'x' });
    const res = fakeRes();

    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });
});

/**
 * B5: la autorización caducó de verdad en Stripe (`canceled`, estado
 * terminal) — a diferencia de `requires_action`/`requires_confirmation`/
 * `requires_payment_method`, reconfirmar el mismo PaymentIntent no
 * funciona nunca. createPaymentIntent debe reautorizar en vez de reusar
 * el client_secret muerto.
 */
describe('createPaymentIntent — reautorización tras caducidad (B5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObtenerCustomerId.mockResolvedValue('cus_1');
    mockCrearEphemeralKey.mockResolvedValue('ek_1');
  });

  const pagoCaducado = {
    id: 'pago-viejo',
    presupuestoId: 'pres-1',
    ampliacionId: null,
    stripePaymentIntentId: 'pi_viejo_canceled',
    montoBase: 180,
    montoTotal: 189,
    comisionPlataforma: 9,
    intentosAutorizacion: 0,
  };

  it('reautoriza (NO reintenta) cuando Stripe confirma que el PaymentIntent está canceled', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ pagos: [pagoCaducado] }));
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled', client_secret: 'secret_muerto' });
    mockReautorizar.mockResolvedValue({
      pago: { id: 'pago-viejo', montoBase: 180, montoTotal: 189, comisionPlataforma: 9 },
      clientSecret: 'secret_nuevo',
      customerId: 'cus_1',
      ephemeralKeySecret: 'ek_1',
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockReautorizar).toHaveBeenCalledWith(expect.objectContaining({ id: 'pago-viejo' }), 'cus_1');
    // Crucial: NUNCA se crea una fila Payment nueva para esta reautorización.
    expect(mockCreateEscrow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const respuesta = (res.json as jest.Mock).mock.calls[0][0];
    expect(respuesta.clientSecret).toBe('secret_nuevo');
    expect(respuesta.clientSecret).not.toBe('secret_muerto');
    expect(respuesta.paymentId).toBe('pago-viejo');
  });

  it('reautoriza también la última autorización de una ampliación cuando su PaymentIntent está canceled', async () => {
    const ampliacionCaducada = { ...pagoCaducado, id: 'pago-ampliacion-viejo', ampliacionId: 'ampl-1' };
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(
      solicitud({
        presupuesto: { id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 },
        pagos: [{ ...pagoCaducado, stripePaymentIntentId: null }, ampliacionCaducada],
        ampliaciones: [{ id: 'ampl-1', horasAdicionales: 2 }],
      })
    );
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled', client_secret: 'secret_muerto_amp' });
    mockReautorizar.mockResolvedValue({
      pago: { id: 'pago-ampliacion-viejo', montoBase: 50, montoTotal: 52.5, comisionPlataforma: 2.5 },
      clientSecret: 'secret_nuevo_amp',
      customerId: 'cus_1',
      ephemeralKeySecret: 'ek_1',
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockReautorizar).toHaveBeenCalledWith(expect.objectContaining({ id: 'pago-ampliacion-viejo' }), 'cus_1');
    expect(mockCreateEscrow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect((res.json as jest.Mock).mock.calls[0][0].clientSecret).toBe('secret_nuevo_amp');
  });

  it('doble clic: dos peticiones simultáneas sobre la misma fila caducada llaman a reautorizarPaymentIntent con la misma fila (la idempotencia real vive en Stripe/BD, no aquí)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ pagos: [pagoCaducado] }));
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled', client_secret: 'secret_muerto' });
    mockReautorizar.mockResolvedValue({
      pago: { id: 'pago-viejo', montoBase: 180, montoTotal: 189, comisionPlataforma: 9 },
      clientSecret: 'secret_nuevo',
      customerId: 'cus_1',
      ephemeralKeySecret: 'ek_1',
    });

    const [res1, res2] = [fakeRes(), fakeRes()];
    await Promise.all([
      createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res1),
      createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res2),
    ]);

    expect(mockReautorizar).toHaveBeenCalledTimes(2);
    // Ambas llamadas parten de la MISMA fila leída (mismo id, mismo
    // intentosAutorizacion) -> misma idempotency key dentro de
    // reautorizarPaymentIntent, que es donde Stripe garantiza devolver el
    // mismo PaymentIntent a las dos (probado en payment.service.test.ts).
    const llamadas = mockReautorizar.mock.calls;
    expect(llamadas[0][0].id).toBe(llamadas[1][0].id);
    expect(llamadas[0][0].intentosAutorizacion).toBe(llamadas[1][0].intentosAutorizacion);
  });

  it('el importe devuelto es el que ya trae la fila reautorizada, nunca uno enviado por el cliente', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitud({ pagos: [pagoCaducado] }));
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled', client_secret: 'secret_muerto' });
    mockReautorizar.mockResolvedValue({
      pago: { id: 'pago-viejo', montoBase: 180, montoTotal: 189, comisionPlataforma: 9 },
      clientSecret: 'secret_nuevo',
      customerId: 'cus_1',
      ephemeralKeySecret: 'ek_1',
    });

    const res = fakeRes();
    // req.body no lleva ningún importe — createIntentSchema ni siquiera lo acepta.
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID, montoBase: 1 }), res);

    const respuesta = (res.json as jest.Mock).mock.calls[0][0];
    expect(respuesta.montoBase).toBe(180);
    expect(respuesta.montoTotal).toBe(189);
    expect(respuesta.comisionPlataforma).toBe(9);
  });
});
