import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
  },
}));

jest.mock('../../services/payment.service', () => ({
  createEscrowPaymentIntent: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { createEscrowPaymentIntent } from '../../services/payment.service';
import { createPaymentIntent } from '../payment.controller';

const mockPrisma = prisma as any;
const mockCreateEscrow = createEscrowPaymentIntent as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string, body: Record<string, unknown>): Request {
  return { params: {}, user: { userId }, body } as unknown as Request;
}

const SR_ID = '11111111-1111-1111-1111-111111111111';

describe('createPaymentIntent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateEscrow.mockResolvedValue({
      pago: { id: 'pago-1', montoTotal: 100, comisionPlataforma: 10 },
      clientSecret: 'secret_123',
    });
  });

  it('usa el monto del presupuesto cerrado aceptado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      estado: 'aceptada',
      payment: null,
      presupuestos: [{ tipo: 'cerrado', monto: 180 }],
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockCreateEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ serviceRequestId: SR_ID, montoTotal: 180 })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('usa tarifaHora * horasEstimadas para un presupuesto por horas aceptado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      estado: 'aceptada',
      payment: null,
      presupuestos: [{ tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(mockCreateEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ montoTotal: 100 })
    );
  });

  it('devuelve 409 si no hay ningún presupuesto aceptado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      estado: 'aceptada',
      payment: null,
      presupuestos: [],
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('devuelve 403 si no es el cliente de la solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'otro-cliente',
      estado: 'aceptada',
      payment: null,
      presupuestos: [{ tipo: 'cerrado', monto: 100 }],
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('devuelve 409 si la solicitud no está aceptada', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      estado: 'pendiente',
      payment: null,
      presupuestos: [{ tipo: 'cerrado', monto: 100 }],
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 409 si ya existe un pago', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: SR_ID,
      clienteId: 'cliente-1',
      estado: 'aceptada',
      payment: { id: 'pago-existente' },
      presupuestos: [{ tipo: 'cerrado', monto: 100 }],
    });

    const res = fakeRes();
    await createPaymentIntent(fakeReq('cliente-1', { serviceRequestId: SR_ID }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});
