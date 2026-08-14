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
  diagnosticarPagoSinConfirmar: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
  enviarNotificacionMasiva: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { releasePayments, diagnosticarPagoSinConfirmar } from '../../services/payment.service';
import { enviarNotificacion } from '../../services/notification.service';
import { completeServiceRequest, responderCierreHoras } from '../serviceRequest.controller';

const mockPrisma = prisma as any;
const mockReleasePayments = releasePayments as jest.Mock;
const mockDiagnosticarPagoSinConfirmar = diagnosticarPagoSinConfirmar as jest.Mock;
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
    mockDiagnosticarPagoSinConfirmar.mockResolvedValue('nunca_autorizado');
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

  // P1 (auditoría 2026-08-14): PAGO_NO_AUTORIZADO_TODAVIA agrupaba dos
  // situaciones distintas bajo el mismo aviso genérico. Estos dos casos
  // prueban que el mensaje que recibe el profesional ahora distingue
  // "el cliente nunca autorizó" de "la autorización caducó", sin tocar
  // el estado 202 ni el hecho de que el servicio queda "completada".
  describe('PAGO_NO_AUTORIZADO_TODAVIA: mensaje según el motivo real', () => {
    beforeEach(() => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        id: 'sr-1',
        clienteId: 'cliente-1',
        profesionalId: 'pro-1',
        estado: 'aceptada',
        presupuestos: [{ id: 'pres-1', tipo: 'cerrado', monto: 180, ampliaciones: [] }],
      });
      mockReleasePayments.mockRejectedValue(new Error('PAGO_NO_AUTORIZADO_TODAVIA'));
    });

    it('caso A) el cliente nunca confirmó el Payment Sheet: aviso de "todavía no ha confirmado"', async () => {
      mockDiagnosticarPagoSinConfirmar.mockResolvedValue('nunca_autorizado');
      const res = fakeRes();

      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

      expect(mockDiagnosticarPagoSinConfirmar).toHaveBeenCalledWith('sr-1');
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.stringContaining('todavía no ha confirmado el pago') })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.not.stringContaining('caducado') })
      );
    });

    it('caso B) la autorización existía y caducó (B5): aviso de "ha caducado", no el genérico de "nunca confirmó"', async () => {
      mockDiagnosticarPagoSinConfirmar.mockResolvedValue('autorizacion_caducada');
      const res = fakeRes();

      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.stringContaining('ha caducado') })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.not.stringContaining('todavía no ha confirmado') })
      );
    });

    it('si la propia comprobación en Stripe falla, cae de vuelta al aviso genérico de "nunca confirmó" en vez de romper la respuesta', async () => {
      mockDiagnosticarPagoSinConfirmar.mockRejectedValue(new Error('Stripe caído'));
      const res = fakeRes();

      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.stringContaining('todavía no ha confirmado el pago') })
      );
    });

    it('un fallo de Stripe NO relacionado con PAGO_NO_AUTORIZADO_TODAVIA sigue devolviendo el aviso genérico de cola de reintento, sin diagnosticar nada', async () => {
      mockReleasePayments.mockRejectedValue(new Error('Stripe caído'));
      const res = fakeRes();

      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1'), res);

      expect(mockDiagnosticarPagoSinConfirmar).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.stringContaining('cola de reintento') })
      );
    });
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
      'cierre_horas_pendiente',
      expect.any(Object),
      expect.any(Object)
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

  // P2 #2 (auditoría 2026-08-14): el findFirst de arriba es solo
  // fast-path — dos peticiones casi simultáneas pueden pasarlo ambas
  // (ninguna ve todavía la fila de la otra) antes de que la primera
  // haga el create. La garantía real es el índice único parcial
  // `cierres_horas_pendiente_unico`; en ese caso Postgres/Prisma
  // rechaza el segundo create con P2002. Este test simula justo esa
  // carrera: findFirst pasa (null), pero el create choca con el
  // índice.
  it('"por_horas": si el create choca con el índice único (P2002 — carrera con otra petición), devuelve el mismo 409 que el fast-path', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });
    mockPrisma.cierreHoras.findFirst.mockResolvedValue(null);
    mockPrisma.cierreHoras.create.mockRejectedValue({ code: 'P2002' });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 3.5 }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HOURS_CLOSURE_ALREADY_PENDING' })
    );
    expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
    expect(mockReleasePayments).not.toHaveBeenCalled();
  });

  it('"por_horas": un error de Prisma que NO es P2002 no se convierte en 409 — se deja propagar tal cual (no se filtra/oculta)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });
    mockPrisma.cierreHoras.findFirst.mockResolvedValue(null);
    const errorInesperado = { code: 'P2028', message: 'Transaction API error' };
    mockPrisma.cierreHoras.create.mockRejectedValue(errorInesperado);

    const res = fakeRes();
    await expect(completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 3.5 }), res)).rejects.toBe(
      errorInesperado
    );

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(res.json).not.toHaveBeenCalled();
  });

  // Tras resolver un cierre anterior (aceptado o rechazado), el índice
  // parcial (WHERE estado='pendiente') no debe estorbar: el
  // profesional puede volver a declarar horas y crear un cierre
  // pendiente nuevo con normalidad.
  it('"por_horas": puede crear un nuevo cierre pendiente después de que el anterior quedó rechazado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-1',
      estado: 'aceptada',
      presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 25, horasEstimadas: 4 }],
    });
    // El cierre anterior ya no está 'pendiente' — el findFirst (que
    // solo busca estado: 'pendiente') no lo ve, igual que no lo vería
    // el índice único parcial.
    mockPrisma.cierreHoras.findFirst.mockResolvedValue(null);
    mockPrisma.cierreHoras.create.mockResolvedValue({ id: 'cierre-2', horasReales: 4.5 });

    const res = fakeRes();
    await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 4.5 }), res);

    expect(mockPrisma.cierreHoras.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ serviceRequestId: 'sr-1', horasReales: 4.5 }) })
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cierreHorasId: 'cierre-2' }));
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

  // Protección anti-evasión de comisión (auditoría 2026-08-14): un
  // presupuesto por_horas autoriza tarifaHora × horasEstimadas en
  // Stripe, pero lo que de verdad se cobra y comisiona es tarifaHora ×
  // horasReales, un valor que declara libremente el profesional. Estos
  // casos (D/E/F del pedido) prueban el suelo UMBRAL_MINIMO_ABSOLUTO_HORAS.
  describe('protección anti-evasión: horasReales', () => {
    beforeEach(() => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        id: 'sr-1',
        clienteId: 'cliente-1',
        profesionalId: 'pro-1',
        estado: 'aceptada',
        presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 50, horasEstimadas: 10 }],
      });
      mockPrisma.cierreHoras.findFirst.mockResolvedValue(null);
    });

    it('D) horasReales = 0: rechazado por el propio esquema (positive()), no llega a crear el cierre', async () => {
      const res = fakeRes();
      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 0 }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_INVALID' }));
      expect(mockPrisma.cierreHoras.create).not.toHaveBeenCalled();
    });

    it('E) horasReales negativas: rechazado por el propio esquema (positive())', async () => {
      const res = fakeRes();
      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: -3 }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_INVALID' }));
      expect(mockPrisma.cierreHoras.create).not.toHaveBeenCalled();
    });

    it('F) horasReales absurdamente pequeñas (0.2h, por debajo del suelo de 0.5h): bloqueado con HOURS_TOO_LOW', async () => {
      const res = fakeRes();
      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 0.2 }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOURS_TOO_LOW' }));
      expect(mockPrisma.cierreHoras.create).not.toHaveBeenCalled();
    });

    it('un valor justo en el suelo (0.5h) sí se acepta y crea el cierre pendiente', async () => {
      mockPrisma.cierreHoras.create.mockResolvedValue({ id: 'cierre-1', horasReales: 0.5 });
      const res = fakeRes();
      await completeServiceRequest(fakeReq({ id: 'sr-1' }, 'pro-1', { horasReales: 0.5 }), res);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(mockPrisma.cierreHoras.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ horasReales: 0.5 }) })
      );
    });
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
    mockDiagnosticarPagoSinConfirmar.mockResolvedValue('nunca_autorizado');
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
      'cierre_horas_aceptado',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('al rechazar: NO completa la solicitud ni libera el pago, solo notifica', async () => {
    const res = fakeRes();
    await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'rechazar' }), res);

    expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
    expect(mockReleasePayments).not.toHaveBeenCalled();
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-1',
      'cierre_horas_rechazado',
      expect.any(Object),
      expect.any(Object)
    );
  });

  // P1 (auditoría 2026-08-14): mismo caso que en completeServiceRequest,
  // aplicado a la confirmación de horas reales.
  describe('PAGO_NO_AUTORIZADO_TODAVIA: mensaje según el motivo real', () => {
    beforeEach(() => {
      mockReleasePayments.mockRejectedValue(new Error('PAGO_NO_AUTORIZADO_TODAVIA'));
    });

    it('caso A) el cliente nunca confirmó el Payment Sheet: aviso de "todavía no ha confirmado"', async () => {
      mockDiagnosticarPagoSinConfirmar.mockResolvedValue('nunca_autorizado');
      const res = fakeRes();

      await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

      expect(mockDiagnosticarPagoSinConfirmar).toHaveBeenCalledWith('sr-1');
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.stringContaining('todavía no ha confirmado el pago') })
      );
    });

    it('caso B) la autorización existía y caducó (B5): aviso de "ha caducado"', async () => {
      mockDiagnosticarPagoSinConfirmar.mockResolvedValue('autorizacion_caducada');
      const res = fakeRes();

      await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ aviso: expect.stringContaining('ha caducado') })
      );
    });
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

  // Protección anti-evasión de comisión (auditoría 2026-08-14): gate de
  // confirmación explícita cuando horasReales cae muy por debajo de
  // horasEstimadas (UMBRAL_RATIO_REDUCCION_ANOMALA = 50%). Presupuesto
  // fijo para todos estos casos: 50€/h × 10h estimadas = 500€ de base
  // autorizada en Stripe (el escenario exacto pedido en la auditoría).
  describe('protección anti-evasión: reducción anómala', () => {
    beforeEach(() => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        id: 'sr-1',
        clienteId: 'cliente-1',
        profesionalId: 'pro-1',
        presupuestos: [{ id: 'pres-1', tipo: 'por_horas', tarifaHora: 50, horasEstimadas: 10 }],
      });
    });

    it('A) horasReales normales (10 de 10 estimadas, 100%): se acepta directamente, sin pedir confirmación', async () => {
      mockPrisma.cierreHoras.findUnique.mockResolvedValue({
        id: 'cierre-1', serviceRequestId: 'sr-1', horasReales: 10, estado: 'pendiente',
      });

      const res = fakeRes();
      await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

      expect(mockPrisma.cierreHoras.updateMany).toHaveBeenCalled();
      // G) cálculo final: 50€/h × 10h = 500€.
      expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ precioFinal: 500 }) })
      );
      expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ estado: 'aceptado' }));
    });

    it('B) horasReales ligeramente inferiores (7 de 10, 70%): por encima del umbral, se acepta directamente', async () => {
      mockPrisma.cierreHoras.findUnique.mockResolvedValue({
        id: 'cierre-1', serviceRequestId: 'sr-1', horasReales: 7, estado: 'pendiente',
      });

      const res = fakeRes();
      await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

      expect(mockPrisma.cierreHoras.updateMany).toHaveBeenCalled();
      // G) cálculo final: 50€/h × 7h = 350€.
      expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ precioFinal: 350 }) })
      );
      expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 350);
    });

    it('C) reducción muy grande (escenario de la auditoría: 1 de 10h, 10%) sin confirmación: 409, no toca el estado ni libera nada', async () => {
      mockPrisma.cierreHoras.findUnique.mockResolvedValue({
        id: 'cierre-1', serviceRequestId: 'sr-1', horasReales: 1, estado: 'pendiente',
      });

      const res = fakeRes();
      await responderCierreHoras(fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HOURS_REDUCTION_CONFIRMATION_REQUIRED',
          horasReales: 1,
          horasEstimadas: 10,
          porcentaje: 10,
        })
      );
      // El cierre sigue pendiente — nada de esto se ejecutó todavía.
      expect(mockPrisma.cierreHoras.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.serviceRequest.update).not.toHaveBeenCalled();
      expect(mockReleasePayments).not.toHaveBeenCalled();
    });

    it('C) la misma reducción del 10%, CON confirmarReduccionGrande: se acepta y libera solo el importe real', async () => {
      mockPrisma.cierreHoras.findUnique.mockResolvedValue({
        id: 'cierre-1', serviceRequestId: 'sr-1', horasReales: 1, estado: 'pendiente',
      });

      const res = fakeRes();
      await responderCierreHoras(
        fakeReq({ id: 'sr-1', cierreId: 'cierre-1' }, 'cliente-1', { accion: 'aceptar', confirmarReduccionGrande: true }),
        res
      );

      expect(mockPrisma.cierreHoras.updateMany).toHaveBeenCalled();
      // G) cálculo final: 50€/h × 1h = 50€ — nunca los 500€ autorizados.
      expect(mockPrisma.serviceRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ precioFinal: 50 }) })
      );
      expect(mockReleasePayments).toHaveBeenCalledWith('sr-1', 50);
      expect(res.status).not.toHaveBeenCalledWith(409);
    });
  });
});
