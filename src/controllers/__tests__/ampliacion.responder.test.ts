import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
    ampliacion: { findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { responderAmpliacion } from '../ampliacion.controller';

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

describe('responderAmpliacion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1' });
    mockPrisma.ampliacion.findUnique.mockResolvedValue({
      id: 'ampl-1',
      estado: 'pendiente',
      presupuesto: { serviceRequestId: 'sr-1', profesionalId: 'pro-1' },
    });
    mockPrisma.ampliacion.updateMany.mockResolvedValue({ count: 1 });
  });

  it('acepta la ampliación y notifica al profesional', async () => {
    const res = fakeRes();
    await responderAmpliacion(fakeReq({ id: 'sr-1', ampliacionId: 'ampl-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(mockPrisma.ampliacion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ampl-1', estado: 'pendiente' }, data: expect.objectContaining({ estado: 'aceptado' }) })
    );
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      expect.any(Object),
      expect.objectContaining({ tipo: 'ampliacion_aceptada' })
    );
  });

  it('rechaza la ampliación y notifica al profesional', async () => {
    const res = fakeRes();
    await responderAmpliacion(fakeReq({ id: 'sr-1', ampliacionId: 'ampl-1' }, 'cliente-1', { accion: 'rechazar' }), res);

    expect(mockPrisma.ampliacion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'rechazado' }) })
    );
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      expect.any(Object),
      expect.objectContaining({ tipo: 'ampliacion_rechazada' })
    );
  });

  it('devuelve 409 si ya no está pendiente (condición de carrera)', async () => {
    mockPrisma.ampliacion.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await responderAmpliacion(fakeReq({ id: 'sr-1', ampliacionId: 'ampl-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 403 si quien responde no es el cliente dueño', async () => {
    const res = fakeRes();
    await responderAmpliacion(fakeReq({ id: 'sr-1', ampliacionId: 'ampl-1' }, 'otro-usuario', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.ampliacion.updateMany).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la ampliación no pertenece a esta solicitud', async () => {
    mockPrisma.ampliacion.findUnique.mockResolvedValue({
      id: 'ampl-1',
      estado: 'pendiente',
      presupuesto: { serviceRequestId: 'otra-solicitud', profesionalId: 'pro-1' },
    });

    const res = fakeRes();
    await responderAmpliacion(fakeReq({ id: 'sr-1', ampliacionId: 'ampl-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
