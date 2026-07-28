import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';

const createReviewSchema = z.object({
  serviceRequestId: z.string().uuid(),
  puntuacion: z.number().int().min(1).max(5),
  comentario: z.string().max(1000).optional(),
});

/**
 * Crea una valoración. Solo el cliente puede valorar (al profesional),
 * y solo sobre una solicitud ya completada y que no tenga valoración previa.
 * Tras crearla, recalcula la media del profesional.
 */
export async function createReview(req: Request, res: Response) {
  const parsed = createReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const { serviceRequestId, puntuacion, comentario } = parsed.data;
  const autorId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id: serviceRequestId },
    include: { review: true },
  });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== autorId) {
    return res.status(403).json({ error: 'Solo el cliente de esta solicitud puede valorarla' });
  }
  if (solicitud.estado !== 'completada') {
    return res.status(409).json({ error: 'Solo se puede valorar un servicio ya completado' });
  }
  if (solicitud.review) {
    return res.status(409).json({ error: 'Esta solicitud ya tiene una valoración' });
  }
  if (!solicitud.profesionalId) {
    return res.status(409).json({ error: 'Esta solicitud no tiene profesional asignado' });
  }

  const resultado = await prisma.$transaction(async (tx) => {
    const review = await tx.review.create({
      data: {
        serviceRequestId,
        autorId,
        destinatarioId: solicitud.profesionalId as string,
        puntuacion,
        comentario,
      },
    });

    // Recalcula la media y el contador de trabajos del profesional a
    // partir de todas sus valoraciones — más simple y menos propenso a
    // errores de arrastre que ir acumulando un promedio incremental.
    const agregado = await tx.review.aggregate({
      where: { destinatarioId: solicitud.profesionalId as string },
      _avg: { puntuacion: true },
      _count: true,
    });

    await tx.professional.update({
      where: { userId: solicitud.profesionalId as string },
      data: {
        valoracionMedia: agregado._avg.puntuacion ?? puntuacion,
        totalTrabajos: agregado._count,
      },
    });

    return review;
  });

  return res.status(201).json(resultado);
}
