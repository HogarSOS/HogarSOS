import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';

const createReviewSchema = z.object({
  serviceRequestId: z.string().uuid(),
  puntuacion: z.number().int().min(1).max(5),
  comentario: z.string().max(1000).optional(),
});

/**
 * Crea una valoración — en cualquiera de los dos sentidos: cliente ->
 * profesional o profesional -> cliente. El sentido se deduce de quién
 * es el autor respecto a la solicitud (no hace falta que el cliente lo
 * indique explícitamente), y solo se acepta sobre una solicitud ya
 * completada, con como mucho una valoración por autor (constraint
 * único (serviceRequestId, autorId) en la base — ver schema.prisma).
 *
 * Tras crearla, recalcula la media y el contador del DESTINATARIO: en
 * `users` siempre (vale para cualquier rol), y también en
 * `professionals` cuando el destinatario es un profesional, porque el
 * resto de la app (búsqueda, perfil público de profesional) sigue
 * leyendo esos campos ahí — no se duplica lógica, solo se escribe en
 * los dos sitios que ya existían.
 */
export async function createReview(req: Request, res: Response) {
  const parsed = createReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const { serviceRequestId, puntuacion, comentario } = parsed.data;
  const autorId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id: serviceRequestId } });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.estado !== 'completada') {
    return res.status(409).json({ error: 'Solo se puede valorar un servicio ya completado' });
  }

  // Defensa en profundidad: el bloqueo principal ya lo da el estado
  // 'disputada' de arriba (createDispute lo pone así al abrir una
  // reclamación), pero esto cubre el hueco si algún día esos dos
  // campos llegaran a desincronizarse (p. ej. una resolución parcial).
  const disputaAbierta = await prisma.dispute.findFirst({
    where: { serviceRequestId, estado: 'abierta' },
  });
  if (disputaAbierta) {
    return res.status(409).json({ error: 'Existe una reclamación abierta — no se puede valorar hasta que se resuelva' });
  }

  let destinatarioId: string;
  if (solicitud.clienteId === autorId) {
    if (!solicitud.profesionalId) {
      return res.status(409).json({ error: 'Esta solicitud no tiene profesional asignado' });
    }
    destinatarioId = solicitud.profesionalId;
  } else if (solicitud.profesionalId === autorId) {
    destinatarioId = solicitud.clienteId;
  } else {
    return res.status(403).json({ error: 'No participaste en esta solicitud, no puedes valorarla' });
  }

  const existente = await prisma.review.findUnique({
    where: { serviceRequestId_autorId: { serviceRequestId, autorId } },
  });
  if (existente) {
    return res.status(409).json({ error: 'Ya has valorado esta solicitud' });
  }

  const resultado = await prisma.$transaction(async (tx) => {
    const review = await tx.review.create({
      data: { serviceRequestId, autorId, destinatarioId, puntuacion, comentario },
    });

    // Recalcula a partir de TODAS las valoraciones recibidas — más
    // simple y menos propenso a errores de arrastre que ir acumulando
    // un promedio incremental.
    const agregado = await tx.review.aggregate({
      where: { destinatarioId },
      _avg: { puntuacion: true },
      _count: true,
    });

    await tx.user.update({
      where: { id: destinatarioId },
      data: {
        valoracionMedia: agregado._avg.puntuacion ?? puntuacion,
        totalValoraciones: agregado._count,
      },
    });

    const destinatarioEsProfesional = await tx.professional.findUnique({ where: { userId: destinatarioId } });
    if (destinatarioEsProfesional) {
      await tx.professional.update({
        where: { userId: destinatarioId },
        data: {
          valoracionMedia: agregado._avg.puntuacion ?? puntuacion,
          totalTrabajos: agregado._count,
        },
      });
    }

    return review;
  });

  return res.status(201).json(resultado);
}
