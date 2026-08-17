import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn(),
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

// Fila "solo de estado" (id null) — lo que devuelve la consulta cuando
// el profesional pasa los filtros pero no hay ninguna solicitud real
// que coincida, o cuando está bloqueado por disponible/categorías.
function filaEstado(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    estadoVerificacion: 'aprobado',
    disponible: true,
    categoriaIds: [1],
    id: null,
    descripcion: null,
    distanciaMetros: null,
    createdAt: null,
    urgencia: null,
    clienteNombre: null,
    clienteFotoUrl: null,
    yaPostulado: false,
    ...overrides,
  };
}

describe('listNearbyRequests (fusión SQL sin $transaction — segunda investigación B-01)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('usa una sola llamada $queryRaw (sin $transaction)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([filaEstado()]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction).toBeUndefined();
  });

  it('devuelve 404 si la consulta no devuelve ninguna fila (profesional inexistente)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-inexistente'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROFESSIONAL_PROFILE_NOT_FOUND' }));
  });

  it('devuelve 403 si el profesional no está verificado', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([filaEstado({ estadoVerificacion: 'pendiente' })]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACCOUNT_NOT_VERIFIED' }));
  });

  it('devuelve 200 con aviso si el profesional no está disponible', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([filaEstado({ disponible: false })]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({ solicitudes: [], aviso: 'Estás marcado como no disponible' });
  });

  it('devuelve 200 con aviso si el profesional no tiene categorías', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([filaEstado({ categoriaIds: [] })]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({ solicitudes: [], aviso: 'No tienes categorías configuradas' });
  });

  it('devuelve una lista vacía sin aviso cuando el profesional es válido pero no hay solicitudes cercanas (fila de estado con id=null)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([filaEstado()]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({ solicitudes: [] });
  });

  it('filtra la fila "solo de estado" (id=null) y devuelve solo las solicitudes reales, en el shape original (snake_case)', async () => {
    const fechaCreacion = new Date('2026-08-17T10:00:00Z');
    mockPrisma.$queryRaw.mockResolvedValue([
      filaEstado({
        id: 'sr-1',
        descripcion: 'Grifo roto',
        distanciaMetros: 120.5,
        createdAt: fechaCreacion,
        urgencia: 'lo_antes_posible',
        clienteNombre: 'Ana',
        clienteFotoUrl: null,
        yaPostulado: false,
      }),
    ]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-1'), res);

    expect(res.json).toHaveBeenCalledWith({
      solicitudes: [
        {
          id: 'sr-1',
          descripcion: 'Grifo roto',
          created_at: fechaCreacion,
          urgencia: 'lo_antes_posible',
          distancia_metros: 120.5,
          cliente_nombre: 'Ana',
          cliente_foto_url: null,
          ya_postulado: false,
        },
      ],
    });
  });

  it('pasa el userId autenticado a la consulta (sin fuga de autorización)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([filaEstado()]);
    const res = fakeRes();

    await listNearbyRequests(fakeReq('prof-atacante'), res);

    // $queryRaw se llama como plantilla etiquetada: (strings, ...valores).
    const valoresInterpolados = mockPrisma.$queryRaw.mock.calls[0].slice(1);
    expect(valoresInterpolados).toContain('prof-atacante');
  });

  it('si $queryRaw falla, propaga el error (sin devolver una respuesta parcial)', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('fallo de conexión simulado'));
    const res = fakeRes();

    await expect(listNearbyRequests(fakeReq('prof-1'), res)).rejects.toThrow('fallo de conexión simulado');
    expect(res.json).not.toHaveBeenCalled();
  });
});
