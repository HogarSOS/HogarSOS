import jwt from 'jsonwebtoken';

const ENTORNO_ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = 'secreto-de-test-para-token-service';
  jest.resetModules();
});

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

describe('token.service', () => {
  it('genera y verifica un refresh token válido', () => {
    // require() a propósito, no un import estático: token.service lee
    // JWT_SECRET en el top-level del módulo, así que necesita
    // recargarse (jest.resetModules() en beforeEach) DESPUÉS de fijar
    // el env var de este test — un import estático solo se ejecutaría
    // una vez, con el JWT_SECRET del primer test que corra.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { generateRefreshToken, verifyRefreshToken } = require('../token.service');
    const token = generateRefreshToken({ userId: 'u1', role: 'cliente' });

    const payload = verifyRefreshToken(token);

    expect(payload).toEqual({ userId: 'u1', role: 'cliente' });
  });

  it('rechaza un access token (sin type: "refresh") pasado como refresh token', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { generateAccessToken, verifyRefreshToken } = require('../token.service');
    const accessToken = generateAccessToken({ userId: 'u1', role: 'cliente' });

    expect(() => verifyRefreshToken(accessToken)).toThrow('El token proporcionado no es un refresh token válido');
  });

  // Mismo hallazgo de confusión de algoritmo que auth.middleware.test.ts
  // (auditoría, hallazgo #2/#8), pero en el otro punto de entrada que
  // verifica JWTs: el endpoint público POST /auth/refresh.
  it('rechaza un refresh token firmado con un algoritmo distinto de HS256', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyRefreshToken } = require('../token.service');
    const tokenSinFirma = jwt.sign({ userId: 'u1', role: 'admin', type: 'refresh' }, '', { algorithm: 'none' });

    expect(() => verifyRefreshToken(tokenSinFirma)).toThrow();
  });
});
