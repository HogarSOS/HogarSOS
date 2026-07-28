import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { refundPayment, releasePayment } from '../services/payment.service';

export async function listPendingVerifications(req: Request, res: Response) {
  const pendientes = await prisma.professional.findMany({
    where: { estadoVerificacion: 'pendiente' },
    include: {
      user: { select: { nombre: true, email: true, telefono: true, createdAt: true } },
      categorias: { include: { category: true } },
    },
    orderBy: { createdAt: 'asc' }, // los más antiguos primero, evita que se acumulen sin revisar
  });

  return res.json(
    pendientes.map((p) => ({
      userId: p.userId,
      nombre: p.user.nombre,
      email: p.user.email,
      documentoIdentidadUrl: p.documentoIdentidadUrl,
      certificadosUrl: p.certificadosUrl,
      seguroRcUrl: p.seguroRcUrl,
      categorias: p.categorias.map((c) => c.category.nombre),
      solicitadoDesde: p.user.createdAt,
    }))
  );
}

const decisionSchema = z.object({
  aprobar: z.boolean(),
  motivoRechazo: z.string().min(5).optional(),
});

/**
 * Aprueba o rechaza a un profesional. Un rechazo requiere motivo, para
 * que el profesional sepa qué corregir antes de reenviar documentación.
 */
export async function approveProfessional(req: Request, res: Response) {
  const { professionalId } = req.params;
  const adminId = req.user!.userId;

  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }
  if (!parsed.data.aprobar && !parsed.data.motivoRechazo) {
    return res.status(400).json({ error: 'Un rechazo requiere motivoRechazo' });
  }

  const profesional = await prisma.professional.findUnique({ where: { userId: professionalId } });
  if (!profesional) {
    return res.status(404).json({ error: 'Profesional no encontrado' });
  }
  if (profesional.estadoVerificacion !== 'pendiente') {
    return res.status(409).json({ error: 'Este profesional no tiene una verificación pendiente' });
  }

  const actualizado = await prisma.professional.update({
    where: { userId: professionalId },
    data: {
      estadoVerificacion: parsed.data.aprobar ? 'aprobado' : 'rechazado',
      verificadoPor: adminId,
      verificadoAt: new Date(),
    },
  });

  // TODO: disparar notificación push/email al profesional con el resultado
  // (y el motivoRechazo si aplica) — pendiente de integrar servicio de notificaciones.

  return res.json({
    userId: actualizado.userId,
    estadoVerificacion: actualizado.estadoVerificacion,
  });
}

export async function listDisputes(req: Request, res: Response) {
  const estadoFiltro = typeof req.query.estado === 'string' ? req.query.estado : undefined;

  const disputas = await prisma.dispute.findMany({
    where: estadoFiltro ? { estado: estadoFiltro } : { estado: { in: ['abierta', 'en_revision'] } },
    include: {
      serviceRequest: {
        include: { categoria: true, payment: true, cliente: { select: { nombre: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Decimal (montoTotal/comisionPlataforma/montoProfesional) se serializa
  // como string si no se convierte explícitamente — mismo patrón que en
  // el resto del backend. Hoy el frontend no lee estos campos (ver
  // admin_models.dart), pero se corrige igualmente para no dejarlo como
  // una bomba de relojería para cuando se amplíe el panel.
  return res.json(
    disputas.map((d) => ({
      ...d,
      serviceRequest: {
        ...d.serviceRequest,
        payment: d.serviceRequest.payment
          ? {
              ...d.serviceRequest.payment,
              montoTotal: Number(d.serviceRequest.payment.montoTotal),
              comisionPlataforma: Number(d.serviceRequest.payment.comisionPlataforma),
              montoProfesional: Number(d.serviceRequest.payment.montoProfesional),
            }
          : null,
      },
    }))
  );
}

const resolveDisputeSchema = z.object({
  resolucion: z.enum(['resuelta_cliente', 'resuelta_profesional']),
  notas: z.string().min(5),
});

/**
 * Resuelve una disputa. Si se falla a favor del cliente, se reembolsa
 * el pago retenido; si se falla a favor del profesional, se libera el
 * pago (captura + transferencia) como si el servicio se hubiera
 * completado con normalidad.
 */
export async function resolveDispute(req: Request, res: Response) {
  const { id } = req.params;
  const adminId = req.user!.userId;

  const parsed = resolveDisputeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const disputa = await prisma.dispute.findUnique({ where: { id } });
  if (!disputa) {
    return res.status(404).json({ error: 'Disputa no encontrada' });
  }
  if (disputa.estado === 'resuelta_cliente' || disputa.estado === 'resuelta_profesional') {
    return res.status(409).json({ error: 'Esta disputa ya fue resuelta' });
  }

  const { resolucion, notas } = parsed.data;

  try {
    if (resolucion === 'resuelta_cliente') {
      await refundPayment(disputa.serviceRequestId);
      await prisma.serviceRequest.update({
        where: { id: disputa.serviceRequestId },
        data: { estado: 'cancelada' },
      });
    } else {
      await releasePayment(disputa.serviceRequestId);
      await prisma.serviceRequest.update({
        where: { id: disputa.serviceRequestId },
        data: { estado: 'completada' },
      });
    }
  } catch (err) {
    return res.status(502).json({
      error: 'La resolución no pudo aplicarse en Stripe. Revisa el estado del pago manualmente.',
      detalle: (err as Error).message,
    });
  }

  const actualizada = await prisma.dispute.update({
    where: { id },
    data: {
      estado: resolucion,
      resueltoPor: adminId,
      resolucionNotas: notas,
      resueltaAt: new Date(),
    },
  });

  return res.json(actualizada);
}
