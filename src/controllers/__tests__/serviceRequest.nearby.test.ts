import { Request, Response } from 'express';

const txMock = {
  professional: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};

jest.mock('../../config/prisma', () => ({
  prisma: {
    $transaction: jest.fn(async (fn: any) => fn(txMock)),
  },
}));

// serviceRequest.controller.ts importa estos módulos para sus otras
// acciones (pagos/Firestore/notificaciones/archivos, ninguna tocada por
// listNearbyRequests) — sin mockearlos, cargar el fichero arrastra
// config/stripe.ts, que revienta en test por faltar STRIPE_SECRET_KEY real.
jest.mock('../../config/firebase', () => ({
  firestore: { collection: jest.fn() },
}));
jest.mock('../../services/payment.service', () => ({
  releasePayments: jest.fn(),
  refundPayment: jest.fn(),
  diagnosticarPagoSinConfirmar: jest.fn(),
}));
jest.mock('../../services/archivo.service', () => ({
  asociarArchivosASolicitud: jest.fn(),
}));
jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn(),
  enviarNotificacionMasiva: jest.fn(),
  enviarNotificacionCruda: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { listNearbyRequests } from '../serviceRequest.controller';

const mockPrisma = prisma as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string): Request {
  return { user: { userId, role: 'profesional' } } as unknown as Request;
}

// Profesional "de libro": aprobado, disponible, con 1 categoría — el
// caso que sí debe llegar hasta el $queryRaw.
function profesionalBase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'prof-1',
    disponible: true,
    estadoVerificacion: 'aprobado',
    categorias: [{ categoryId: 1 }],
    ...overrides,
  };
}

describe('listNearbyRequests (P0 — una sola conexión vía $transaction)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));
  });

  it('usa $transaction (una sola adquisición de conexión) en vez de dos llamadas prisma. sueltas', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase());
    txMock.$queryRaw.mockResolvedValue([]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.professional.findUnique).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('devuelve las solicitudes cercanas cuando el profesional está aprobado, disponible y con categorías', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase());
    const filas = [
      { id: 'sr-1', descripcion: 'Grifo roto', distancia_metros: 120.5, created_at: new Date(), urgencia: 'lo_antes_posible', cliente_nombre: 'Ana', cliente_foto_url: null, ya_postulado: false },
    ];
    txMock.$queryRaw.mockResolvedValue(filas);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.status).not.toHaveBeenCalled(); // res.json() por defecto = 200
    expect(res.json).toHaveBeenCalledWith({ solicitudes: filas });
  });

  it('devuelve 404 si no existe perfil de profesional, sin llegar a ejecutar el $queryRaw', async () => {
    txMock.professional.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-inexistente'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROFESSIONAL_PROFILE_NOT_FOUND' }));
    expect(txMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('devuelve 403 si el profesional no está verificado, sin llegar a ejecutar el $queryRaw', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase({ estadoVerificacion: 'pendiente' }));
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACCOUNT_NOT_VERIFIED' }));
    expect(txMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('devuelve 200 con aviso si el profesional no está disponible, sin llegar a ejecutar el $queryRaw', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase({ disponible: false }));
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({ solicitudes: [], aviso: 'Estás marcado como no disponible' });
    expect(txMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('devuelve 200 con aviso si el profesional no tiene categorías, sin llegar a ejecutar el $queryRaw', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase({ categorias: [] }));
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({ solicitudes: [], aviso: 'No tienes categorías configuradas' });
    expect(txMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('devuelve una lista vacía sin aviso cuando no hay solicitudes cercanas (caso ok, cero resultados)', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase());
    txMock.$queryRaw.mockResolvedValue([]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({ solicitudes: [] });
  });

  it('pasa el userId autenticado y los categoryIds reales del profesional a la consulta (sin fuga de autorización)', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase({ categorias: [{ categoryId: 3 }, { categoryId: 7 }] }));
    txMock.$queryRaw.mockResolvedValue([]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-atacante'), res);

    expect(txMock.professional.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'prof-atacante' } })
    );
    // $queryRaw se llama como plantilla etiquetada: (strings, ...valores).
    // El profesionalId (dos veces: JOIN y LEFT JOIN) y el array de
    // categoryIds deben ser los del profesional autenticado, no otros.
    const valoresInterpolados = txMock.$queryRaw.mock.calls[0].slice(1);
    expect(valoresInterpolados).toContain('prof-atacante');
    expect(valoresInterpolados.some((v: unknown) => Array.isArray(v) && v.includes(3) && v.includes(7))).toBe(true);
  });

  it('si $queryRaw falla dentro de la transacción, propaga el error (sin devolver una respuesta parcial)', async () => {
    txMock.professional.findUnique.mockResolvedValue(profesionalBase());
    txMock.$queryRaw.mockRejectedValue(new Error('fallo de conexión simulado'));
    const res = fakeRes();

    await expect(listNearbyRequests(fakeReq('prof-1'), res)).rejects.toThrow('fallo de conexión simulado');
    expect(res.json).not.toHaveBeenCalled();
  });
});
