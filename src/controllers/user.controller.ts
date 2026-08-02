import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';

function serializarUsuario(usuario: {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  fotoPerfilUrl: string | null;
  role: string;
  valoracionMedia: unknown;
  totalValoraciones: number;
}) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    telefono: usuario.telefono,
    fotoPerfilUrl: usuario.fotoPerfilUrl,
    role: usuario.role,
    valoracionMedia: Number(usuario.valoracionMedia),
    totalValoraciones: usuario.totalValoraciones,
  };
}

/**
 * Perfil genérico del usuario autenticado — vale para cualquier rol.
 * El perfil de profesional (oficio, tarifa, verificación...) sigue
 * viviendo aparte en professional.controller.ts; esto es solo lo común
 * a todos: nombre, email, teléfono, foto, valoración recibida (como
 * cliente que contrata, o como profesional — ver review.controller.ts,
 * que actualiza estos mismos campos sea cual sea el rol).
 */
export async function getMe(req: Request, res: Response) {
  const userId = req.user!.userId;

  const usuario = await prisma.user.findUnique({ where: { id: userId } });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
  }

  return res.json(serializarUsuario(usuario));
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
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const usuario = await prisma.user.update({ where: { id: userId }, data: parsed.data });

  return res.json(serializarUsuario(usuario));
}

/**
 * Valoraciones recibidas por el usuario autenticado — vale tanto para
 * un cliente (valorado por profesionales) como para un profesional
 * (aunque este último normalmente las ve desde su propio perfil de
 * profesional, ver professional.controller.ts::getProfile).
 */
export async function getMisValoraciones(req: Request, res: Response) {
  const userId = req.user!.userId;

  const reviews = await prisma.review.findMany({
    where: { destinatarioId: userId },
    include: { autor: { select: { nombre: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return res.json({
    opiniones: reviews.map((r) => ({
      autor: r.autor.nombre,
      puntuacion: r.puntuacion,
      comentario: r.comentario,
      fecha: r.createdAt,
    })),
  });
}
