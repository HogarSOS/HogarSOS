import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn(), update: jest.fn() },
    dispute: { create: jest.fn(), findFirst: jest.fn() },
    review: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn({
      dispute: { create: jest.fn().mockResolvedValue({ id: 'dispute-1', motivoCategoria: 'problema_pago', motivo: 'no llegó', estado: 'abierta', createdAt: new Date() }) },
      serviceRequest: { update: jest.fn() },
    })),
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
  enviarNotificacionMasiva: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { createDispute } from '../dispute.controller';

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

const bodyValido = {
  motivo: 'problema_pago',
  descripcion: 'El profesional no completó el trabajo pero cobró igual',
};

describe('createDispute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('crea la reclamación y pone la solicitud en "disputada"', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });

    const res = fakeRes();
    await createDispute(fakeReq({ id: 'sr-1' }, 'cliente-1', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      'reclamacion_abierta',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('devuelve 403 si el usuario no participó en la solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });

    const res = fakeRes();
    await createDispute(fakeReq({ id: 'sr-1' }, 'otro-usuario', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('devuelve 409 si la solicitud todavía está pendiente (nunca fue aceptada)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });

    const res = fakeRes();
    await createDispute(fakeReq({ id: 'sr-1' }, 'cliente-1', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  /**
   * Solo puede haber una reclamación abierta a la vez por trabajo — el
   * propio estado 'disputada' es la guarda: si ya está ahí, no se
   * puede volver a abrir otra.
   */
  it('devuelve 409 si ya existe una reclamación abierta para esta solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'disputada',
    });

    const res = fakeRes();
    await createDispute(fakeReq({ id: 'sr-1' }, 'cliente-1', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  // M2 (auditoría Fable 2026-08-15): el check de arriba (findUnique +
  // estado) es solo fast-path — dos peticiones casi simultáneas pueden
  // pasarlo ambas antes de que la primera cree la Dispute. Este test
  // simula justo esa carrera: el check pasa, pero el create choca con el
  // índice único parcial `disputes_abierta_unico`.
  it('devuelve el mismo 409 que el fast-path si el create choca con el índice único (P2002 — carrera con otra petición)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });
    mockPrisma.$transaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });

    const res = fakeRes();
    await createDispute(fakeReq({ id: 'sr-1' }, 'cliente-1', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISPUTE_ALREADY_OPEN' }));
  });

  it('un error de Prisma que NO es P2002 no se convierte en 409 — se deja propagar tal cual', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });
    const errorInesperado = { code: 'P2028', message: 'Transaction API error' };
    mockPrisma.$transaction.mockImplementationOnce(async () => {
      throw errorInesperado;
    });

    await expect(createDispute(fakeReq({ id: 'sr-1' }, 'cliente-1', bodyValido), fakeRes())).rejects.toBe(
      errorInesperado
    );
  });
});
