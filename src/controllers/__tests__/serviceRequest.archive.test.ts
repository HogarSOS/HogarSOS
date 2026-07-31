import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { archiveServiceRequest } from '../serviceRequest.controller';

const mockPrisma = prisma as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string): Request {
  return { params, user: { userId } } as unknown as Request;
}

describe('archiveServiceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marca archivadoCliente cuando quien archiva es el cliente', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });

    const res = fakeRes();
    await archiveServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: { archivadoCliente: true },
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('marca archivadoProfesional cuando quien archiva es el profesional asignado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });

    const res = fakeRes();
    await archiveServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: { archivadoProfesional: true },
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('no toca el archivado del cliente al archivar el profesional (independientes)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });

    await archiveServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), fakeRes());

    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { archivadoProfesional: true } })
    );
  });

  it('devuelve 409 si la solicitud sigue activa (no completada ni cancelada)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'en_progreso',
    });

    const res = fakeRes();
    await archiveServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('devuelve 403 si quien archiva no es ni el cliente ni el profesional de la solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });

    const res = fakeRes();
    await archiveServiceRequest(fakeReq({ id: 'sr-1' }, 'otro-usuario'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await archiveServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
