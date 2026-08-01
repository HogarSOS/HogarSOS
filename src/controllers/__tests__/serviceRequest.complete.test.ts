import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn(), update: jest.fn() },
    payment: { findFirst: jest.fn(), findMany: jest.fn() },
    cierreHoras: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));

jest.mock('../../services/payment.service', () => ({
  releasePayments: jest.fn(),
  refundPayment: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
  enviarNotificacionMasiva: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { releasePayments } from '../../services/payment.service';
import { enviarNotificacion } from '../../services/notification.service';
import { completeServiceRequest, responderCierreHoras } from '../serviceRequest.controller';

const mockPrisma = prisma as any;
const mockReleasePayments = releasePayments as jest.Mock;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string, body: Record<string, unknown> = {}): Request {
  return { params, user: { userId }, body } as unknown as Request;
}

describe('completeServiceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 'pago-1', estado: 'retenido' });
    mockReleasePayments.mockResolvedValue([{ estado: 'liberado' }]);
  });

  it('"cerrado": completa y libera el pago con el monto del presupuesto, sin pedir horas', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'cerrado', monto: 180, ampliaciones: [] }],
    });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'completada', precioFinal: 180 }) })
    );
    expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 180);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ estado: 'completada' }));
  });

  it('"cerrado": suma al importe final las ampliaciones (montoAdicional) aceptadas, en vez de ignorarlas', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{
        id: 'pres-1',
        tipo: 'cerrado',
        monto: 200,
        ampliaciones: [{ id: 'ampl-1', montoAdicional: 50, estado: 'aceptado' }],
      }],
    });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'completada', precioFinal: 250 }) })
    );
    expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 250);
  });

  it('"por_horas": crea un CierreHoras pendiente y NO completa ni libera el pago todavía', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });
    mockPrisma.cierreHoras.findFirst.mockResolvedValue(null);
    mockPrisma.cierreHoras.create.mockResolvedValue({ id: 'cierre-1', horasReales: 3.5 });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 3.5 }), res);

    expect(mockPrisma.cierreHoras.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ serviceRequestId: 'sr-1', horasReales: 3.5 }) })
    );
    expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
    expect(mockReleasePayments).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      expect.any(Object),
      expect.objectContaining({ tipo: 'cierre_horas_pendiente' })
    );
  });

  it('"por_horas": devuelve 400 si no se indican las horas reales', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.cierreHoras.create).not.toHaveBeenCalled();
  });

  it('"por_horas": devuelve 409 si ya hay un cierre pendiente de confirmación', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });
    mockPrisma.cierreHoras.findFirst.mockResolvedValue({ id: 'cierre-anterior', estado: 'pendiente' });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 3.5 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.cierreHoras.create).not.toHaveBeenCalled();
  });

  it('devuelve 409 si el cliente aún no ha autorizado ningún pago', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'pro-1', estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'cerrado', monto: 180, ampliaciones: [] }],
    });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 403 si no es el profesional asignado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'otro-pro', estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'cerrado', monto: 180, ampliaciones: [] }],
    });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('responderCierreHoras', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });
    mockPrisma.cierreHoras.findUnique.mockResolvedValue({
      id: 'cierre-1', serviceRequestId: 'sr-1', horasReales: 3.5, estado: 'pendiente',
    });
    mockPrisma.cierreHoras.updateMany.mockResolvedValue({ count: 1 });
    mockReleasePayments.mockResolvedValue([{ estado: 'liberado' }]);
  });

  it('al aceptar: completa la solicitud, libera tarifaHora × horasReales y notifica al profesional', async () => {
    const res = fakeRes();
    await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'completada', precioFinal: 87.5 }) })
    );
    expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 87.5);
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      expect.any(Object),
      expect.objectContaining({ tipo: 'cierre_horas_aceptado' })
    );
  });

  it('al rechazar: NO completa la solicitud ni libera el pago, solo notifica', async () => {
    const res = fakeRes();
    await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'rechazar' }), res);

    expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
    expect(mockReleasePayments).not.toHaveBeenCalled();
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      expect.any(Object),
      expect.objectContaining({ tipo: 'cierre_horas_rechazado' })
    );
  });

  it('devuelve 409 si el cierre ya no está pendiente (condición de carrera)', async () => {
    mockPrisma.cierreHoras.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('devuelve 403 si quien responde no es el cliente dueño', async () => {
    const res = fakeRes();
    await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'otro-usuario', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.cierreHoras.updateMany).not.toHaveBeenCalled();
  });

  it('devuelve 404 si el cierre no pertenece a esta solicitud', async () => {
    mockPrisma.cierreHoras.findUnique.mockResolvedValue({
      id: 'cierre-1', serviceRequestId: 'otra-solicitud', horasReales: 3.5, estado: 'pendiente',
    });

    const res = fakeRes();
    await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
