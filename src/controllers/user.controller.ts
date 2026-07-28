import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';

/**
 * Perfil genérico del usuario autenticado — vale para cualquier rol.
 * El perfil de profesional (oficio, tarifa, verificación...) sigue
 * viviendo aparte en professional.controller.ts; esto es solo lo común
 * a todos: nombre, email, teléfono, foto.
 */
export async function getMe(req: Request, res: Response) {
  const userId = req.user!.userId;

  const usuario = await prisma.user.findUnique({ where: { id: userId } });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  return res.json({
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    telefono: usuario.telefono,
    fotoPerfilUrl: usuario.fotoPerfilUrl,
    role: usuario.role,
  });
}

const updateMeSchema = z.object({
  nombre: z.string().min(2).max(150).optional(),
  telefono: z.string().max(30).optional(),
  fotoPerfilUrl: z.string().url().optional(),
});

/**
 * El email NO se puede editar aquí a propósito: está atado a la
 * identidad de Firebase Auth (ver auth.controller.ts) — cambiarlo
 * necesitaría un flujo de re-verificación que no existe todavía.
 */
export async function updateMe(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const usuario = await prisma.user.update({ where: { id: userId }, data: parsed.data });

  return res.json({
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    telefono: usuario.telefono,
    fotoPerfilUrl: usuario.fotoPerfilUrl,
    role: usuario.role,
  });
}
