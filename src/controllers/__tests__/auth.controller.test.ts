import { Request, Response } from 'express';

const mockTx = {
  user: { create: jest.fn(), update: jest.fn() },
  professional: { create: jest.fn() },
  userFcmToken: { deleteMany: jest.fn(), upsert: jest.fn() },
};

jest.mock('../../config/prisma', () => ({
  prisma: {
    user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    // updateFcmToken ya NO usa $transaction (auditoría de escalabilidad
    // 2026-08-17): hace upsert + deleteMany directos sobre prisma para no
    // retener el pool bajo ráfaga. Estos mocks son los que ejercita ahora.
    userFcmToken: { upsert: jest.fn(), deleteMany: jest.fn() },
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
import { register, login, forgotPassword, refreshToken, logout, updateFcmToken } from '../auth.controller';

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

function fakeAuthedReqConBody(userId: string, body: Record<string, unknown>): Request {
  return { user: { userId, role: 'cliente' }, body } as unknown as Request;
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

  // P2 #6, caso 4: OTRA identidad de Firebase (firebaseUid distinto)
  // intentando usar un email ya registrado por otra cuenta — conflicto
  // real, no un reintento de la misma persona.
  it('devuelve 409 sin tocar la transacción si el email/teléfono ya existe bajo OTRO firebaseUid', async () => {
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-nuevo', email: 'existente@example.com' });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-3', email: 'existente@example.com', createdAt: new Date(), firebaseUid: 'fb-uid-3-original' });
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

  describe('P2 #6 — idempotencia por firebaseUid', () => {
    // Caso central: la respuesta de un registro anterior se perdió,
    // pero Postgres ya tiene la fila — un reintento con el MISMO
    // firebaseUid debe recuperar la cuenta, no chocar contra un 409.
    it('mismo firebaseUid ya existente → éxito idempotente (200), sin crear nada nuevo', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-existente', email: 'ya-registrado@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-existente', email: 'ya-registrado@example.com', nombre: 'Ya Registrado', role: 'cliente',
        firebaseUid: 'fb-uid-existente', sessionVersion: 2, activo: true, createdAt: new Date(),
      });
      const res = fakeRes();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Ya Registrado', role: 'cliente' }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', usuario: expect.objectContaining({ id: 'user-existente' }) })
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.professional.create).not.toHaveBeenCalled();
    });

    // El match por firebaseUid manda por encima de cualquier otra
    // comparación — aunque el email decodificado del token actual no
    // coincida textualmente con el guardado (ej. el usuario lo cambió
    // en Firebase), sigue siendo la MISMA identidad.
    it('mismo firebaseUid con email decodificado distinto al guardado → sigue siendo éxito idempotente', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-existente', email: 'email-nuevo@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-existente', email: 'email-viejo@example.com', nombre: 'Ya Registrado', role: 'cliente',
        firebaseUid: 'fb-uid-existente', sessionVersion: 0, activo: true, createdAt: new Date(),
      });
      const res = fakeRes();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Ya Registrado', role: 'cliente' }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('el reintento idempotente usa la sessionVersion ACTUAL de la fila, no 0', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-existente', email: 'ya-registrado@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-existente', email: 'ya-registrado@example.com', nombre: 'Ya Registrado', role: 'cliente',
        firebaseUid: 'fb-uid-existente', sessionVersion: 3, activo: true, createdAt: new Date(),
      });
      const res = fakeRes();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Ya Registrado', role: 'cliente' }), res);

      expect(mockGenerateRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-existente', sessionVersion: 3 })
      );
    });

    // Carrera: dos /register simultáneos con el mismo firebaseUid — el
    // findFirst de ambos no vio todavía la fila del otro. El perdedor
    // choca contra UNIQUE(firebase_uid) en el create.
    it('P2002 en create por firebaseUid → relee y resuelve con el mismo éxito idempotente', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-carrera', email: 'carrera@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue(null); // no lo vio venir
      const p2002: any = new Error('Unique constraint failed on the fields: (`firebase_uid`)');
      p2002.code = 'P2002';
      mockPrisma.$transaction.mockRejectedValueOnce(p2002);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-ganador', email: 'carrera@example.com', nombre: 'Ganador', role: 'cliente',
        firebaseUid: 'fb-uid-carrera', sessionVersion: 0, activo: true,
      });
      const res = fakeRes();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Perdedor', role: 'cliente' }), res);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { firebaseUid: 'fb-uid-carrera' } });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ usuario: expect.objectContaining({ id: 'user-ganador' }) }));
      expect(mockTx.professional.create).not.toHaveBeenCalled(); // nunca llegó a ejecutar el segundo paso de la transacción del perdedor
    });

    // Si la relectura no encuentra nada con ESTE firebaseUid (el P2002
    // fue por otra causa, ej. email/teléfono chocando con OTRA
    // identidad), no hay nada seguro que devolver — se propaga tal cual.
    it('P2002 sin fila recuperable para este firebaseUid → propaga el error, sin más reintentos', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-sin-suerte', email: 'sin-suerte@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const p2002: any = new Error('Unique constraint failed on the fields: (`email`)');
      p2002.code = 'P2002';
      mockPrisma.$transaction.mockRejectedValueOnce(p2002);
      mockPrisma.user.findUnique.mockResolvedValue(null); // no existe fila con ESTE firebaseUid
      const res = fakeRes();

      await expect(
        register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Sin Suerte', role: 'cliente' }), res)
      ).rejects.toBe(p2002);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1); // un único intento de relectura, sin bucle
    });

    it('un error de la transacción que NO es P2002 se propaga sin intentar relectura', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-db-caida', email: 'db-caida@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const errorConexion: any = new Error('Conexión a la base de datos perdida');
      errorConexion.code = 'P1001';
      mockPrisma.$transaction.mockRejectedValueOnce(errorConexion);
      const res = fakeRes();

      await expect(
        register(fakeReq({ firebaseIdToken: 'tok', nombre: 'DB Caída', role: 'cliente' }), res)
      ).rejects.toBe(errorConexion);

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  // Regresión encontrada en la revisión adversarial de P2 #6: el camino
  // idempotente puede devolver tokens para un User existente, así que
  // necesita el MISMO control de activo que ya tiene login() — sin él,
  // un reintento de /register tras una desactivación se lo saltaría.
  describe('P2 #6 — AUTH_ACCOUNT_DISABLED en los caminos idempotentes', () => {
    it('findFirst idempotente + activo=true → 200 normal', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-activo', email: 'activo@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-activo', email: 'activo@example.com', nombre: 'Activo', role: 'cliente',
        firebaseUid: 'fb-uid-activo', sessionVersion: 0, activo: true, createdAt: new Date(),
      });
      const res = fakeRes();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Activo', role: 'cliente' }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fake-access-token' }));
    });

    it('findFirst idempotente + activo=false → 403 AUTH_ACCOUNT_DISABLED, sin tokens', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-desactivado', email: 'desactivado@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-desactivado', email: 'desactivado@example.com', nombre: 'Desactivado', role: 'cliente',
        firebaseUid: 'fb-uid-desactivado', sessionVersion: 0, activo: false, createdAt: new Date(),
      });
      const res = fakeRes();
      mockGenerateRefreshToken.mockClear();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Desactivado', role: 'cliente' }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_ACCOUNT_DISABLED' }));
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.anything() }));
      expect(mockGenerateRefreshToken).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.professional.create).not.toHaveBeenCalled();
    });

    it('carrera P2002 recuperada + activo=true → 200 normal', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-carrera-activo', email: 'carrera-activo@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const p2002: any = new Error('Unique constraint failed on the fields: (`firebase_uid`)');
      p2002.code = 'P2002';
      mockPrisma.$transaction.mockRejectedValueOnce(p2002);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-ganador-activo', email: 'carrera-activo@example.com', nombre: 'Ganador', role: 'cliente',
        firebaseUid: 'fb-uid-carrera-activo', sessionVersion: 0, activo: true,
      });
      const res = fakeRes();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Perdedor', role: 'cliente' }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ usuario: expect.objectContaining({ id: 'user-ganador-activo' }) }));
    });

    it('carrera P2002 recuperada + activo=false → 403 AUTH_ACCOUNT_DISABLED, sin tokens', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-carrera-desactivado', email: 'carrera-desactivado@example.com' });
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const p2002: any = new Error('Unique constraint failed on the fields: (`firebase_uid`)');
      p2002.code = 'P2002';
      mockPrisma.$transaction.mockRejectedValueOnce(p2002);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-ganador-desactivado', email: 'carrera-desactivado@example.com', nombre: 'Ganador', role: 'cliente',
        firebaseUid: 'fb-uid-carrera-desactivado', sessionVersion: 0, activo: false,
      });
      const res = fakeRes();
      mockGenerateRefreshToken.mockClear();

      await register(fakeReq({ firebaseIdToken: 'tok', nombre: 'Perdedor', role: 'cliente' }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_ACCOUNT_DISABLED' }));
      expect(mockGenerateRefreshToken).not.toHaveBeenCalled();
      expect(mockTx.professional.create).not.toHaveBeenCalled();
    });
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
    const res = fakeRes();

    await logout(fakeAuthedReq('user-1'), res);

    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  // Doble tap / dos pestañas: cada llamada debe completarse sin error,
  // sin depender de leer y comparar un valor previo (por eso `increment`
  // atómico y no un findUnique+update).
  it('es idempotente en el sentido de que no falla si se llama dos veces seguidas', async () => {
    const res1 = fakeRes();
    const res2 = fakeRes();

    await logout(fakeAuthedReq('user-1'), res1);
    await logout(fakeAuthedReq('user-1'), res2);

    expect(mockTx.user.update).toHaveBeenCalledTimes(2);
    expect(res1.json).toHaveBeenCalledWith({ success: true });
    expect(res2.json).toHaveBeenCalledWith({ success: true });
  });

  // P2 #5: logout ahora también borra el UserFcmToken de ESTA instalación.
  it('con installationId: borra SOLO el UserFcmToken de esa instalación', async () => {
    const res = fakeRes();

    await logout(fakeAuthedReqConBody('user-A', { installationId: 'inst-A' }), res);

    expect(mockTx.userFcmToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-A', installationId: 'inst-A' },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('sin installationId (compatibilidad con cliente antiguo): no falla y no borra ningún UserFcmToken', async () => {
    const res = fakeRes();

    await logout(fakeAuthedReq('user-1'), res);

    expect(mockTx.userFcmToken.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  // El caso que exige el diseño: logout del dispositivo A nunca puede
  // afectar a los UserFcmToken de otros dispositivos (B, C) del mismo
  // usuario — el WHERE va por (userId, installationId) de ESTE
  // dispositivo, nunca por userId solo.
  it('logout del dispositivo A no puede borrar los tokens de B/C (el WHERE incluye el installationId exacto)', async () => {
    const res = fakeRes();

    await logout(fakeAuthedReqConBody('user-1', { installationId: 'inst-A' }), res);

    const llamada = mockTx.userFcmToken.deleteMany.mock.calls[0][0];
    expect(llamada.where).toEqual({ userId: 'user-1', installationId: 'inst-A' });
    expect(llamada.where.installationId).not.toBe('inst-B');
    expect(llamada.where.installationId).not.toBe('inst-C');
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

    // 2) logout: sube a sessionVersion 1 (simulado — este test unitario no
    // comparte estado real de BD entre pasos, el paso 3 fija la nueva
    // versión a mano en el mock de findUnique)
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

describe('updateFcmToken (P2 #5) — sin transacción interactiva (fix de pool, 2026-08-17)', () => {
  it('caso común (sin conflicto de token): SOLO upsert, sin deleteMany (una sentencia, media carga de pool)', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_A', installationId: 'inst-A' }), res);

    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledWith({
      where: { userId_installationId: { userId: 'user-1', installationId: 'inst-A' } },
      update: { token: 'TOKEN_A' },
      create: { userId: 'user-1', installationId: 'inst-A', token: 'TOKEN_A' },
    });
    // El deleteMany solo se ejecuta en el caso raro de colisión de token (P2002).
    expect(mockPrisma.userFcmToken.deleteMany).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  // El fix de pool: updateFcmToken ya NO debe abrir una transacción
  // interactiva (retenía una conexión durante 4 round-trips y agotaba el
  // pool bajo ráfaga — 219 errores 5xx medidos). Son 2 sentencias
  // autocommit independientes.
  it('NO usa prisma.$transaction (evita retener el pool bajo ráfaga)', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_A', installationId: 'inst-A' }), res);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rotación del token: mismo (userId, installationId), token nuevo → misma clave, token actualizado', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_VIEJO', installationId: 'inst-A' }), res);
    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_NUEVO', installationId: 'inst-A' }), res);

    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledTimes(2);
    const ultimaLlamada = mockPrisma.userFcmToken.upsert.mock.calls[1][0];
    expect(ultimaLlamada.where.userId_installationId).toEqual({ userId: 'user-1', installationId: 'inst-A' });
    expect(ultimaLlamada.update).toEqual({ token: 'TOKEN_NUEVO' });
  });

  // El hallazgo central de P2 #5 (dispositivo compartido/reutilizado): un
  // mismo token físico reclamado por otra (userId, installationId) choca
  // con UNIQUE(token) → el upsert lanza P2002 → SOLO entonces se cede la
  // fila anterior (deleteMany) y se reintenta. Limpieza perezosa.
  it('mismo token reclamado por otro usuario: el upsert P2002 dispara deleteMany + retry (cesión perezosa)', async () => {
    const res = fakeRes();
    const p2002: any = new Error('Unique constraint failed on the fields: (`token`)');
    p2002.code = 'P2002';
    mockPrisma.userFcmToken.upsert.mockRejectedValueOnce(p2002);

    await updateFcmToken(fakeAuthedReqConBody('user-B', { fcmToken: 'TOKEN_COMPARTIDO', installationId: 'inst-compartida' }), res);

    expect(mockPrisma.userFcmToken.deleteMany).toHaveBeenCalledWith({
      where: { token: 'TOKEN_COMPARTIDO', NOT: { userId: 'user-B', installationId: 'inst-compartida' } },
    });
    // Orden: primer upsert (falla) → deleteMany → segundo upsert.
    const ordenUpsert1 = mockPrisma.userFcmToken.upsert.mock.invocationCallOrder[0];
    const ordenDeleteMany = mockPrisma.userFcmToken.deleteMany.mock.invocationCallOrder[0];
    const ordenUpsert2 = mockPrisma.userFcmToken.upsert.mock.invocationCallOrder[1];
    expect(ordenUpsert1).toBeLessThan(ordenDeleteMany);
    expect(ordenDeleteMany).toBeLessThan(ordenUpsert2);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('sin installationId (cliente antiguo): usa "legacy" y no rompe el endpoint', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_CLIENTE_VIEJO' }), res);

    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_installationId: { userId: 'user-1', installationId: 'legacy' } } })
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('devuelve 400 si falta fcmToken, sin tocar la BD', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { installationId: 'inst-A' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.userFcmToken.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.userFcmToken.upsert).not.toHaveBeenCalled();
  });

  it('dos instalaciones del mismo usuario producen dos filas independientes (claves distintas)', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_A', installationId: 'inst-A' }), res);
    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_B', installationId: 'inst-B' }), res);

    const [clave1, clave2] = mockPrisma.userFcmToken.upsert.mock.calls.map((c: any) => c[0].where.userId_installationId);
    expect(clave1).not.toEqual(clave2);
    expect(clave1.installationId).toBe('inst-A');
    expect(clave2.installationId).toBe('inst-B');
  });
});

describe('updateFcmToken — retry en P2002 sin transacción (revisión adversarial P2 #5 + fix de pool)', () => {
  function p2002(): any {
    const err: any = new Error('Unique constraint failed on the fields: (`token`)');
    err.code = 'P2002';
    return err;
  }

  // El upsert choca con UNIQUE(token) (el token estaba en otra fila) → se
  // cede (deleteMany, UNA vez) y se reintenta el upsert con éxito.
  it('P2002 en el upsert → deleteMany (una vez) + retry upsert, completa con éxito', async () => {
    const res = fakeRes();
    mockPrisma.userFcmToken.upsert.mockRejectedValueOnce(p2002());

    await updateFcmToken(fakeAuthedReqConBody('user-B', { fcmToken: 'TOKEN_COMPARTIDO', installationId: 'inst-B' }), res);

    // deleteMany solo una vez (la cesión); upsert dos veces (fallo + retry).
    expect(mockPrisma.userFcmToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.userFcmToken.upsert).toHaveBeenLastCalledWith({
      where: { userId_installationId: { userId: 'user-B', installationId: 'inst-B' } },
      update: { token: 'TOKEN_COMPARTIDO' },
      create: { userId: 'user-B', installationId: 'inst-B', token: 'TOKEN_COMPARTIDO' },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('P2002 persistente en ambos intentos → se propaga el error, sin un tercer intento', async () => {
    const res = fakeRes();
    const error = p2002();
    // Dos Once (no un mockRejectedValue persistente): se consumen en los
    // dos intentos y no filtran al test siguiente (clearAllMocks limpia
    // las llamadas pero NO las implementaciones persistentes).
    mockPrisma.userFcmToken.upsert.mockRejectedValueOnce(error).mockRejectedValueOnce(error);

    await expect(
      updateFcmToken(fakeAuthedReqConBody('user-B', { fcmToken: 'TOKEN_COMPARTIDO', installationId: 'inst-B' }), res)
    ).rejects.toBe(error);

    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledTimes(2);
  });

  it('un error de Prisma que NO es P2002 se propaga de inmediato, sin ceder ni reintentar', async () => {
    const res = fakeRes();
    const error: any = new Error('Conexión a la base de datos perdida');
    error.code = 'P1001';
    mockPrisma.userFcmToken.upsert.mockRejectedValueOnce(error);

    await expect(
      updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_A', installationId: 'inst-A' }), res)
    ).rejects.toBe(error);

    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.userFcmToken.deleteMany).not.toHaveBeenCalled();
  });

  it('comportamiento normal (sin colisión): SOLO upsert, sin deleteMany ni reintento', async () => {
    const res = fakeRes();

    await updateFcmToken(fakeAuthedReqConBody('user-1', { fcmToken: 'TOKEN_NORMAL', installationId: 'inst-A' }), res);

    expect(mockPrisma.userFcmToken.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.userFcmToken.upsert).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
