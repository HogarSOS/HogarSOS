import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
    presupuesto: { findFirst: jest.fn() },
    ampliacion: { findFirst: jest.fn(), create: jest.fn() },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { crearAmpliacion } from '../ampliacion.controller';

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

describe('crearAmpliacion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    mockPrisma.presupuesto.findFirst.mockResolvedValue({
      id: 'pres-1',
      tipo: 'por_horas',
      profesionalId: 'pro-1',
      estado: 'aceptado',
    });
    mockPrisma.ampliacion.findFirst.mockResolvedValue(null);
  });

  it('crea la ampliación y notifica al cliente', async () => {
    mockPrisma.ampliacion.create.mockResolvedValue({ id: 'ampl-1', estado: 'pendiente' });

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2, mensaje: 'Se complicó más' }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPrisma.ampliacion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ presupuestoId: 'pres-1', horasAdicionales: 2 }) })
    );
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      'nueva_ampliacion',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('rechaza el mensaje si contiene un teléfono', async () => {
    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2, mensaje: 'llamame al 612345678' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.ampliacion.create).not.toHaveBeenCalled();
  });

  it('devuelve 403 si no es el profesional asignado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'otro-pro', estado: 'aceptada',
    });

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2 }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('devuelve 409 si no hay presupuesto aceptado', async () => {
    mockPrisma.presupuesto.findFirst.mockResolvedValue(null);

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('"cerrado": crea la ampliación con montoAdicional', async () => {
    mockPrisma.presupuesto.findFirst.mockResolvedValue({ id: 'pres-1', tipo: 'cerrado', estado: 'aceptado' });
    mockPrisma.ampliacion.create.mockResolvedValue({ id: 'ampl-2', estado: 'pendiente' });

    const res = fakeRes();
    await crearAmpliacion(
      fakeReq({ id: 'sr-1' }, 'pro-1', { montoAdicional: 40, mensaje: 'Hay que sustituir una válvula' }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPrisma.ampliacion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ presupuestoId: 'pres-1', montoAdicional: 40 }) })
    );
  });

  it('"cerrado": devuelve 400 si falta el montoAdicional', async () => {
    mockPrisma.presupuesto.findFirst.mockResolvedValue({ id: 'pres-1', tipo: 'cerrado', estado: 'aceptado' });

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.ampliacion.create).not.toHaveBeenCalled();
  });

  it('"por_horas": devuelve 400 si faltan las horasAdicionales', async () => {
    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.ampliacion.create).not.toHaveBeenCalled();
  });

  it('devuelve 409 si ya hay una ampliación pendiente', async () => {
    mockPrisma.ampliacion.findFirst.mockResolvedValue({ id: 'ampl-anterior', estado: 'pendiente' });

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.ampliacion.create).not.toHaveBeenCalled();
  });
});
