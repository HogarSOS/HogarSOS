import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: { tareaProgramada: { findMany: jest.fn() } },
}));

jest.mock('../../services/payment.service', () => ({
  refundPayment: jest.fn(),
  releasePayments: jest.fn(),
  listarPagosAtascados: jest.fn(),
  reintentarLiberacion: jest.fn(),
}));

jest.mock('../serviceRequest.controller', () => ({
  agregarPagos: jest.fn(),
}));

jest.mock('../../jobs', () => ({
  TAREAS: [{ nombre: 'tarea-x', descripcion: 'x', intervaloMs: 1000, duracionMaximaMs: 1000, ejecutar: jest.fn() }],
  ejecutarTareaAhora: jest.fn(),
}));

jest.mock('../../services/adminAction.service', () => ({
  registrarAccionAdmin: jest.fn(),
  listarAccionesAdmin: jest.fn(),
}));

import { ejecutarTareaAhora } from '../../jobs';
import { reintentarLiberacion } from '../../services/payment.service';
import { registrarAccionAdmin } from '../../services/adminAction.service';
import { runJob, retryPaymentRelease } from '../admin.controller';

const mockEjecutarTareaAhora = ejecutarTareaAhora as jest.Mock;
const mockReintentarLiberacion = reintentarLiberacion as jest.Mock;
const mockRegistrarAccionAdmin = registrarAccionAdmin as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, adminId: string): Request {
  return { params, user: { userId: adminId } } as unknown as Request;
}

// Hallazgo pendiente confirmado antes del Bloque 4 (ver auditoría de este
// mismo bloque): retryPaymentRelease y runJob movían dinero real / disparaban
// tareas sin dejar ningún rastro en AdminAction. Estos dos tests cierran ese
// hueco.
describe('runJob registra en AdminAction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registra la ejecución manual tras un éxito', async () => {
    mockEjecutarTareaAhora.mockResolvedValue('3 archivos borrados');
    const res = fakeRes();

    await runJob(fakeReq({ nombre: 'tarea-x' }, 'admin-1'), res);

    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        accion: 'ejecutar_tarea_manual',
        entidadTipo: 'job',
        entidadId: 'tarea-x',
        detalle: '3 archivos borrados',
      })
    );
    expect(res.json).toHaveBeenCalledWith({ nombre: 'tarea-x', resultado: '3 archivos borrados' });
  });

  it('no registra nada si la tarea falla', async () => {
    mockEjecutarTareaAhora.mockRejectedValue(new Error('boom'));
    const res = fakeRes();

    await runJob(fakeReq({ nombre: 'tarea-x' }, 'admin-1'), res);

    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('retryPaymentRelease registra en AdminAction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registra el reintento tras liberar pagos con éxito', async () => {
    mockReintentarLiberacion.mockResolvedValue([{ id: 'pago-1' }, { id: 'pago-2' }]);
    const res = fakeRes();

    await retryPaymentRelease(fakeReq({ serviceRequestId: 'sr-1' }, 'admin-1'), res);

    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        accion: 'reintentar_liberacion_pago',
        entidadTipo: 'service_request',
        entidadId: 'sr-1',
        detalle: '2 pago(s) liberado(s)',
      })
    );
  });

  it('no registra nada si el reintento falla', async () => {
    mockReintentarLiberacion.mockRejectedValue(new Error('LIBERACION_YA_EN_CURSO'));
    const res = fakeRes();

    await retryPaymentRelease(fakeReq({ serviceRequestId: 'sr-1' }, 'admin-1'), res);

    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
