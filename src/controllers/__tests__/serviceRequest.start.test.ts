import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

// Mockeado explícitamente (no solo "no importado") para que estos tests
// protejan de verdad la garantía "esta operación no mueve ni un
// céntimo" — si algún día alguien añade por error una llamada a Stripe
// aquí, las aserciones `not.toHaveBeenCalled()` de abajo lo detectan.
jest.mock('../../services/payment.service', () => ({
  refundPayment: jest.fn(),
  releasePayments: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { refundPayment, releasePayments } from '../../services/payment.service';
import { startServiceRequest, undoStartServiceRequest } from '../serviceRequest.controller';

const mockPrisma = prisma as any;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;
const mockRefundPayment = refundPayment as jest.Mock;
const mockReleasePayments = releasePayments as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string): Request {
  return { params, user: { userId } } as unknown as Request;
}

/** Las mismas tres aserciones se repiten en casi todos los tests de este archivo — es justo la garantía que pide la auditoría. */
function expectNingunaOperacionStripe() {
  expect(mockRefundPayment).not.toHaveBeenCalled();
  expect(mockReleasePayments).not.toHaveBeenCalled();
}

describe('startServiceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pasa de "aceptada" a "en_progreso" y avisa al cliente, sin tocar Stripe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = fakeRes();
    await startServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    // La transición es UNA sola sentencia atómica: el WHERE lleva la
    // condición de estado y el UPDATE el nuevo estado + iniciadoAt en
    // la misma llamada — no hay una lectura + escritura separadas que
    // pudieran perder una carrera.
    expect(mockPrisma.serviceRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'sr-1', profesionalId: 'pro-1', estado: 'aceptada' },
      data: { estado: 'en_progreso', iniciadoAt: expect.any(Date) },
    });
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      'trabajo_en_curso',
      expect.any(Object),
      expect.any(Object)
    );
    expect(res.json).toHaveBeenCalledWith({ id: 'sr-1', estado: 'en_progreso' });
    expectNingunaOperacionStripe();
  });

  it('devuelve 403 si quien lo pulsa no es el profesional asignado, sin tocar Stripe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });

    const res = fakeRes();
    await startServiceRequest(fakeReq({ id: 'sr-1' }, 'otro-profesional'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.serviceRequest.updateMany).not.toHaveBeenCalled();
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
    expectNingunaOperacionStripe();
  });

  it('devuelve 409 si la solicitud ya no está "aceptada" (por ejemplo, completada), sin tocar Stripe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await startServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_INVALID_STATE_START' }));
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
    expectNingunaOperacionStripe();
  });

  it('devuelve 409 si otra petición ganó la carrera justo antes (cancelar/completar), sin tocar Stripe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    // El propio UPDATE atómico es la fuente de verdad — aquí simula que
    // otra petición (cancelar, completar) ganó la carrera justo antes,
    // aunque la lectura previa todavía viera "aceptada".
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await startServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
    expectNingunaOperacionStripe();
  });

  it('devuelve 404 si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await startServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expectNingunaOperacionStripe();
  });
});

describe('undoStartServiceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pasa de "en_progreso" a "aceptada", pone iniciadoAt a null, sin notificar ni tocar Stripe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'en_progreso',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = fakeRes();
    await undoStartServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(mockPrisma.serviceRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'sr-1', profesionalId: 'pro-1', estado: 'en_progreso' },
      data: { estado: 'aceptada', iniciadoAt: null },
    });
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ id: 'sr-1', estado: 'aceptada' });
    expectNingunaOperacionStripe();
  });

  it('devuelve 403 si quien lo pulsa no es el profesional asignado, sin tocar Stripe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'en_progreso',
    });

    const res = fakeRes();
    await undoStartServiceRequest(fakeReq({ id: 'sr-1' }, 'otro-profesional'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.serviceRequest.updateMany).not.toHaveBeenCalled();
    expectNingunaOperacionStripe();
  });

  it('devuelve 409 si la solicitud no está "en_progreso" (completada, cancelada o disputada), sin tocar Stripe', async () => {
    for (const estado of ['completada', 'cancelada', 'disputada', 'aceptada', 'pendiente']) {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        id: 'sr-1',
        clienteId: 'cliente-1',
        profesionalId: 'pro-1',
        estado,
      });
      mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

      const res = fakeRes();
      await undoStartServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_NOT_IN_PROGRESS' }));
    }
    expectNingunaOperacionStripe();
  });

  it('devuelve 404 si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await undoStartServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expectNingunaOperacionStripe();
  });
});
