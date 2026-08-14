import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    dispute: { findUnique: jest.fn(), update: jest.fn() },
    payment: { findMany: jest.fn() },
    serviceRequest: { update: jest.fn() },
  },
}));

const mockRefundPayment = jest.fn();
const mockReleasePayments = jest.fn();
jest.mock('../../services/payment.service', () => ({
  refundPayment: (...args: unknown[]) => mockRefundPayment(...args),
  releasePayments: (...args: unknown[]) => mockReleasePayments(...args),
  listarPagosAtascados: jest.fn(),
  reintentarLiberacion: jest.fn(),
}));

jest.mock('../serviceRequest.controller', () => ({
  agregarPagos: jest.fn(),
}));

jest.mock('../../jobs', () => ({
  TAREAS: [],
  ejecutarTareaAhora: jest.fn(),
}));

jest.mock('../../services/adminAction.service', () => ({
  registrarAccionAdmin: jest.fn(),
  listarAccionesAdmin: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { registrarAccionAdmin } from '../../services/adminAction.service';
import { resolveDispute } from '../admin.controller';

const mockPrisma = prisma as any;
const mockRegistrarAccionAdmin = registrarAccionAdmin as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(body: Record<string, unknown>, adminId: string): Request {
  return { params: { id: 'disputa-1' }, body, user: { userId: adminId } } as unknown as Request;
}

function disputaBase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'disputa-1',
    serviceRequestId: 'sr-1',
    estado: 'abierta',
    ...overrides,
  };
}

describe('resolveDispute', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a favor del cliente: reembolsa y cancela la solicitud, nunca libera pagos', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockRefundPayment.mockResolvedValue(undefined);
    mockPrisma.serviceRequest.update.mockResolvedValue({});
    mockPrisma.dispute.update.mockResolvedValue(disputaBase({ estado: 'resuelta_cliente' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Trabajo no realizado' }, 'admin-1'), res);

    expect(mockRefundPayment).toHaveBeenCalledWith('sr-1');
    expect(mockReleasePayments).not.toHaveBeenCalled();
    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: { estado: 'cancelada' },
    });
    expect(mockPrisma.dispute.update).toHaveBeenCalledWith({
      where: { id: 'disputa-1' },
      data: expect.objectContaining({ estado: 'resuelta_cliente', resueltoPor: 'admin-1', resolucionNotas: 'Trabajo no realizado' }),
    });
    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'resolver_disputa', estadoAnterior: 'abierta', estadoNuevo: 'resuelta_cliente' })
    );
  });

  it('a favor del profesional: libera la suma de retenido+capturado (usando capturadoBase cuando existe), nunca reembolsa', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockPrisma.payment.findMany.mockResolvedValue([
      { estado: 'retenido', montoBase: 100, capturadoBase: null },
      { estado: 'capturado', montoBase: 50, capturadoBase: 45 }, // escalado proporcional ya congelado
    ]);
    mockReleasePayments.mockResolvedValue(undefined);
    mockPrisma.serviceRequest.update.mockResolvedValue({});
    mockPrisma.dispute.update.mockResolvedValue(disputaBase({ estado: 'resuelta_profesional' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_profesional', notas: 'Trabajo verificado' }, 'admin-1'), res);

    expect(mockPrisma.payment.findMany).toHaveBeenCalledWith({
      where: { serviceRequestId: 'sr-1', estado: { in: ['retenido', 'capturado'] } },
    });
    // 100 (retenido, sin capturadoBase -> usa montoBase) + 45 (capturado, usa capturadoBase)
    expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 145);
    expect(mockRefundPayment).not.toHaveBeenCalled();
    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: { estado: 'completada' },
    });
  });

  it('devuelve 502 y NO marca la disputa como resuelta si Stripe falla', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockRefundPayment.mockRejectedValue(new Error('insufficient balance in Connect account'));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Reembolso' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DISPUTE_RESOLUTION_STRIPE_FAILED' })
    );
    expect(mockPrisma.dispute.update).not.toHaveBeenCalled();
    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
  });

  it('devuelve 409 si la disputa ya estaba resuelta, sin volver a mover dinero', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase({ estado: 'resuelta_profesional' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Intento repetido' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISPUTE_ALREADY_RESOLVED' }));
    expect(mockRefundPayment).not.toHaveBeenCalled();
    expect(mockReleasePayments).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la disputa no existe', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'No existe' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISPUTE_NOT_FOUND' }));
  });

  it('rechaza datos inválidos (notas demasiado cortas) con 400, sin tocar BD ni Stripe', async () => {
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'a' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.dispute.findUnique).not.toHaveBeenCalled();
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });
});
