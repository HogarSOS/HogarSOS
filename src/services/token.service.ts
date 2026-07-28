import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

// Diagnóstico: comprobar si el .env se ha cargado correctamente, sin
// filtrar el secreto en sí a los logs (en Render los logs son
// exportables/visibles al equipo, no solo a quien arranca el proceso).
console.log('========================================');
console.log('JWT_SECRET definido =', !!process.env.JWT_SECRET);
console.log('JWT_EXPIRES_IN =', process.env.JWT_EXPIRES_IN);
console.log('JWT_REFRESH_EXPIRES_IN =', process.env.JWT_REFRESH_EXPIRES_IN);
console.log('========================================');

interface TokenPayload {
  userId: string;
  role: UserRole;
}

const JWT_SECRET = process.env.JWT_SECRET as string;
const ACCESS_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

export function generateAccessToken(payload: TokenPayload): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET no está definido');
  }

  return jwt.sign(payload, JWT_SECRET, {
    // @types/jsonwebtoken tipa expiresIn como un literal de unión (vía
    // el paquete `ms`), no como `string` genérico — pero el valor real
    // sigue viniendo de una env var en tiempo de ejecución, así que el
    // chequeo de tipos no puede validarlo de verdad. El cast documenta
    // esa realidad en vez de fingir que TS lo está comprobando.
    expiresIn: ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function generateRefreshToken(payload: TokenPayload): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET no está definido');
  }

  return jwt.sign(
    {
      ...payload,
      type: 'refresh',
    },
    JWT_SECRET,
    {
      expiresIn: REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    }
  );
}

export function verifyRefreshToken(token: string): TokenPayload {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET no está definido');
  }

  const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload & {
    type?: string;
  };

  if (decoded.type !== 'refresh') {
    throw new Error('El token proporcionado no es un refresh token válido');
  }

  return {
    userId: decoded.userId,
    role: decoded.role,
  };
}