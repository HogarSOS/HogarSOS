import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

interface JwtPayload {
  userId: string;
  role: UserRole;
  // Solo presente en un refresh token (ver token.service.ts). Un access
  // token nunca lo lleva.
  type?: string;
}

declare global {
  // Namespace obligatorio aquí: es la única forma que ofrece TypeScript
  // de aumentar los tipos ambient de un módulo de terceros (Express) —
  // no hay equivalente en sintaxis de módulos ES2015 para esto.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Middleware de autenticación. Si se pasan roles, restringe el acceso
 * a esos roles únicamente (RBAC a nivel de ruta, complementario al
 * row-level security de PostgreSQL).
 */
export function authMiddleware(allowedRoles?: JwtPayload['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token no proporcionado', code: 'AUTH_TOKEN_MISSING' });
    }

    const token = authHeader.split(' ')[1];

    try {
      // algorithms fijado: sin esto, jwt.verify acepta cualquier
      // algoritmo que el propio token declare en su cabecera — jsonwebtoken
      // en concreto es vulnerable a la confusión RS256/HS256 si alguna vez
      // se introduce una clave pública en otro sitio del código. Fijarlo
      // aquí es defensa en profundidad barata (auditoría, hallazgo #2).
      const payload = jwt.verify(token, process.env.JWT_SECRET as string, { algorithms: ['HS256'] }) as JwtPayload;

      // Un refresh token (30 días) lleva `type: 'refresh'` y firma con el
      // MISMO secreto que el access token (ver token.service.ts) — sin
      // este chequeo, cualquiera con un refresh token podía usarlo
      // directamente como access token, saltándose por completo la
      // expiración corta de 15 min pensada para la API (auditoría,
      // hallazgo #8).
      if (payload.type === 'refresh') {
        return res.status(401).json({ error: 'Token inválido o expirado', code: 'AUTH_TOKEN_INVALID' });
      }

      req.user = payload;

      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'No tienes permiso para esta acción', code: 'AUTH_FORBIDDEN' });
      }

      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido o expirado', code: 'AUTH_TOKEN_INVALID' });
    }
  };
}
