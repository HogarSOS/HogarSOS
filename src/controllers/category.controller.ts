import { Request, Response } from 'express';
import { prisma } from '../config/prisma';

/** Endpoint público — no requiere autenticación, se usa antes del login para mostrar el catálogo. */
export async function listCategories(req: Request, res: Response) {
  const categorias = await prisma.serviceCategory.findMany({
    where: { activo: true },
    orderBy: { nombre: 'asc' },
  });
  return res.json(categorias);
}
