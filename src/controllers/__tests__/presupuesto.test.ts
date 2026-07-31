import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
    presupuesto: { findFirst: jest.fn(), create: jest.fn() },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { createPresupuesto } from '../presupuesto.controller';

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

describe('createPresupuesto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'pro-1', estado: 'aceptada' });
    mockPrisma.presupuesto.findFirst.mockResolvedValue(null);
  });

  it('crea un presupuesto cerrado y notifica al cliente', async () => {
    mockPrisma.presupuesto.create.mockResolvedValue({ id: 'pres-1', tipo: 'cerrado', estado: 'pendiente' });

    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 180 }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPrisma.presupuesto.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tipo: 'cerrado', monto: 180 }) })
    );
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      expect.any(Object),
      expect.objectContaining({ tipo: 'nuevo_presupuesto' })
    );
  });

  it('crea un presupuesto por horas', async () => {
    mockPrisma.presupuesto.create.mockResolvedValue({ id: 'pres-2', tipo: 'por_horas', estado: 'pendiente' });

    const res = fakeRes();
    await createPresupuesto(
      fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPrisma.presupuesto.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }) })
    );
  });

  it('devuelve 400 si falta tarifaHora en un presupuesto por horas', async () => {
    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'por_horas', horasEstimadas: 4 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.presupuesto.create).not.toHaveBeenCalled();
  });

  it('rechaza el mensaje si contiene un teléfono', async () => {
    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 100, mensaje: 'llamame al 612345678' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.presupuesto.create).not.toHaveBeenCalled();
  });

  it('devuelve 403 si no es el profesional asignado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'otro-pro', estado: 'aceptada' });

    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 100 }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('devuelve 409 si la solicitud no está aceptada', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'pro-1', estado: 'pendiente' });

    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 100 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 409 si ya hay un presupuesto pendiente', async () => {
    mockPrisma.presupuesto.findFirst.mockResolvedValue({ id: 'pres-anterior', estado: 'pendiente' });

    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 100 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.presupuesto.create).not.toHaveBeenCalled();
  });

  it('devuelve 400 si el monto no es positivo', async () => {
    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: -5 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
