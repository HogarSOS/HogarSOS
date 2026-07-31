import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { enviarNotificacion } from '../services/notification.service';
import { razonBloqueoTexto } from '../utils/contactFilter';

const createAmpliacionSchema = z.object({
  horasAdicionales: z.number().positive(),
  mensaje: z.string().trim().max(200).optional(),
});

/**
 * El profesional pide más horas cuando un trabajo "por_horas" se
 * alarga más de lo estimado — nunca se cobra el exceso fuera de la
 * app, hay que pasar por aquí y que el cliente lo acepte. Solo aplica
 * sobre el presupuesto ya aceptado de la solicitud (tiene que ser
 * "por_horas" — un presupuesto "cerrado" no tiene ampliaciones).
 */
export async function crearAmpliacion(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const parsed = createAmpliacionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de ampliación inválidos', detalles: parsed.error.flatten() });
  }

  if (parsed.data.mensaje) {
    const bloqueo = razonBloqueoTexto(parsed.data.mensaje);
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
  if (solicitud.estado !== 'aceptada' && solicitud.estado !== 'en_progreso') {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para pedir una ampliación' });
  }

  const presupuesto = await prisma.presupuesto.findFirst({
    where: { serviceRequestId: id, estado: 'aceptado' },
    orderBy: { createdAt: 'desc' },
  });
  if (!presupuesto) {
    return res.status(409).json({ error: 'No hay un presupuesto aceptado para esta solicitud' });
  }
  if (presupuesto.tipo !== 'por_horas') {
    return res.status(409).json({ error: 'Solo se puede pedir una ampliación en un presupuesto por horas' });
  }

  const yaPendiente = await prisma.ampliacion.findFirst({
    where: { presupuestoId: presupuesto.id, estado: 'pendiente' },
  });
  if (yaPendiente) {
    return res.status(409).json({ error: 'Ya hay una ampliación pendiente de respuesta' });
  }

  const ampliacion = await prisma.ampliacion.create({
    data: {
      presupuestoId: presupuesto.id,
      horasAdicionales: parsed.data.horasAdicionales,
      mensaje: parsed.data.mensaje,
    },
  });

  enviarNotificacion(solicitud.clienteId, {
    title: 'El profesional necesita más tiempo',
    body: 'Ha pedido ampliar las horas del trabajo — revísalo para aceptar o rechazar',
  }, { tipo: 'nueva_ampliacion', solicitudId: id }).catch((e) =>
    console.error(`[crearAmpliacion] Error al notificar al cliente de ${id}:`, e)
  );

  return res.status(201).json({ id: ampliacion.id, estado: ampliacion.estado });
}

const responderAmpliacionSchema = z.object({
  accion: z.enum(['aceptar', 'rechazar']),
});

/**
 * El cliente acepta o rechaza la ampliación. Aceptar NO autoriza el
 * pago por sí solo — como con el presupuesto inicial, es un paso
 * aparte (el cliente llama después a POST /payments/intent, que ya
 * detecta que hay una ampliación aceptada sin autorizar y crea esa
 * autorización nueva, ver payment.controller.ts).
 */
export async function responderAmpliacion(req: Request, res: Response) {
  const { id, ampliacionId } = req.params;
  const clienteId = req.user!.userId;

  const parsed = responderAmpliacionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta indicar si aceptas o rechazas la ampliación' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud' });
  }

  const ampliacion = await prisma.ampliacion.findUnique({
    where: { id: ampliacionId },
    include: { presupuesto: true },
  });
  if (!ampliacion || ampliacion.presupuesto.serviceRequestId !== id) {
    return res.status(404).json({ error: 'Ampliación no encontrada' });
  }

  const nuevoEstado = parsed.data.accion === 'aceptar' ? 'aceptado' : 'rechazado';
  const { count } = await prisma.ampliacion.updateMany({
    where: { id: ampliacionId, estado: 'pendiente' },
    data: { estado: nuevoEstado, resueltaAt: new Date() },
  });
  if (count === 0) {
    return res.status(409).json({ error: 'Esta ampliación ya no está pendiente de respuesta' });
  }

  enviarNotificacion(ampliacion.presupuesto.profesionalId, {
    title: nuevoEstado === 'aceptado' ? '¡Ampliación aceptada!' : 'Ampliación rechazada',
    body:
      nuevoEstado === 'aceptado'
        ? 'El cliente ha aceptado tu petición de más horas — te avisaremos cuando autorice el pago adicional'
        : 'El cliente ha rechazado tu petición de más horas',
  }, { tipo: nuevoEstado === 'aceptado' ? 'ampliacion_aceptada' : 'ampliacion_rechazada', solicitudId: id }).catch(
    (e) => console.error(`[responderAmpliacion] Error al notificar al profesional de ${id}:`, e)
  );

  return res.json({ id: ampliacionId, estado: nuevoEstado });
}
