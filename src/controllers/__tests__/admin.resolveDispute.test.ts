import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    dispute: { findUnique: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    payment: { findMany: jest.fn() },
    serviceRequest: { update: jest.fn() },
  },
}));

const mockRefundPayment = jest.fn();
const mockReleasePayments = jest.fn();
jest.mock('../../services/payment.service', () => ({
  refundPayment: (...args: unknown[]) => mockRefundPayment(...args),
  releasePayments: (...args: unknown[]) => mockReleasePayments(...args),
  listarPagosAtascados: jest.fn(),
  reintentarLiberacion: jest.fn(),
  LEASE_LIBERACION_MS: 5 * 60 * 1000,
}));

jest.mock('../serviceRequest.controller', () => ({
  agregarPagos: jest.fn(),
}));

jest.mock('../../jobs', () => ({
  TAREAS: [],
  ejecutarTareaAhora: jest.fn(),
}));

jest.mock('../../services/adminAction.service', () => ({
  registrarAccionAdmin: jest.fn(),
  listarAccionesAdmin: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { registrarAccionAdmin } from '../../services/adminAction.service';
import { resolveDispute } from '../admin.controller';

const mockPrisma = prisma as any;
const mockRegistrarAccionAdmin = registrarAccionAdmin as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(body: Record<string, unknown>, adminId: string): Request {
  return { params: { id: 'disputa-1' }, body, user: { userId: adminId } } as unknown as Request;
}

function disputaBase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'disputa-1',
    serviceRequestId: 'sr-1',
    estado: 'abierta',
    resueltoPor: null,
    resolucionNotas: null,
    resueltaAt: null,
    reclamadaAt: null,
    ...overrides,
  };
}

describe('resolveDispute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Claim atómico de la disputa (P2, auditoría 2026-08-14, revisión de
    // concurrencia crítica): concedido por defecto (count > 0) tanto
    // para el claim inicial como para la finalización. Los tests de
    // carrera lo sobreescriben con mockResolvedValueOnce para simular
    // que otra ejecución ya lo tiene.
    mockPrisma.dispute.updateMany.mockResolvedValue({ count: 1 });
  });

  it('a favor del cliente: reembolsa y cancela la solicitud, nunca libera pagos', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockRefundPayment.mockResolvedValue(undefined);
    mockPrisma.serviceRequest.update.mockResolvedValue({});
    mockPrisma.dispute.findUniqueOrThrow.mockResolvedValue(disputaBase({ estado: 'resuelta_cliente' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Trabajo no realizado' }, 'admin-1'), res);

    expect(mockRefundPayment).toHaveBeenCalledWith('sr-1');
    expect(mockReleasePayments).not.toHaveBeenCalled();
    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: { estado: 'cancelada' },
    });
    // Finalización: updateMany condicionado (no un update incondicional),
    // seguido de una relectura para la respuesta.
    expect(mockPrisma.dispute.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'disputa-1', estado: 'en_resolucion', reclamadaAt: expect.any(Date) },
      data: expect.objectContaining({
        estado: 'resuelta_cliente',
        resueltoPor: 'admin-1',
        resolucionNotas: 'Trabajo no realizado',
        reclamadaAt: null,
      }),
    });
    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'resolver_disputa', estadoAnterior: 'abierta', estadoNuevo: 'resuelta_cliente' })
    );
  });

  it('a favor del profesional: libera la suma de retenido+capturado (usando capturadoBase cuando existe), nunca reembolsa', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockPrisma.payment.findMany.mockResolvedValue([
      { estado: 'retenido', montoBase: 100, capturadoBase: null },
      { estado: 'capturado', montoBase: 50, capturadoBase: 45 }, // escalado proporcional ya congelado
    ]);
    mockReleasePayments.mockResolvedValue(undefined);
    mockPrisma.serviceRequest.update.mockResolvedValue({});
    mockPrisma.dispute.findUniqueOrThrow.mockResolvedValue(disputaBase({ estado: 'resuelta_profesional' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_profesional', notas: 'Trabajo verificado' }, 'admin-1'), res);

    expect(mockPrisma.payment.findMany).toHaveBeenCalledWith({
      where: { serviceRequestId: 'sr-1', estado: { in: ['retenido', 'capturado'] } },
    });
    // 100 (retenido, sin capturadoBase -> usa montoBase) + 45 (capturado, usa capturadoBase)
    expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 145);
    expect(mockRefundPayment).not.toHaveBeenCalled();
    expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: { estado: 'completada' },
    });
  });

  it('devuelve 502 y NO marca la disputa como resuelta si Stripe falla — y revierte el claim a "abierta"', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockRefundPayment.mockRejectedValue(new Error('insufficient balance in Connect account'));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Reembolso' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DISPUTE_RESOLUTION_STRIPE_FAILED' })
    );
    expect(mockPrisma.dispute.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();

    // El claim ('en_resolucion') se revierte a 'abierta' — sin esto la
    // disputa quedaría varada, sin poder reintentarse nunca. Se revierte
    // siempre a 'abierta' (no al disputa.estado leído al principio):
    // 'en_revision' no se escribe hoy en ningún sitio del código.
    expect(mockPrisma.dispute.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'disputa-1', estado: 'en_resolucion', reclamadaAt: expect.any(Date) },
      data: { estado: 'abierta', resueltoPor: null, reclamadaAt: null },
    });

    // El revert usa el MISMO valor de reclamadaAt que el claim capturó —
    // no uno recalculado (fencing token, ver revisión ABA más abajo).
    const claimCall = mockPrisma.dispute.updateMany.mock.calls[0][0];
    const revertCall = mockPrisma.dispute.updateMany.mock.calls[1][0];
    expect(revertCall.where.reclamadaAt).toBe(claimCall.data.reclamadaAt);
  });

  it('devuelve 409 si la disputa ya estaba resuelta, sin volver a mover dinero', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase({ estado: 'resuelta_profesional' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Intento repetido' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISPUTE_ALREADY_RESOLVED' }));
    expect(mockRefundPayment).not.toHaveBeenCalled();
    expect(mockReleasePayments).not.toHaveBeenCalled();
    expect(mockPrisma.dispute.updateMany).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la disputa no existe', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'No existe' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISPUTE_NOT_FOUND' }));
  });

  it('rechaza datos inválidos (notas demasiado cortas) con 400, sin tocar BD ni Stripe', async () => {
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'a' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.dispute.findUnique).not.toHaveBeenCalled();
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  /**
   * P2 (auditoría 2026-08-14, revisión de concurrencia crítica): claim
   * atómico de la disputa (abierta/en_revision → en_resolucion). Estos
   * tests comprueban que el PERDEDOR de la carrera nunca llega a mover
   * dinero — no solo el resultado final, sino que refundPayment/
   * releasePayments no se llegan a invocar en absoluto para quien pierde
   * el updateMany condicional.
   */
  describe('claim atómico: dos resolveDispute simultáneos', () => {
    it('el que pierde el claim (count=0) recibe 409 y NO llama a refundPayment ni a releasePayments', async () => {
      mockPrisma.dispute.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
      const res = fakeRes();

      await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Segundo intento' }, 'admin-2'), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISPUTE_ALREADY_RESOLVED' }));
      expect(mockRefundPayment).not.toHaveBeenCalled();
      expect(mockReleasePayments).not.toHaveBeenCalled();
      expect(mockPrisma.dispute.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
    });

    it('resoluciones opuestas simultáneas (cliente vs profesional): solo la que gana el claim mueve dinero, nunca ambas', async () => {
      // Simula que OTRA petición (resuelta_profesional) ya ganó el claim
      // justo antes de que esta (resuelta_cliente) intentara el suyo.
      mockPrisma.dispute.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
      const res = fakeRes();

      await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Petición perdedora' }, 'admin-1'), res);

      expect(res.status).toHaveBeenCalledWith(409);
      // Ninguna operación de dinero de NINGÚN tipo — ni refund ni release —
      // se ejecuta para la que pierde, sin importar qué resolución traía.
      expect(mockRefundPayment).not.toHaveBeenCalled();
      expect(mockReleasePayments).not.toHaveBeenCalled();
    });

    it('la que gana el claim procede con normalidad (queda demostrado que el mecanismo no bloquea el caso feliz)', async () => {
      mockPrisma.dispute.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
      mockRefundPayment.mockResolvedValue(undefined);
      mockPrisma.serviceRequest.update.mockResolvedValue({});
      mockPrisma.dispute.findUniqueOrThrow.mockResolvedValue(disputaBase({ estado: 'resuelta_cliente' }));
      const res = fakeRes();

      await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Petición ganadora' }, 'admin-1'), res);

      const claimCall = mockPrisma.dispute.updateMany.mock.calls[0][0];
      expect(claimCall.where).toEqual({
        id: 'disputa-1',
        OR: [
          { estado: { in: ['abierta', 'en_revision'] } },
          { estado: 'en_resolucion', reclamadaAt: { lt: expect.any(Date) } },
        ],
      });
      expect(claimCall.data).toEqual({
        estado: 'en_resolucion',
        resueltoPor: 'admin-1',
        reclamadaAt: expect.any(Date),
      });
      expect(mockRefundPayment).toHaveBeenCalledWith('sr-1');
      expect(mockRegistrarAccionAdmin).toHaveBeenCalledTimes(1);
    });
  });

  it('reintento tras un fallo previo (claim ya revertido) funciona con normalidad, sin duplicar nada', async () => {
    // Estado tras el test de fallo de Stripe: la disputa volvió a
    // 'abierta', así que un segundo intento puede reclamarla de nuevo.
    mockPrisma.dispute.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase({ estado: 'abierta' }));
    mockRefundPayment.mockResolvedValue(undefined);
    mockPrisma.serviceRequest.update.mockResolvedValue({});
    mockPrisma.dispute.findUniqueOrThrow.mockResolvedValue(disputaBase({ estado: 'resuelta_cliente' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Reintento tras fallo' }, 'admin-1'), res);

    expect(mockRefundPayment).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ estado: 'resuelta_cliente' }));
  });

  /**
   * P2 (auditoría 2026-08-14, revisión de concurrencia crítica): carrera
   * ABA pedida explícitamente — A reclama con reclamadaAt=T1, se queda
   * colgado más del TTL, B recupera con T2, A revive. Jest es síncrono,
   * así que no se simula un stall real de 5 minutos — lo que sí se
   * prueba es la propiedad que hace segura esa carrera: toda escritura
   * posterior de A usa exactamente el reclamadaAt que capturó al
   * reclamar (nunca uno recalculado), así que si ya no coincide con la
   * fila real (porque B la reclamó de nuevo), esa escritura de A no
   * afecta nada — sin lanzar error ni tocar el trabajo de B.
   */
  describe('carrera ABA: A revive tras perder el claim por TTL frente a B', () => {
    it('A intenta el rollback tras fallar, pero B ya reclamó de nuevo (T2) — el rollback de A no afecta la fila de B', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
      mockPrisma.dispute.updateMany
        .mockResolvedValueOnce({ count: 1 }) // A reclama con T1
        .mockResolvedValueOnce({ count: 0 }); // el rollback de A (T1) ya no coincide: B la reclamó (T2)
      mockRefundPayment.mockRejectedValue(new Error('Stripe caído'));
      const res = fakeRes();

      await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'A falla, B ya recuperó' }, 'admin-1'), res);

      expect(res.status).toHaveBeenCalledWith(502);
      // El rollback de A se intentó con SU token exacto — la llamada
      // ocurrió, simplemente no afectó ninguna fila (count:0 simulado).
      const claimCall = mockPrisma.dispute.updateMany.mock.calls[0][0];
      const rollbackCall = mockPrisma.dispute.updateMany.mock.calls[1][0];
      expect(rollbackCall.where.reclamadaAt).toBe(claimCall.data.reclamadaAt);
      expect(mockPrisma.dispute.updateMany).toHaveBeenCalledTimes(2);
    });

    it('A intenta finalizar tras un éxito propio, pero B ya recuperó y resolvió por TTL — A no sobrescribe el resultado de B', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
      mockPrisma.dispute.updateMany
        .mockResolvedValueOnce({ count: 1 }) // A reclama con T1
        .mockResolvedValueOnce({ count: 0 }); // la finalización de A (T1) ya no coincide: B la recuperó y resolvió
      mockRefundPayment.mockResolvedValue(undefined); // el dinero de LA PETICIÓN DE A sí se movió
      mockPrisma.serviceRequest.update.mockResolvedValue({});
      // Lo que de verdad quedó en BD es el resultado de B, no el de A.
      mockPrisma.dispute.findUniqueOrThrow.mockResolvedValue(
        disputaBase({ estado: 'resuelta_profesional', resueltoPor: 'admin-2' })
      );
      const res = fakeRes();

      await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'A llega tarde' }, 'admin-1'), res);

      // Se devuelve el estado REAL (el de B) — A nunca lo sobrescribe.
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ estado: 'resuelta_profesional', resueltoPor: 'admin-2' })
      );
      // El dinero de la petición de A sí se movió, así que se sigue
      // registrando su acción (con el estado real ya devuelto por B).
      expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ estadoNuevo: 'resuelta_profesional' })
      );
    });
  });

  it('el WHERE del claim permite recuperar un claim caducado (reclamadaAt < TTL), no solo el estado abierto — disputa abandonada recuperable', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(disputaBase());
    mockRefundPayment.mockResolvedValue(undefined);
    mockPrisma.serviceRequest.update.mockResolvedValue({});
    mockPrisma.dispute.findUniqueOrThrow.mockResolvedValue(disputaBase({ estado: 'resuelta_cliente' }));
    const res = fakeRes();

    await resolveDispute(fakeReq({ resolucion: 'resuelta_cliente', notas: 'Verificando la recuperación por TTL' }, 'admin-1'), res);

    const claimCall = mockPrisma.dispute.updateMany.mock.calls[0][0];
    const ramaDeRecuperacion = claimCall.where.OR[1];
    expect(ramaDeRecuperacion).toEqual({ estado: 'en_resolucion', reclamadaAt: { lt: expect.any(Date) } });
    // El límite es aproximadamente "ahora - 5 minutos" (mismo TTL que el
    // lease de Payment), no un valor arbitrario.
    const limite: Date = ramaDeRecuperacion.reclamadaAt.lt;
    const diferenciaMs = Date.now() - limite.getTime();
    expect(diferenciaMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    expect(diferenciaMs).toBeLessThan(5 * 60 * 1000 + 5000);
  });
});
