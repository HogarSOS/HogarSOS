import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    professional: { findUnique: jest.fn() },
    serviceRequest: { findUnique: jest.fn() },
    postulacion: { create: jest.fn() },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { createPostulacion } from '../postulacion.controller';

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

describe('createPostulacion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.professional.findUnique.mockResolvedValue({ estadoVerificacion: 'aprobado' });
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', estado: 'pendiente' });
  });

  it('crea la postulación y notifica al cliente', async () => {
    mockPrisma.postulacion.create.mockResolvedValue({ id: 'post-1', estado: 'pendiente' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Puedo ir mañana a las 10:00' }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      'nueva_postulacion',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('rechaza el mensaje si contiene un teléfono', async () => {
    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'llamame al 612345678' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.postulacion.create).not.toHaveBeenCalled();
  });

  it('rechaza el mensaje si contiene un email', async () => {
    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'escribeme a pepe@gmail.com' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.postulacion.create).not.toHaveBeenCalled();
  });

  it('devuelve 409 si ya se había postulado antes (constraint único)', async () => {
    mockPrisma.postulacion.create.mockRejectedValue({ code: 'P2002' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Disponible mañana' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 409 si la solicitud ya no está pendiente', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', estado: 'aceptada' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Disponible mañana' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.postulacion.create).not.toHaveBeenCalled();
  });

  it('devuelve 403 si el profesional no está verificado', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue({ estadoVerificacion: 'pendiente' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Disponible mañana' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
