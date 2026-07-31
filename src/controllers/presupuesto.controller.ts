import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { enviarNotificacion } from '../services/notification.service';
import { razonBloqueoTexto } from '../utils/contactFilter';

const createPresupuestoSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('cerrado'),
    monto: z.number().positive(),
    mensaje: z.string().trim().max(200).optional(),
  }),
  z.object({
    tipo: z.literal('por_horas'),
    tarifaHora: z.number().positive(),
    horasEstimadas: z.number().positive(),
    mensaje: z.string().trim().max(200).optional(),
  }),
]);

/**
 * El profesional envía un presupuesto real tras ser elegido — sustituye
 * al antiguo precioEstimado (un número que el cliente adivinaba al
 * crear la solicitud, sin que nadie lo hubiera acordado). Dos
 * modalidades: precio cerrado (monto fijo) o por horas (tarifa ×
 * horas estimadas, ese es el techo que luego se autoriza en Stripe).
 * El mensaje pasa por el mismo filtro de contacto que las
 * candidaturas — antes de la contratación no deben poder colarse
 * teléfono/email por aquí tampoco.
 */
export async function createPresupuesto(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const parsed = createPresupuestoSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de presupuesto inválidos', detalles: parsed.error.flatten() });
  }
  const datos = parsed.data;

  if (datos.mensaje) {
    const bloqueo = razonBloqueoTexto(datos.mensaje);
    if (bloqueo) {
      return res.status(400).json({
        error: 'Por seguridad, los datos de contacto solo podrán compartirse cuando el trabajo haya sido aceptado.',
        motivo: bloqueo,
      });
    }
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud' });
  }
  if (solicitud.estado !== 'aceptada') {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para presupuestar' });
  }

  const yaPendiente = await prisma.presupuesto.findFirst({
    where: { serviceRequestId: id, estado: 'pendiente' },
  });
  if (yaPendiente) {
    return res.status(409).json({ error: 'Ya hay un presupuesto pendiente de respuesta para esta solicitud' });
  }

  const presupuesto = await prisma.presupuesto.create({
    data:
      datos.tipo === 'cerrado'
        ? { serviceRequestId: id, profesionalId, tipo: 'cerrado', monto: datos.monto, mensaje: datos.mensaje }
        : {
            serviceRequestId: id,
            profesionalId,
            tipo: 'por_horas',
            tarifaHora: datos.tarifaHora,
            horasEstimadas: datos.horasEstimadas,
            mensaje: datos.mensaje,
          },
  });

  enviarNotificacion(solicitud.clienteId, {
    title: 'Presupuesto recibido',
    body: 'El profesional te ha enviado un presupuesto',
  }, { tipo: 'nuevo_presupuesto', solicitudId: id }).catch((e) =>
    console.error(`[createPresupuesto] Error al notificar al cliente de ${id}:`, e)
  );

  return res.status(201).json({ id: presupuesto.id, tipo: presupuesto.tipo, estado: presupuesto.estado });
}

const responderPresupuestoSchema = z.object({
  accion: z.enum(['aceptar', 'rechazar']),
});

/**
 * El cliente acepta o rechaza el presupuesto — nunca cambia
 * ServiceRequest.estado (se queda en "aceptada" durante toda la
 * negociación, el presupuesto es una entidad aparte). Si rechaza, el
 * profesional puede enviar uno nuevo — no cancela el trabajo.
 * Guarda atómica vía updateMany (mismo patrón que selectPostulacion)
 * para que un doble tap no acepte/rechace dos veces.
 */
export async function responderPresupuesto(req: Request, res: Response) {
  const { id, presupuestoId } = req.params;
  const clienteId = req.user!.userId;

  const parsed = responderPresupuestoSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta indicar si aceptas o rechazas el presupuesto' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud' });
  }

  const presupuesto = await prisma.presupuesto.findUnique({ where: { id: presupuestoId } });
  if (!presupuesto || presupuesto.serviceRequestId !== id) {
    return res.status(404).json({ error: 'Presupuesto no encontrado' });
  }

  const nuevoEstado = parsed.data.accion === 'aceptar' ? 'aceptado' : 'rechazado';
  const { count } = await prisma.presupuesto.updateMany({
    where: { id: presupuestoId, estado: 'pendiente' },
    data: { estado: nuevoEstado, resueltaAt: new Date() },
  });
  if (count === 0) {
    return res.status(409).json({ error: 'Este presupuesto ya no está pendiente de respuesta' });
  }

  enviarNotificacion(presupuesto.profesionalId, {
    title: nuevoEstado === 'aceptado' ? '¡Presupuesto aceptado!' : 'Presupuesto rechazado',
    body:
      nuevoEstado === 'aceptado'
        ? 'El cliente ha aceptado tu presupuesto — ya puede autorizar el pago'
        : 'El cliente ha rechazado tu presupuesto. Puedes enviar uno nuevo.',
  }, { tipo: nuevoEstado === 'aceptado' ? 'presupuesto_aceptado' : 'presupuesto_rechazado', solicitudId: id }).catch(
    (e) => console.error(`[responderPresupuesto] Error al notificar al profesional de ${id}:`, e)
  );

  return res.json({ id: presupuestoId, estado: nuevoEstado });
}
