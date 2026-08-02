import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { enviarNotificacion } from '../services/notification.service';

const createDisputeSchema = z.object({
  motivo: z.enum([
    'profesional_no_presento',
    'cliente_ausente',
    'trabajo_cancelado',
    'problema_pago',
    'comportamiento_inapropiado',
    'otro',
  ]),
  descripcion: z.string().trim().min(5).max(1000),
  fotosUrls: z.array(z.string().url()).max(6).optional(),
});

/**
 * Abre una reclamación sobre un trabajo ya aceptado — cliente o
 * profesional, cualquiera de las dos partes. Pone la solicitud en
 * "disputada" (el mismo valor de EstadoSolicitud que ya existía en el
 * enum sin usarse, y que el frontend ya renderiza como "En revisión
 * por nuestro equipo de soporte"), lo que bloquea de forma natural
 * completar el trabajo y dejar valoraciones (ver createReview) hasta
 * que un admin la resuelva desde el panel ya existente
 * (listDisputes/resolveDispute en admin.controller.ts, sin cambios).
 */
export async function createDispute(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user!.userId;

  const datos = createDisputeSchema.parse(req.body);

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud', code: 'REQUEST_NO_ACCESS' });
  }
  if (!['aceptada', 'en_progreso', 'completada'].includes(solicitud.estado)) {
    return res.status(409).json({ error: 'Solo se puede reportar un problema en un trabajo aceptado', code: 'DISPUTE_ONLY_ON_ACCEPTED_JOB' });
  }
  if (solicitud.estado === 'disputada') {
    return res.status(409).json({ error: 'Ya existe una reclamación abierta para este trabajo', code: 'DISPUTE_ALREADY_OPEN' });
  }

  const dispute = await prisma.$transaction(async (tx) => {
    const creada = await tx.dispute.create({
      data: {
        serviceRequestId: id,
        creadoPor: userId,
        motivo: datos.descripcion,
        motivoCategoria: datos.motivo,
        fotosUrls: datos.fotosUrls ?? [],
      },
    });
    await tx.serviceRequest.update({ where: { id }, data: { estado: 'disputada' } });
    return creada;
  });

  const otraParteId = solicitud.clienteId === userId ? solicitud.profesionalId : solicitud.clienteId;
  if (otraParteId) {
    enviarNotificacion(otraParteId, 'reclamacion_abierta', {}, { solicitudId: id }).catch((e) =>
      console.error(`[createDispute] Error al notificar a ${otraParteId} de ${id}:`, e)
    );
  }

  return res.status(201).json({
    id: dispute.id,
    motivo: dispute.motivoCategoria,
    descripcion: dispute.motivo,
    estado: dispute.estado,
    createdAt: dispute.createdAt,
  });
}
