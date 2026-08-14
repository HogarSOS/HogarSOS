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
      'nuevo_presupuesto',
      expect.any(Object),
      expect.any(Object)
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

  // P2 #3 (auditoría 2026-08-14): el findFirst de arriba es solo
  // fast-path — dos peticiones casi simultáneas pueden pasarlo ambas
  // antes de que la primera haga el create. La garantía real es el
  // índice único parcial `presupuestos_pendiente_unico`; en ese caso
  // Postgres/Prisma rechaza el segundo create con P2002.
  it('si el create choca con el índice único (P2002 — carrera con otra petición), devuelve el mismo 409 que el fast-path', async () => {
    mockPrisma.presupuesto.create.mockRejectedValue({ code: 'P2002' });

    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 100 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BUDGET_ALREADY_PENDING' }));
  });

  it('un error de Prisma que NO es P2002 no se convierte en 409 — se deja propagar tal cual', async () => {
    const errorInesperado = { code: 'P2028', message: 'Transaction API error' };
    mockPrisma.presupuesto.create.mockRejectedValue(errorInesperado);

    const res = fakeRes();
    await expect(
      createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 100 }), res)
    ).rejects.toBe(errorInesperado);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(res.json).not.toHaveBeenCalled();
  });

  // Tras resolver un presupuesto anterior (aceptado o rechazado), el
  // índice parcial (WHERE estado='pendiente') no debe estorbar: el
  // profesional puede volver a enviar un presupuesto nuevo.
  it('puede crear un nuevo presupuesto pendiente después de que el anterior quedó rechazado', async () => {
    // El presupuesto anterior ya no está 'pendiente' — el findFirst
    // (que solo busca estado: 'pendiente') no lo ve, igual que no lo
    // vería el índice único parcial.
    mockPrisma.presupuesto.create.mockResolvedValue({ id: 'pres-2', tipo: 'cerrado', estado: 'pendiente' });

    const res = fakeRes();
    await createPresupuesto(fakeReq({ id: 'sr-1' }, 'pro-1', { tipo: 'cerrado', monto: 150 }), res);

    expect(mockPrisma.presupuesto.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ monto: 150 }) })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
