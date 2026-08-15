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
import { generateRefreshToken, verifyRefreshToken } from '../../services/token.service';
import { register, login, forgotPassword, refreshToken, logout } from '../auth.controller';

const mockPrisma = prisma as any;
const mockFirebaseAuth = firebaseAuth as any;
const mockEnviarEmail = enviarEmail as jest.Mock;
const mockVerifyRefreshToken = verifyRefreshToken as jest.Mock;
const mockGenerateRefreshToken = generateRefreshToken as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

function fakeAuthedReq(userId: string): Request {
  return { user: { userId, role: 'cliente' } } as unknown as Request;
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

  // P2 #4: un usuario recién creado nace en sessionVersion 0 (el
  // default de la columna) — el refresh token que se le emite debe
  // llevar ese valor explícitamente, no depender del fallback `?? 0`
  // de /refresh para funcionar desde el primer login.
  it('el refresh token emitido incluye sessionVersion 0 para un usuario recién creado', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-5', email: 'nuevo@example.com' });
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockTx.user.create.mockResolvedValue({ id: 'user-5', email: 'nuevo@example.com', nombre: 'Nuevo', role: 'cliente', sessionVersion: 0 });
    const res = fakeRes();

    await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Nuevo', role: 'cliente' }), res);

    expect(mockGenerateRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-5', sessionVersion: 0 })
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

  // P2 #4: si el usuario ya cerró sesión antes (sessionVersion > 0), el
  // siguiente login debe emitir un refresh token con esa versión ACTUAL,
  // no con 0 — de lo contrario el token recién emitido sería inválido
  // en su propio primer /refresh.
  it('incluye la sessionVersion ACTUAL del usuario en el refresh token, no siempre 0', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', nombre: 'Ana', role: 'cliente', activo: true, sessionVersion: 3 });
    const res = fakeRes();

    await login(fakeReq({ firebaseIdToken: 'tok' }), res);

    expect(mockGenerateRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', sessionVersion: 3 })
    );
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

  // Auditoría P1 (2026-08-14): antes este error interpolaba el enlace
  // completo de Firebase (con el oobCode) en el mensaje, que console.error
  // volcaba tal cual a los logs de Render — un segundo camino de fuga del
  // mismo secreto que el logger global (ver sanitizarUrlParaLog.test.ts).
  it('si el enlace de Firebase no trae oobCode, el error registrado en logs no contiene el enlace completo', async () => {
    const linkSinOobCode = 'https://firebase.example/action?mode=resetPassword&otro=x';
    mockFirebaseAuth.generatePasswordResetLink.mockResolvedValue(linkSinOobCode);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();

    await forgotPassword(fakeReq({ email: 'ana@example.com' }), res);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedError = consoleErrorSpy.mock.calls[0][1] as Error;
    expect(loggedError.message).not.toContain(linkSinOobCode);
    expect(loggedError.message).not.toContain('firebase.example');
    expect(res.json).toHaveBeenCalledWith({ success: true });

    consoleErrorSpy.mockRestore();
  });
});

describe('refreshToken', () => {
  it('emite un nuevo access token si el usuario sigue existiendo y activo', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', role: 'cliente', sessionVersion: 0 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'cliente', activo: true, sessionVersion: 0 });
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'valid-refresh' }), res);

    expect(res.json).toHaveBeenCalledWith({ accessToken: 'fake-access-token' });
  });

  // P2 #4 — caso crítico de compatibilidad con el despliegue: un
  // refresh token emitido ANTES de este cambio no lleva sessionVersion
  // en absoluto (decoded.sessionVersion === undefined). Sin el
  // fallback `?? 0` en el controlador, esto desconectaría de golpe a
  // todo el que tuviera sesión activa en el momento de desplegar.
  it('un refresh token sin sessionVersion (emitido antes de este cambio) sigue funcionando si el usuario está en versión 0', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', role: 'cliente' }); // sin sessionVersion, como un token pre-migración
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'cliente', activo: true, sessionVersion: 0 });
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'valid-refresh-viejo' }), res);

    expect(res.json).toHaveBeenCalledWith({ accessToken: 'fake-access-token' });
  });

  // P2 #4: el caso que motiva todo el feature — tras un logout,
  // sessionVersion del usuario sube y el refresh token viejo (que
  // lleva la versión anterior) debe dejar de servir.
  it('devuelve 401 si el sessionVersion del token no coincide con el actual del usuario (sesión ya cerrada)', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', role: 'cliente', sessionVersion: 0 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'cliente', activo: true, sessionVersion: 1 });
    const res = fakeRes();

    await refreshToken(fakeReq({ refreshToken: 'valid-refresh-pero-revocado' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REFRESH_TOKEN_INVALID' }));
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

describe('logout', () => {
  it('incrementa atómicamente sessionVersion del usuario autenticado', async () => {
    mockPrisma.user.update.mockResolvedValue({ id: 'user-1', sessionVersion: 1 });
    const res = fakeRes();

    await logout(fakeAuthedReq('user-1'), res);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  // Doble tap / dos pestañas: cada llamada debe completarse sin error,
  // sin depender de leer y comparar un valor previo (por eso `increment`
  // atómico y no un findUnique+update).
  it('es idempotente en el sentido de que no falla si se llama dos veces seguidas', async () => {
    mockPrisma.user.update.mockResolvedValueOnce({ id: 'user-1', sessionVersion: 1 });
    mockPrisma.user.update.mockResolvedValueOnce({ id: 'user-1', sessionVersion: 2 });
    const res1 = fakeRes();
    const res2 = fakeRes();

    await logout(fakeAuthedReq('user-1'), res1);
    await logout(fakeAuthedReq('user-1'), res2);

    expect(mockPrisma.user.update).toHaveBeenCalledTimes(2);
    expect(res1.json).toHaveBeenCalledWith({ success: true });
    expect(res2.json).toHaveBeenCalledWith({ success: true });
  });
});

describe('login → logout → refresh (flujo real de revocación)', () => {
  // Extremo a extremo dentro del alcance de estos tests unitarios: la
  // versión que login emite hoy es la que /refresh comparará después
  // de un logout — este test encadena las tres funciones reales (no
  // solo la comparación aislada) para confirmar que el contrato entre
  // ellas es consistente.
  it('un refresh token emitido en login deja de servir tras logout, y uno emitido en un login POSTERIOR sí funciona', async () => {
    // 1) login inicial: usuario en sessionVersion 0
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-9' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-9', nombre: 'Cara', role: 'cliente', activo: true, sessionVersion: 0 });
    const resLogin1 = fakeRes();
    await login(fakeReq({ firebaseIdToken: 'tok' }), resLogin1);
    const tokenViejo = mockGenerateRefreshToken.mock.calls[mockGenerateRefreshToken.mock.calls.length - 1][0];
    expect(tokenViejo.sessionVersion).toBe(0);

    // 2) logout: sube a sessionVersion 1
    mockPrisma.user.update.mockResolvedValue({ id: 'user-9', sessionVersion: 1 });
    await logout(fakeAuthedReq('user-9'), fakeRes());

    // 3) refresh con el token viejo (sessionVersion 0) contra el usuario ya en versión 1 → 401
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-9', role: 'cliente', sessionVersion: tokenViejo.sessionVersion });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-9', role: 'cliente', activo: true, sessionVersion: 1 });
    const resRefresh = fakeRes();
    await refreshToken(fakeReq({ refreshToken: 'token-viejo' }), resRefresh);
    expect(resRefresh.status).toHaveBeenCalledWith(401);

    // 4) login de nuevo (segundo dispositivo, o el mismo tras el logout): emite versión 1, y ESE sí funciona
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-9', nombre: 'Cara', role: 'cliente', activo: true, sessionVersion: 1 });
    const resLogin2 = fakeRes();
    await login(fakeReq({ firebaseIdToken: 'tok' }), resLogin2);
    const tokenNuevo = mockGenerateRefreshToken.mock.calls[mockGenerateRefreshToken.mock.calls.length - 1][0];
    expect(tokenNuevo.sessionVersion).toBe(1);

    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-9', role: 'cliente', sessionVersion: tokenNuevo.sessionVersion });
    const resRefresh2 = fakeRes();
    await refreshToken(fakeReq({ refreshToken: 'token-nuevo' }), resRefresh2);
    expect(resRefresh2.json).toHaveBeenCalledWith({ accessToken: 'fake-access-token' });
  });
});
