import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Los imports de index.ts se ejecutan ANTES de su dotenv.config() — para
// poder ajustar DATABASE_URL aquí en el momento de construir el cliente,
// este módulo carga dotenv por sí mismo (idempotente: la llamada
// posterior de index.ts no pisa nada).
dotenv.config();

/**
 * Tamaño del pool de conexiones de Prisma contra Supabase.
 *
 * Histórico: `connection_limit=5` venía fijado dentro de DATABASE_URL
 * (2026-08-03). La auditoría de escalabilidad del 2026-08-17 demostró que
 * 5 conexiones (~50 consultas/s con ~100ms de RTT Oregón→Irlanda) son el
 * cuello exacto bajo ráfagas de apertura de 250 usuarios (83 q/s de
 * llegada → cola lineal hasta ~4,7s de latencia, con el endpoint cacheado
 * de categorías plano en ~220ms — la cola era solo del pool). Análisis
 * previo al cambio (regla del encargo, medido en producción):
 * Postgres max_connections=60 con 18 en uso; Supavisor en modo sesión con
 * pool_size 15; ejecución real de todas las consultas fusionadas <1ms —
 * subir a 10 NO mueve el cuello a Postgres (~10% de un core a 100 q/s) y
 * deja margen en Supavisor.
 *
 * Se sobreescribe AQUÍ, en código, en vez de editar el secreto
 * DATABASE_URL en Render: queda versionado, revisable y reversible con un
 * revert, sin manipular la URL con credenciales. `DB_CONNECTION_LIMIT`
 * permite ajustarlo por entorno sin deploy si algún día hace falta.
 */
const CONNECTION_LIMIT_POR_DEFECTO = 10;

export function urlConPoolAjustado(urlOriginal: string | undefined): string | undefined {
  if (!urlOriginal) return urlOriginal;
  try {
    const url = new URL(urlOriginal);
    const configurado = Number(process.env.DB_CONNECTION_LIMIT);
    const limite = Number.isInteger(configurado) && configurado > 0 && configurado <= 50
      ? configurado
      : CONNECTION_LIMIT_POR_DEFECTO;
    url.searchParams.set('connection_limit', String(limite));
    return url.toString();
  } catch {
    // URL no parseable — se deja tal cual y que Prisma dé su error real.
    return urlOriginal;
  }
}

/** Límite efectivo del pool — lo usa el pool warmer para calentar TODAS las conexiones. */
export function limiteDePool(): number {
  const efectiva = urlConPoolAjustado(process.env.DATABASE_URL);
  try {
    const n = Number(new URL(efectiva ?? '').searchParams.get('connection_limit'));
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // sin URL válida, valor conservador
  }
  return 5;
}

// Singleton de Prisma Client. Evita abrir múltiples pools de conexión
// en desarrollo (con hot-reload) y en producción.
declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

// Mutar process.env (en vez de pasar `datasources` explícitos) preserva
// la resolución perezosa original del engine de Prisma: con una URL
// ausente/ilegible el comportamiento es EXACTAMENTE el de antes.
const urlAjustada = urlConPoolAjustado(process.env.DATABASE_URL);
if (urlAjustada) process.env.DATABASE_URL = urlAjustada;

export const prisma = global.__prisma__ ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma__ = prisma;
}
