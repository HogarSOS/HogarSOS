import { Request, Response } from 'express';
import { prisma } from '../config/prisma';

/**
 * Caché en memoria del catálogo de categorías. El catálogo es
 * prácticamente estático (cambia solo cuando un admin añade/renombra una
 * categoría, algo que ha pasado un puñado de veces en toda la vida del
 * proyecto), pero la app lo pide en CADA apertura de CADA usuario —
 * bajo una ráfaga de N aperturas eran N consultas idénticas a Supabase
 * compitiendo por el pool de 5 conexiones con las consultas que sí
 * dependen del usuario (medido en la auditoría de escalabilidad
 * 2026-08-17: 94 consultas idénticas en los primeros 9s a N=100).
 *
 * TTL corto (60s) en vez de invalidación explícita: el peor caso es que
 * una categoría recién creada por un admin tarde hasta 60s en aparecer
 * en el catálogo público — irrelevante en la práctica y sin ningún
 * acoplamiento nuevo entre el panel de admin y este módulo.
 */
const TTL_MS = 60 * 1000;
let cacheCategorias: { datos: unknown; expira: number } | null = null;

/** Solo para tests: fuerza la próxima lectura a ir a la base de datos. */
export function invalidarCacheCategorias(): void {
  cacheCategorias = null;
}

/** Endpoint público — no requiere autenticación, se usa antes del login para mostrar el catálogo. */
export async function listCategories(req: Request, res: Response) {
  const ahora = Date.now();
  if (cacheCategorias && cacheCategorias.expira > ahora) {
    return res.json(cacheCategorias.datos);
  }

  const categorias = await prisma.serviceCategory.findMany({
    where: { activo: true },
    orderBy: { nombre: 'asc' },
  });
  cacheCategorias = { datos: categorias, expira: ahora + TTL_MS };
  return res.json(categorias);
}
