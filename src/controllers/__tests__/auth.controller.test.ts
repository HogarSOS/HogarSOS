import { Request, Response } from 'express';

const mockTx = {
  user: { create: jest.fn() },
  professional: { create: jest.fn() },
};

jest.mock('../../config/prisma', () => ({
  prisma: {
    user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
  },
}));

jest.mock('../../config/firebase', () => ({
  firebaseAuth: {
    verifyIdToken: jest.fn(),
    generatePasswordResetLink: jest.fn(),
  },
}));

jest.mock('../../services/email.service', () => ({
  enviarEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/token.service', () => ({
  generateAccessToken: jest.fn(() => 'fake-access-token'),
  generateRefreshToken: jest.fn(() => 'fake-refresh-token'),
  verifyRefreshToken: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { firebaseAuth } from '../../config/firebase';
import { enviarEmail } from '../../services/email.service';
import { verifyRefreshToken } from '../../services/token.service';
import { register, login, forgotPassword, refreshToken } from '../auth.controller';

const mockPrisma = prisma as any;
const mockFirebaseAuth = firebaseAuth as any;
const mockEnviarEmail = enviarEmail as jest.Mock;
const mockVerifyRefreshToken = verifyRefreshToken as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

beforeEach(() => jest.clearAllMocks());

describe('register', () => {
  it('crea el usuario (y su fila de profesional en la misma transacción) y devuelve tokens', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1', email: 'ana@example.com' });
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockTx.user.create.mockResolvedValue({ id: 'user-1', email: 'ana@example.com', nombre: 'Ana', role: 'profesional' });
    mockTx.professional.create.mockResolvedValue({});
    const res = fakeRes();

    await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Ana', role: 'profesional' }), res);

    expect(mockTx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'ana@example.com', firebaseUid: 'fb-uid-1', role: 'profesional' }) })
    );
    expect(mockTx.professional.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1' }) })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' })
    );
  });

  it('NO crea la fila de professional si el rol es cliente', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-2', email: 'bea@example.com' });
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockTx.user.create.mockResolvedValue({ id: 'user-2', email: 'bea@example.com', nombre: 'Bea', role: 'cliente' });
    const res = fakeRes();

    await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Bea', role: 'cliente' }), res);

    expect(mockTx.professional.create).not.toHaveBeenCalled();
  });

  it('devuelve 409 sin tocar la transacción si ya existe email/teléfono/firebaseUid', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-3', email: 'existente@example.com' });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-3', email: 'existente@example.com', createdAt: new Date(), firebaseUid: 'fb-uid-3' });
    const res = fakeRes();

    await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Existente', role: 'cliente' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_USER_ALREADY_EXISTS' }));
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('devuelve 401 si el token de Firebase no es válido', async () => {
    mockFirebaseAuth.verifyIdToken.mockRejectedValue(new Error('invalid token'));
    const res = fakeRes();

    await register(fakeReq({ firebaseIdToken: 'tok-malo', nombre: 'Xx', role: 'cliente' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_FIREBASE_TOKEN_INVALID' }));
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('devuelve 400 si el token de Firebase no trae ni email ni teléfono', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-4' });
    const res = fakeRes();

    await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Sin contacto', role: 'cliente' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_FIREBASE_TOKEN_NO_CONTACT' }));
  });
});

describe('login', () => {
  it('devuelve tokens para un usuario activo existente', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', nombre: 'Ana', role: 'cliente', activo: true });
    const res = fakeRes();

    await login(fakeReq({ firebaseIdToken: 'tok' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token' })
    );
  });

  it('devuelve 404 si no existe cuenta en Postgres para ese firebaseUid', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-desconocido' });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await login(fakeReq({ firebaseIdToken: 'tok' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_NO_ACCOUNT' }));
  });

  // Regla de negocio real: un admin puede desactivar una cuenta (o el
  // borrado RGPD la deja inactiva) — sin este check, un access token
  // recién emitido revive una cuenta que se supone bloqueada.
  it('devuelve 403 si la cuenta existe pero está desactivada', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-bloqueado' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-x', nombre: 'Bloqueado', role: 'cliente', activo: false });
    const res = fakeRes();

    await login(fakeReq({ firebaseIdToken: 'tok' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_ACCOUNT_DISABLED' }));
  });
});

describe('forgotPassword', () => {
  it('responde siempre {success:true} aunque el email no tenga cuenta (anti-enumeración)', async () => {
    mockFirebaseAuth.generatePasswordResetLink.mockRejectedValue({ code: 'auth/user-not-found' });
    const res = fakeRes();

    await forgotPassword(fakeReq({ email: 'no-existe@example.com' }), res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(mockEnviarEmail).not.toHaveBeenCalled();
  });

  it('responde {success:true} también cuando sí existe cuenta, y envía el email con el oobCode', async () => {
    mockFirebaseAuth.generatePasswordResetLink.mockResolvedValue(
      'https://firebase.example/action?mode=resetPassword&oobCode=ABC123'
    );
    const res = fakeRes();

    await forgotPassword(fakeReq({ email: 'ana@example.com' }), res);

    expect(mockEnviarEmail).toHaveBeenCalledWith(
      'ana@example.com',
      expect.any(String),
      expect.stringContaining('oobCode=ABC123')
    );
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('responde {success:true} incluso si el envío del email falla por otro motivo', async () => {
    mockFirebaseAuth.generatePasswordResetLink.mockRejectedValue(new Error('SMTP caído'));
    const res = fakeRes();

    await forgotPassword(fakeReq({ email: 'ana@example.com' }), res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('devuelve 400 si el email no tiene formato válido, sin llamar a Firebase', async () => {
    const res = fakeRes();

    await forgotPassword(fakeReq({ email: 'no-es-un-email' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFirebaseAuth.generatePasswordResetLink).not.toHaveBeenCalled();
  });
});

describe('refreshToken', () => {
  it('emite un nuevo access token si el usuario sigue existiendo y activo', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', role: 'cliente' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'cliente', activo: true });
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'valid-refresh' }), res);

    expect(res.json).toHaveBeenCalledWith({ accessToken: 'fake-access-token' });
  });

  // Este es justo el caso que motivó revalidar activo en refresh (ver
  // auditoría): una cuenta bloqueada entre medias no puede seguir
  // renovando su sesión indefinidamente.
  it('devuelve 403 si el usuario existe pero ya no está activo', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', role: 'cliente' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'cliente', activo: false });
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'valid-refresh' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_USER_INVALID' }));
  });

  it('devuelve 403 si el usuario ya no existe (cuenta borrada)', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-borrado', role: 'cliente' });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'valid-refresh' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_USER_INVALID' }));
  });

  it('devuelve 401 si el refresh token es inválido o expiró', async () => {
    mockVerifyRefreshToken.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'expirado-o-falso' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REFRESH_TOKEN_INVALID' }));
  });

  it('devuelve 400 si falta el refreshToken en el body', async () => {
    const res = fakeRes();

    await refreshToken(fakeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockVerifyRefreshToken).not.toHaveBeenCalled();
  });
});
