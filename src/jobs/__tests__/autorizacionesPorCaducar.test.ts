jest.mock('../../config/prisma', () => ({
  prisma: { payment: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() } },
}));

jest.mock('../../config/stripe', () => ({
  stripe: { paymentIntents: { retrieve: jest.fn() } },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { enviarNotificacion } from '../../services/notification.service';
import { revisarAutorizacionesPorCaducar } from '../autorizacionesPorCaducar.job';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;
const mockNotificar = enviarNotificacion as jest.Mock;

const UN_DIA = 24 * 60 * 60 * 1000;
const haceDias = (d: number) => new Date(Date.now() - d * UN_DIA);

function autorizacion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    estado: 'retenido',
    stripePaymentIntentId: 'pi_123',
    createdAt: haceDias(5.5),
    avisoCaducidadEnviadoAt: null,
    serviceRequest: { id: 'sr-1', clienteId: 'cli-1', profesionalId: 'prof-1' },
    ...overrides,
  };
}

describe('revisarAutorizacionesPorCaducar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.payment.update.mockResolvedValue({});
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('avisa a AMBAS partes cuando la autorización lleva más de 5 días', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion({ createdAt: haceDias(5.5) })]);

    const resumen = await revisarAutorizacionesPorCaducar();

    expect(mockNotificar).toHaveBeenCalledTimes(2);
    expect(mockNotificar).toHaveBeenCalledWith('cli-1', 'autorizacion_por_caducar', {}, { solicitudId: 'sr-1' });
    expect(mockNotificar).toHaveBeenCalledWith('prof-1', 'autorizacion_por_caducar', {}, { solicitudId: 'sr-1' });
    expect(resumen).toContain('1 avisada(s)');
  });

  it('marca el aviso para no repetirlo en cada pasada', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion()]);

    await revisarAutorizacionesPorCaducar();

    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pago-1' },
      data: { avisoCaducidadEnviadoAt: expect.any(Date) },
    });
  });

  it('no vuelve a avisar si ya se avisó antes', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      autorizacion({ avisoCaducidadEnviadoAt: haceDias(0.5) }),
    ]);

    const resumen = await revisarAutorizacionesPorCaducar();

    expect(mockNotificar).not.toHaveBeenCalled();
    expect(resumen).toContain('1 ya avisada(s) previamente');
  });

  /**
   * EL escenario de B5: el trabajo se alargó, Stripe canceló la
   * autorización a los ~7 días, y antes NADIE se enteraba — el webhook
   * marcaba la fila 'reembolsado' en silencio y el profesional descubría
   * que no cobraba al cerrar el trabajo.
   */
  it('detecta una autorización ya caducada en Stripe, la marca reembolsada y avisa a ambas partes', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion({ createdAt: haceDias(6.5) })]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    const resumen = await revisarAutorizacionesPorCaducar();

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pago-1', estado: 'retenido' },
      data: { estado: 'reembolsado' },
    });
    expect(mockNotificar).toHaveBeenCalledWith('cli-1', 'autorizacion_caducada', {}, { solicitudId: 'sr-1' });
    expect(mockNotificar).toHaveBeenCalledWith('prof-1', 'autorizacion_caducada', {}, { solicitudId: 'sr-1' });
    expect(resumen).toContain('1 caducada(s)');
  });

  // Carrera job <-> webhook: payment_intent.canceled ahora también marca
  // y notifica la caducidad. Si el webhook gana entre el findMany y el
  // updateMany de aquí, la fila ya no está 'retenido' — el job no debe
  // duplicar el aviso a ambas partes.
  it('no notifica si el webhook canceled ya marcó la fila entre la lectura y la escritura', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion({ createdAt: haceDias(6.5) })]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    const resumen = await revisarAutorizacionesPorCaducar();

    expect(mockNotificar).not.toHaveBeenCalled();
    expect(resumen).toContain('0 caducada(s)');
  });

  it('también trata requires_payment_method como caducada (la autorización se perdió igual)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion({ createdAt: haceDias(6.5) })]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });

    const resumen = await revisarAutorizacionesPorCaducar();

    expect(resumen).toContain('1 caducada(s)');
  });

  it('no toca una autorización de 6+ días que Stripe sigue dando por válida', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion({ createdAt: haceDias(6.5) })]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });

    const resumen = await revisarAutorizacionesPorCaducar();

    expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { estado: 'reembolsado' } })
    );
    // Sigue el flujo normal: se le manda el aviso preventivo.
    expect(resumen).toContain('1 avisada(s)');
  });

  it('no consulta Stripe para autorizaciones que aún no llegan al umbral de verificación', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([autorizacion({ createdAt: haceDias(5.2) })]);

    await revisarAutorizacionesPorCaducar();

    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('solo mira autorizaciones retenidas de trabajos vivos (una capturada ya no caduca)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([]);

    await revisarAutorizacionesPorCaducar();

    const { where } = mockPrisma.payment.findMany.mock.calls[0][0];
    expect(where.estado).toBe('retenido');
    expect(where.serviceRequest).toEqual({ estado: { in: ['aceptada', 'en_progreso'] } });
  });

  it('no se rompe si la solicitud todavía no tiene profesional asignado', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      autorizacion({ serviceRequest: { id: 'sr-1', clienteId: 'cli-1', profesionalId: null } }),
    ]);

    await expect(revisarAutorizacionesPorCaducar()).resolves.toContain('1 avisada(s)');
    expect(mockNotificar).toHaveBeenCalledTimes(1);
    expect(mockNotificar).toHaveBeenCalledWith('cli-1', 'autorizacion_por_caducar', {}, { solicitudId: 'sr-1' });
  });
});
