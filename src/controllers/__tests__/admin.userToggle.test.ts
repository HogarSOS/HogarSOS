import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  },
}));

// admin.controller.ts importa estos módulos para sus otras acciones
// (verificaciones/disputas/pagos atascados/jobs, ninguna tocada en este
// bloque) — sin mockearlos, cargar el fichero arrastra config/stripe.ts,
// que revienta en test por faltar STRIPE_SECRET_KEY real.
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

import { prisma } from '../../config/prisma';
import { registrarAccionAdmin } from '../../services/adminAction.service';
import { getUserForAdmin, toggleUserActive } from '../admin.controller';

const mockPrisma = prisma as any;
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

// Cliente normal, activo, sin nada especial — el caso base sobre el que
// se construyen las variantes de cada test con spread.
function usuarioBase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    nombre: 'Ana Cliente',
    email: 'ana@example.com',
    telefono: null,
    role: 'cliente',
    activo: true,
    firebaseUid: 'firebase-uid-ana',
    ...overrides,
  };
}

describe('getUserForAdmin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devuelve el usuario con cuentaEliminada:false si tiene firebaseUid', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(usuarioBase());
    const res = fakeRes();

    await getUserForAdmin(fakeReq({ id: 'user-1' }, 'admin-1'), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', activo: true, cuentaEliminada: false })
    );
  });

  it('marca cuentaEliminada:true si firebaseUid es null (borrado RGPD)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(usuarioBase({ firebaseUid: null, activo: false }));
    const res = fakeRes();

    await getUserForAdmin(fakeReq({ id: 'user-1' }, 'admin-1'), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cuentaEliminada: true }));
  });

  it('devuelve 404 si el usuario no existe', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await getUserForAdmin(fakeReq({ id: 'no-existe' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_NOT_FOUND' }));
  });
});

describe('toggleUserActive', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bloquea a un usuario normal activo (activo: true -> false)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(usuarioBase());
    mockPrisma.user.update.mockResolvedValue(usuarioBase({ activo: false }));
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'user-1' }, 'admin-1'), res);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { activo: false },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ activo: false }));
    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        accion: 'bloquear_usuario',
        entidadTipo: 'user',
        entidadId: 'user-1',
        estadoAnterior: 'true',
        estadoNuevo: 'false',
      })
    );
  });

  it('activa a un usuario bloqueado (activo: false -> true) si no fue una cuenta autoeliminada', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(usuarioBase({ activo: false }));
    mockPrisma.user.update.mockResolvedValue(usuarioBase({ activo: true }));
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'user-1' }, 'admin-1'), res);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { activo: true },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ activo: true }));
    expect(mockRegistrarAccionAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'activar_usuario', estadoAnterior: 'false', estadoNuevo: 'true' })
    );
  });

  it('devuelve 404 si el usuario no existe', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'no-existe' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_NOT_FOUND' }));
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
  });

  // Regla explícita del bloque: un admin no puede cambiar el estado de
  // su propia cuenta desde este endpoint (evita bloquearse a sí mismo).
  it('rechaza que un admin cambie el estado de su propia cuenta', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(usuarioBase({ id: 'admin-1', role: 'admin' }));
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'admin-1' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADMIN_CANNOT_TOGGLE_SELF' }));
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
  });

  // Regla explícita del bloque: no se puede dejar la plataforma sin
  // ningún admin activo. Se cuenta en cada llamada, no se asume "solo
  // hay 1" — el objetivo es al único ADMIN ACTIVO en ese momento.
  it('rechaza desactivar al único administrador activo', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      usuarioBase({ id: 'admin-2', role: 'admin', firebaseUid: 'uid-admin-2' })
    );
    mockPrisma.user.count.mockResolvedValue(1); // adminsActivos
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'admin-2' }, 'admin-1'), res);

    expect(mockPrisma.user.count).toHaveBeenCalledWith({ where: { role: 'admin', activo: true } });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADMIN_CANNOT_BLOCK_LAST_ADMIN' }));
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
  });

  it('permite desactivar a un admin si hay más de un administrador activo', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      usuarioBase({ id: 'admin-2', role: 'admin', firebaseUid: 'uid-admin-2' })
    );
    mockPrisma.user.count.mockResolvedValue(2);
    mockPrisma.user.update.mockResolvedValue(
      usuarioBase({ id: 'admin-2', role: 'admin', activo: false })
    );
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'admin-2' }, 'admin-1'), res);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'admin-2' },
      data: { activo: false },
    });
  });

  // Regla adyacente encontrada durante la investigación (no estaba en
  // el encargo original): `activo:false` también lo pone deleteMe
  // (borrado RGPD) junto con firebaseUid:null — sin este chequeo, un
  // admin podría "reactivar" una cuenta que el propio usuario eliminó.
  it('rechaza reactivar una cuenta que el propio usuario eliminó (RGPD)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      usuarioBase({ activo: false, firebaseUid: null, nombre: 'Usuario eliminado', email: null })
    );
    const res = fakeRes();

    await toggleUserActive(fakeReq({ id: 'user-1' }, 'admin-1'), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ADMIN_CANNOT_REACTIVATE_DELETED_ACCOUNT' })
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockRegistrarAccionAdmin).not.toHaveBeenCalled();
  });
});
