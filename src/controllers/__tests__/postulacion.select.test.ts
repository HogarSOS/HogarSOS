import { Request, Response } from 'express';

const txMock = {
  postulacion: {
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  serviceRequest: {
    updateMany: jest.fn(),
  },
};

jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn() },
    postulacion: { findUnique: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ firebaseUid: 'uid-fake' }) },
    $transaction: jest.fn(async (fn: any) => fn(txMock)),
  },
}));

jest.mock('../../config/firebase', () => ({
  firestore: { collection: jest.fn(() => ({ doc: jest.fn(() => ({ set: jest.fn() })) })) },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
  enviarNotificacionMasiva: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion, enviarNotificacionMasiva } from '../../services/notification.service';
import { selectPostulacion } from '../postulacion.controller';

const mockPrisma = prisma as any;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;
const mockEnviarNotificacionMasiva = enviarNotificacionMasiva as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string): Request {
  return { params, user: { userId } } as unknown as Request;
}

describe('selectPostulacion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      estado: 'pendiente',
    });
    mockPrisma.postulacion.findUnique.mockResolvedValue({
      id: 'post-1',
      serviceRequestId: 'sr-1',
      profesionalId: 'pro-elegido',
      estado: 'pendiente',
    });
    txMock.postulacion.findMany.mockResolvedValue([{ profesionalId: 'pro-2' }, { profesionalId: 'pro-3' }]);
    txMock.serviceRequest.updateMany.mockResolvedValue({ count: 1 });
  });

  /**
   * Mismo patrón que el antiguo acceptServiceRequest: la comprobación
   * estado: 'pendiente' vive dentro del propio updateMany, para que
   * dos elecciones simultáneas (o un doble tap) no dejen la solicitud
   * en un estado inconsistente.
   */
  it('comprueba estado: "pendiente" dentro del propio updateMany', async () => {
    await selectPostulacion(fakeReq({ id: 'sr-1', postulacionId: 'post-1' }, 'cliente-1'), fakeRes());

    expect(txMock.serviceRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sr-1', estado: 'pendiente' },
        data: expect.objectContaining({ profesionalId: 'pro-elegido', estado: 'aceptada' }),
      })
    );
  });

  it('devuelve 409 (no 500) si la solicitud ya no estaba pendiente al confirmar', async () => {
    txMock.serviceRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await selectPostulacion(fakeReq({ id: 'sr-1', postulacionId: 'post-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('marca la elegida como aceptada y el resto como rechazadas', async () => {
    await selectPostulacion(fakeReq({ id: 'sr-1', postulacionId: 'post-1' }, 'cliente-1'), fakeRes());

    expect(txMock.postulacion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'post-1' }, data: expect.objectContaining({ estado: 'aceptada' }) })
    );
    expect(txMock.postulacion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { serviceRequestId: 'sr-1', id: { not: 'post-1' }, estado: 'pendiente' },
        data: expect.objectContaining({ estado: 'rechazada' }),
      })
    );
  });

  it('notifica al elegido y, en masa, a los descartados', async () => {
    await selectPostulacion(fakeReq({ id: 'sr-1', postulacionId: 'post-1' }, 'cliente-1'), fakeRes());

    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'pro-elegido',
      expect.any(Object),
      expect.objectContaining({ tipo: 'postulacion_aceptada' })
    );
    expect(mockEnviarNotificacionMasiva).toHaveBeenCalledWith(
      ['pro-2', 'pro-3'],
      expect.any(Object),
      expect.objectContaining({ tipo: 'postulacion_rechazada' })
    );
  });

  it('devuelve 403 si quien elige no es el cliente dueño de la solicitud', async () => {
    const res = fakeRes();
    await selectPostulacion(fakeReq({ id: 'sr-1', postulacionId: 'post-1' }, 'otro-usuario'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('devuelve 404 si la candidatura no pertenece a esta solicitud', async () => {
    mockPrisma.postulacion.findUnique.mockResolvedValue({
      id: 'post-1',
      serviceRequestId: 'otra-solicitud',
      profesionalId: 'pro-elegido',
      estado: 'pendiente',
    });

    const res = fakeRes();
    await selectPostulacion(fakeReq({ id: 'sr-1', postulacionId: 'post-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
