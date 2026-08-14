import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    professional: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

// Mismo motivo que admin.userToggle.test.ts: admin.controller.ts arrastra
// estos módulos al importarse, y payment.service revienta en test por
// faltar STRIPE_SECRET_KEY real si no se mockea.
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
import { enviarNotificacion } from '../../services/notification.service';
import { approveProfessional } from '../admin.controller';

const mockPrisma = prisma as any;
const mockRegistrarAccionAdmin = registrarAccionAdmin as jest.Mock;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(body: Record<string, unknown>, adminId: string): Request {
  return { params: { professionalId: 'prof-1' }, body, user: { userId: adminId } } as unknown as Request;
}

function profesionalBase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'prof-1',
    estadoVerificacion: 'pendiente',
    ...overrides,
  };
}

describe('approveProfessional', () => {
  beforeEach(() => jest.clearAllMocks());

  it('aprueba a un profesional pendiente y le notifica', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(profesionalBase());
    mockPrisma.professional.update.mockResolvedValue(profesionalBase({ estadoVerificacion: 'aprobado' }));
    const res = fakeRes();

    await approveProfessional(fakeReq({ aprobar: true }, 'admin-1'), res);

    expect(mockPrisma.professional.update).toHaveBeenCalledWith({
      where: { userId: 'prof-1' },
      data: { estadoVerificacion: 'aprobado', verificadoPor: 'admin-1', verificadoAt: expect.any(Date) },
    });
    expect(mockEnviarNotificacion).toHaveBeenCalledWith('prof-1', 'verificacion_aprobada', {});
    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'aprobar_profesional', estadoNuevo: 'aprobado' })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ estadoVerificacion: 'aprobado' }));
  });

  it('rechaza a un profesional con motivo y lo pasa a la notificación', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(profesionalBase());
    mockPrisma.professional.update.mockResolvedValue(profesionalBase({ estadoVerificacion: 'rechazado' }));
    const res = fakeRes();

    await approveProfessional(
      fakeReq({ aprobar: false, motivoRechazo: 'El DNI no es legible' }, 'admin-1'),
      res
    );

    expect(mockEnviarNotificacion).toHaveBeenCalledWith('prof-1', 'verificacion_rechazada', {
      motivoRechazo: 'El DNI no es legible',
    });
    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'rechazar_profesional', detalle: 'El DNI no es legible' })
    );
  });

  it('rechaza un rechazo sin motivo con 400, sin tocar BD ni notificar', async () => {
    const res = fakeRes();

    await approveProfessional(fakeReq({ aprobar: false }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VERIFICATION_REJECT_REASON_REQUIRED' })
    );
    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
  });

  it('devuelve 404 si el profesional no existe', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await approveProfessional(fakeReq({ aprobar: true }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROFESSIONAL_NOT_FOUND' }));
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
  });

  it('devuelve 409 si la verificación ya no está pendiente', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(profesionalBase({ estadoVerificacion: 'aprobado' }));
    const res = fakeRes();

    await approveProfessional(fakeReq({ aprobar: true }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VERIFICATION_NOT_PENDING' }));
    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(mockEnviarNotificacion).not.toHaveBeenCalled();
  });
});
