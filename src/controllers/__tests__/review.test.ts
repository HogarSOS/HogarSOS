import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
    review: { findUnique: jest.fn() },
    dispute: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { prisma } from '../../config/prisma';
import { createReview } from '../review.controller';

const mockPrisma = prisma as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string, body: Record<string, unknown>): Request {
  return { user: { userId }, body } as unknown as Request;
}

const SR_ID = '11111111-1111-1111-1111-111111111111';
const bodyValido = { serviceRequestId: SR_ID, puntuacion: 5, comentario: 'Genial' };

describe('createReview — bloqueo por reclamación abierta', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('devuelve 409 si hay una reclamación abierta para la solicitud, aunque esté "completada"', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });
    mockPrisma.dispute.findFirst.mockResolvedValue({ id: 'dispute-1', estado: 'abierta' });

    const res = fakeRes();
    await createReview(fakeReq('cliente-1', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('permite valorar si no hay ninguna reclamación abierta', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });
    mockPrisma.dispute.findFirst.mockResolvedValue(null);
    mockPrisma.review.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockResolvedValue({ id: 'review-1' });

    const res = fakeRes();
    await createReview(fakeReq('cliente-1', bodyValido), res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
