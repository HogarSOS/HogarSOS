import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn(), update: jest.fn() },
    professional: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../config/firebase', () => ({
  firebaseAuth: { deleteUser: jest.fn() },
}));

jest.mock('../../config/stripe', () => ({
  stripe: {
    customers: { update: jest.fn() },
  },
}));

jest.mock('../../services/archivo.service', () => ({
  marcarArchivosDeUsuarioParaBorrado: jest.fn().mockResolvedValue(0),
}));

import { prisma } from '../../config/prisma';
import { firebaseAuth } from '../../config/firebase';
import { stripe } from '../../config/stripe';
import { deleteMe } from '../user.controller';

const mockPrisma = prisma as any;
const mockFirebaseAuth = firebaseAuth as any;
const mockStripe = stripe as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string): Request {
  return { user: { userId } } as unknown as Request;
}

describe('deleteMe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // La mayoría de los tests no necesitan que $transaction haga nada
    // real, solo que ejecute el callback que le pasa el controlador —
    // igual que haría Prisma de verdad con el mock de tx de abajo.
    mockPrisma.$transaction.mockImplementation(async (cb: any) =>
      cb({ user: mockPrisma.user, professional: mockPrisma.professional })
    );
  });

  /**
   * Cobertura nueva de la auditoría de cierre (2026-08-13): antes
   * deleteMe anonimizaba Postgres y borraba Firebase Auth, pero dejaba
   * el Customer de Stripe (nombre/email/teléfono reales) intacto para
   * siempre. Si alguien quita esta llamada sin querer, este test lo
   * detecta.
   */
  it('anonimiza el Customer de Stripe cuando el usuario tiene uno', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'cliente',
      firebaseUid: 'fb-1',
      stripeCustomerId: 'cus_123',
    });
    mockStripe.customers.update.mockResolvedValue({});

    const res = fakeRes();
    await deleteMe(fakeReq('u1'), res);

    expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_123', {
      name: 'Usuario eliminado',
      email: '',
      phone: '',
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('no llama a Stripe si el usuario nunca llegó a tener un Customer (sin pagos)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'cliente',
      firebaseUid: 'fb-1',
      stripeCustomerId: null,
    });

    const res = fakeRes();
    await deleteMe(fakeReq('u1'), res);

    expect(mockStripe.customers.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  /**
   * Igual que ya se hace con el fallo de Firebase (ver el catch de al
   * lado en el propio controlador): un fallo de Stripe al anonimizar
   * no debe impedir que el resto del borrado de cuenta se complete.
   */
  it('completa el borrado aunque Stripe falle al anonimizar el Customer', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'cliente',
      firebaseUid: 'fb-1',
      stripeCustomerId: 'cus_123',
    });
    mockStripe.customers.update.mockRejectedValue(new Error('Stripe caído'));

    const res = fakeRes();
    await deleteMe(fakeReq('u1'), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('borra el usuario de Firebase Auth cuando existe firebaseUid', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'cliente',
      firebaseUid: 'fb-1',
      stripeCustomerId: null,
    });

    await deleteMe(fakeReq('u1'), fakeRes());

    expect(mockFirebaseAuth.deleteUser).toHaveBeenCalledWith('fb-1');
  });

  it('anonimiza también el perfil de profesional cuando el rol es profesional', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'profesional',
      firebaseUid: 'fb-1',
      stripeCustomerId: null,
    });

    await deleteMe(fakeReq('u1'), fakeRes());

    expect(mockPrisma.professional.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: {
        documentoIdentidadUrl: null,
        certificadosUrl: [],
        seguroRcUrl: null,
        fotoPerfilUrl: null,
        descripcion: null,
        disponible: false,
      },
    });
  });

  it('no toca professional.update cuando el rol es cliente', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'cliente',
      firebaseUid: 'fb-1',
      stripeCustomerId: null,
    });

    await deleteMe(fakeReq('u1'), fakeRes());

    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
  });

  it('devuelve 404 si el usuario no existe', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await deleteMe(fakeReq('u1'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockStripe.customers.update).not.toHaveBeenCalled();
    expect(mockFirebaseAuth.deleteUser).not.toHaveBeenCalled();
  });
});
