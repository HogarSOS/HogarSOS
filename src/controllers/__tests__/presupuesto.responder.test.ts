import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
    presupuesto: { findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { responderPresupuesto } from '../presupuesto.controller';

const mockPrisma = prisma as any;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string, body: Record<string, unknown>): Request {
  return { params, user: { userId }, body } as unknown as Request;
}

describe('responderPresupuesto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1' });
    mockPrisma.presupuesto.findUnique.mockResolvedValue({
      id: 'pres-1',
      serviceRequestId: 'sr-1',
      profesionalId: 'pro-1',
      estado: 'pendiente',
    });
    mockPrisma.presupuesto.updateMany.mockResolvedValue({ count: 1 });
  });

  it('acepta el presupuesto y notifica al profesional', async () => {
    const res = fakeRes();
    await responderPresupuesto(fakeReq({ id: 'sr-1', presupuestoId: 'pres-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(mockPrisma.presupuesto.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pres-1', estado: 'pendiente' },
        data: expect.objectContaining({ estado: 'aceptado' }),
      })
    );
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      'presupuesto_aceptado',
      expect.any(Object),
      expect.any(Object)
    );
    expect(res.json).toHaveBeenCalledWith({ id: 'pres-1', estado: 'aceptado' });
  });

  it('rechaza el presupuesto y notifica al profesional', async () => {
    const res = fakeRes();
    await responderPresupuesto(fakeReq({ id: 'sr-1', presupuestoId: 'pres-1' }, 'cliente-1', { accion: 'rechazar' }), res);

    expect(mockPrisma.presupuesto.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'rechazado' }) })
    );
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      'presupuesto_rechazado',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('devuelve 409 si ya no está pendiente (condición de carrera)', async () => {
    mockPrisma.presupuesto.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await responderPresupuesto(fakeReq({ id: 'sr-1', presupuestoId: 'pres-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 403 si quien responde no es el cliente dueño', async () => {
    const res = fakeRes();
    await responderPresupuesto(fakeReq({ id: 'sr-1', presupuestoId: 'pres-1' }, 'otro-usuario', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.presupuesto.updateMany).not.toHaveBeenCalled();
  });

  it('devuelve 404 si el presupuesto no pertenece a esta solicitud', async () => {
    mockPrisma.presupuesto.findUnique.mockResolvedValue({
      id: 'pres-1',
      serviceRequestId: 'otra-solicitud',
      profesionalId: 'pro-1',
      estado: 'pendiente',
    });

    const res = fakeRes();
    await responderPresupuesto(fakeReq({ id: 'sr-1', presupuestoId: 'pres-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('devuelve 400 si falta la acción', async () => {
    const res = fakeRes();
    await responderPresupuesto(fakeReq({ id: 'sr-1', presupuestoId: 'pres-1' }, 'cliente-1', {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
