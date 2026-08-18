import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../auth.middleware';

const ENTORNO_ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = 'secreto-de-test-para-auth-middleware';
});

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(token?: string): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request;
}

describe('authMiddleware', () => {
  it('deja pasar un access token válido y expone req.user', () => {
    const token = jwt.sign({ userId: 'u1', role: 'cliente' }, process.env.JWT_SECRET as string);
    const req = fakeReq(token);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(expect.objectContaining({ userId: 'u1', role: 'cliente' }));
  });

  it('devuelve 401 sin cabecera Authorization', () => {
    const req = fakeReq();
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('devuelve 403 si el rol no está en la lista permitida', () => {
    const token = jwt.sign({ userId: 'u1', role: 'cliente' }, process.env.JWT_SECRET as string);
    const req = fakeReq(token);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware(['admin'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // Auditoría, hallazgo #8: un refresh token (30 días) firma con el
  // MISMO secreto que el access token y antes no se distinguía uno de
  // otro en este middleware — así que servía directamente como bearer
  // de la API, saltándose la expiración corta de 15 min pensada para el
  // access token.
  it('rechaza un refresh token usado como access token', () => {
    const refreshToken = jwt.sign(
      { userId: 'u1', role: 'cliente', type: 'refresh' },
      process.env.JWT_SECRET as string
    );
    const req = fakeReq(refreshToken);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('rechaza un token firmado con un algoritmo distinto de HS256', () => {
    // 'none' es el caso clásico de confusión de algoritmo: un token sin
    // firma en absoluto que jwt.verify aceptaría si no se restringe
    // `algorithms`.
    const tokenSinFirma = jwt.sign({ userId: 'u1', role: 'admin' }, '', { algorithm: 'none' });
    const req = fakeReq(tokenSinFirma);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // allowExpired (solo /auth/logout): el logout debe poder limpiar el
  // UserFcmToken de este dispositivo aunque el access token ya haya
  // caducado (máx. 15 min). Sin esto, authMiddleware devolvía 401 antes
  // de llegar al handler y el aparato deslogueado seguía recibiendo push.
  it('devuelve 401 con un token caducado cuando NO se permite expirado (por defecto)', () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'cliente' },
      process.env.JWT_SECRET as string,
      { expiresIn: '-1s' }
    );
    const req = fakeReq(token);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allowExpired: deja pasar un token caducado con firma válida y expone req.user', () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'cliente' },
      process.env.JWT_SECRET as string,
      { expiresIn: '-1s' }
    );
    const req = fakeReq(token);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware(undefined, { allowExpired: true })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(expect.objectContaining({ userId: 'u1', role: 'cliente' }));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allowExpired NO relaja la verificación de firma: token con otro secreto → 401', () => {
    const token = jwt.sign({ userId: 'u1', role: 'cliente' }, 'otro-secreto-distinto', {
      algorithm: 'HS256',
    });
    const req = fakeReq(token);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware(undefined, { allowExpired: true })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('allowExpired sigue rechazando un refresh token usado como access token', () => {
    const refreshToken = jwt.sign(
      { userId: 'u1', role: 'cliente', type: 'refresh' },
      process.env.JWT_SECRET as string
    );
    const req = fakeReq(refreshToken);
    const res = fakeRes();
    const next = jest.fn();

    authMiddleware(undefined, { allowExpired: true })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
