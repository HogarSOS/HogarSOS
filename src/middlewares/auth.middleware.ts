import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

interface JwtPayload {
  userId: string;
  role: UserRole;
}

declare global {
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
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const token = authHeader.split(' ')[1];

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
      req.user = payload;

      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'No tienes permiso para esta acción' });
      }

      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  };
}
