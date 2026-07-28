import { PrismaClient } from '@prisma/client';

// Singleton de Prisma Client. Evita abrir múltiples pools de conexión
// en desarrollo (con hot-reload) y en producción.
declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

export const prisma = global.__prisma__ ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma__ = prisma;
}
