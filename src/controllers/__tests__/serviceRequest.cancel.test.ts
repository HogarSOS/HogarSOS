import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    professional: { findUnique: jest.fn() },
    // acceptServiceRequest sincroniza el chat a Firestore internamente
    // (sincronizarChatFirestore), que necesita los firebaseUid de
    // ambas partes — sin este mock, esa llamada interna revienta antes
    // de llegar a lo que de verdad se está probando.
    user: { findUnique: jest.fn().mockResolvedValue({ firebaseUid: 'uid-fake' }) },
  },
}));

jest.mock('../../config/firebase', () => ({
  firestore: { collection: jest.fn(() => ({ doc: jest.fn(() => ({ set: jest.fn() })) })) },
}));

jest.mock('../../services/payment.service', () => ({
  refundPayment: jest.fn(),
  releasePayments: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
  enviarNotificacionMasiva: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { refundPayment } from '../../services/payment.service';
import { enviarNotificacion } from '../../services/notification.service';
import { cancelServiceRequest } from '../serviceRequest.controller';

const mockPrisma = prisma as any;
const mockRefundPayment = refundPayment as jest.Mock;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string): Request {
  return { params, user: { userId } } as unknown as Request;
}

describe('cancelServiceRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Antes solo se podía cancelar mientras la solicitud seguía
   * "pendiente" — este test fija el comportamiento nuevo (también
   * "aceptada"), pedido explícitamente porque el profesional puede
   * aceptar y proponer una disponibilidad por chat que al cliente no le
   * sirva. Si alguien revierte el `where` a solo 'pendiente', este test
   * lo detecta.
   */
  it('permite cancelar una solicitud ya "aceptada", no solo "pendiente"', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });
    mockRefundPayment.mockResolvedValue(undefined);

    const req = fakeReq({ id: 'sr-1' }, 'cliente-1');
    const res = fakeRes();
    await cancelServiceRequest(req, res);

    expect(mockPrisma.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'sr-1', clienteId: 'cliente-1', estado: { in: ['pendiente', 'aceptada'] } },
      data: { estado: 'cancelada' },
    });
    expect(res.json).toHaveBeenCalledWith({ id: 'sr-1', estado: 'cancelada' });
  });

  it('reembolsa el pago automáticamente si ya había uno autorizado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });
    mockRefundPayment.mockResolvedValue(undefined);

    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), fakeRes());

    expect(mockRefundPayment).toHaveBeenCalledWith('sr-1');
  });

  it('no falla la cancelación si no había ningún pago que reembolsar (cancelada en pendiente)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });
    mockRefundPayment.mockRejectedValue(new Error('PAGO_NO_ENCONTRADO'));

    const res = fakeRes();
    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ id: 'sr-1', estado: 'cancelada' });
  });

  /**
   * P2 (auditoría 2026-08-14): refundPayment ahora comparte el lease con
   * releasePayments — si una liberación está en curso sobre la misma
   * solicitud (p. ej. el profesional completando el trabajo justo cuando
   * el cliente cancela), refundPayment lanza LIBERACION_YA_EN_CURSO en
   * vez de arriesgarse a tocar Stripe a la vez que la liberación.
   * cancelServiceRequest lo tolera igual que cualquier otro fallo de
   * refundPayment: la solicitud ya quedó cancelada (el UPDATE atómico de
   * ServiceRequest.estado ya se ejecutó antes), y el fallo del reembolso
   * solo se registra en logs.
   *
   * GAP RESIDUAL, documentado a propósito y NO resuelto aquí: no existe
   * ningún job que reintente automáticamente un reembolso que perdió
   * esta carrera — a diferencia de las liberaciones (reintentarPagosAtascados.job.ts),
   * no hay equivalente para refunds. Si esto ocurre en producción, el
   * dinero queda retenido en Stripe con la solicitud ya "cancelada" en
   * BD, sin reintento automático. Ver informe de la auditoría P2 #1.
   */
  it('tolera que refundPayment falle por lease ocupado (liberación en curso) — la cancelación sigue devolviendo éxito', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });
    mockRefundPayment.mockRejectedValue(new Error('LIBERACION_YA_EN_CURSO'));

    const res = fakeRes();
    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ id: 'sr-1', estado: 'cancelada' });
  });

  it('avisa al profesional asignado de que su trabajo fue cancelado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 1 });
    mockRefundPayment.mockResolvedValue(undefined);

    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), fakeRes());

    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      'solicitud_cancelada',
      expect.any(Object),
      expect.any(Object)
    );
  });

  /**
   * "en_progreso" tiene su propio código de error (distinto del genérico
   * de más abajo) porque aquí sí hay una vía real para el cliente — abrir
   * una reclamación — que completada/cancelada no tienen. Si alguien
   * fusiona esta rama con la genérica, este test lo detecta.
   */
  it('devuelve 409 con código específico si el trabajo ya está "en curso" (debe usar disputa)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'en_progreso',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REQUEST_IN_PROGRESS_USE_DISPUTE' })
    );
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it('devuelve 409 genérico si ya está completada o cancelada (sin vía de disputa)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'completada',
    });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_CANNOT_CANCEL' }));
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  /**
   * Reproduce la carrera real: la primera lectura (antes del UPDATE
   * atómico) todavía ve "aceptada" — el profesional pulsó "Iniciar
   * trabajo" justo después — así que el UPDATE de cancelar falla
   * (count: 0) por el motivo correcto, pero una foto vieja diría
   * "aceptada", no "en_progreso". Si el código volviera a fiarse de esa
   * foto vieja en vez de releer, este test detecta el mensaje
   * incorrecto (REQUEST_CANNOT_CANCEL en vez de
   * REQUEST_IN_PROGRESS_USE_DISPUTE) aunque la cancelación en sí ya se
   * bloqueó bien en los dos casos.
   */
  it('da el mensaje correcto aunque el estado haya cambiado a en_progreso justo entre la primera lectura y el UPDATE fallido', async () => {
    mockPrisma.serviceRequest.findUnique
      .mockResolvedValueOnce({ id: 'sr-1', clienteId: 'cliente-1', profesionalId: 'pro-1', estado: 'aceptada' })
      .mockResolvedValueOnce({ estado: 'en_progreso' });
    mockPrisma.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.serviceRequest.findUnique).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REQUEST_IN_PROGRESS_USE_DISPUTE' })
    );
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it('devuelve 403 si quien cancela no es el cliente que creó la solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });

    const res = fakeRes();
    await cancelServiceRequest(fakeReq({ id: 'sr-1' }, 'otro-usuario'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.serviceRequest.updateMany).not.toHaveBeenCalled();
  });
});

// La protección contra condición de carrera al asignar un profesional
// vive ahora en selectPostulacion (postulacion.controller.ts) — ver
// postulacion.select.test.ts. acceptServiceRequest ("el primero que
// acepta gana") se retiró junto con el resto de ese flujo.
