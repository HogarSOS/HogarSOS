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

  // P2 #3 (auditoría 2026-08-14): el findFirst de arriba es solo
  // fast-path — la garantía real es el índice único parcial
  // `ampliaciones_pendiente_unico` (sobre presupuesto_id). En una
  // carrera, Postgres/Prisma rechaza el segundo create con P2002.
  it('si el create choca con el índice único (P2002 — carrera con otra petición), devuelve el mismo 409 que el fast-path', async () => {
    mockPrisma.ampliacion.create.mockRejectedValue({ code: 'P2002' });

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EXTENSION_ALREADY_PENDING' }));
  });

  it('un error de Prisma que NO es P2002 no se convierte en 409 — se deja propagar tal cual', async () => {
    const errorInesperado = { code: 'P2028', message: 'Transaction API error' };
    mockPrisma.ampliacion.create.mockRejectedValue(errorInesperado);

    const res = fakeRes();
    await expect(
      crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 2 }), res)
    ).rejects.toBe(errorInesperado);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(res.json).not.toHaveBeenCalled();
  });

  // Tras resolver una ampliación anterior (aceptada o rechazada), el
  // índice parcial (WHERE estado='pendiente') no debe estorbar: el
  // profesional puede volver a pedir una ampliación nueva sobre el
  // mismo presupuesto.
  it('puede crear una nueva ampliación pendiente después de que la anterior dejó de estar pendiente', async () => {
    // La ampliación anterior ya no está 'pendiente' — el findFirst
    // (que solo busca estado: 'pendiente') no lo ve, igual que no lo
    // vería el índice único parcial.
    mockPrisma.ampliacion.create.mockResolvedValue({ id: 'ampl-3', estado: 'pendiente' });

    const res = fakeRes();
    await crearAmpliacion(fakeReq({ id: 'sr-1' }, 'pro-1', { horasAdicionales: 3 }), res);

    expect(mockPrisma.ampliacion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ presupuestoId: 'pres-1', horasAdicionales: 3 }) })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
