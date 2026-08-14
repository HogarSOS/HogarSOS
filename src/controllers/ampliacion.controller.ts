import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { enviarNotificacion } from '../services/notification.service';
import { razonBloqueoTexto } from '../utils/contactFilter';

const createAmpliacionSchema = z.object({
  horasAdicionales: z.number().positive().optional(),
  montoAdicional: z.number().positive().optional(),
  mensaje: z.string().trim().max(200).optional(),
});

/**
 * El profesional pide más margen cuando el trabajo se complica más de
 * lo previsto — nunca se cobra el exceso fuera de la app, hay que
 * pasar por aquí y que el cliente lo acepte. Dos modalidades, igual
 * que Presupuesto: si el presupuesto aceptado es "por_horas", pide
 * horasAdicionales; si es "cerrado", pide montoAdicional directo (ej.
 * "+40€, hay que sustituir una válvula").
 */
export async function crearAmpliacion(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const parsed = createAmpliacionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de ampliación inválidos', code: 'EXTENSION_INVALID_DATA', detalles: parsed.error.flatten() });
  }

  if (parsed.data.mensaje) {
    const bloqueo = razonBloqueoTexto(parsed.data.mensaje);
    if (bloqueo) {
      return res.status(400).json({
        error: 'Por seguridad, los datos de contacto solo podrán compartirse cuando el trabajo haya sido aceptado.', code: 'CONTACT_INFO_BLOCKED',
        motivo: bloqueo,
      });
    }
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud', code: 'NOT_ASSIGNED_PROFESSIONAL' });
  }
  if (solicitud.estado !== 'aceptada' && solicitud.estado !== 'en_progreso') {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para pedir una ampliación', code: 'REQUEST_INVALID_STATE_EXTENSION' });
  }

  const presupuesto = await prisma.presupuesto.findFirst({
    where: { serviceRequestId: id, estado: 'aceptado' },
    orderBy: { createdAt: 'desc' },
  });
  if (!presupuesto) {
    return res.status(409).json({ error: 'No hay un presupuesto aceptado para esta solicitud', code: 'NO_ACCEPTED_BUDGET' });
  }

  if (presupuesto.tipo === 'por_horas' && !parsed.data.horasAdicionales) {
    return res.status(400).json({ error: 'Indica las horas adicionales', code: 'EXTENSION_HOURS_REQUIRED' });
  }
  if (presupuesto.tipo === 'cerrado' && !parsed.data.montoAdicional) {
    return res.status(400).json({ error: 'Indica el importe adicional', code: 'EXTENSION_AMOUNT_REQUIRED' });
  }

  const yaPendiente = await prisma.ampliacion.findFirst({
    where: { presupuestoId: presupuesto.id, estado: 'pendiente' },
  });
  if (yaPendiente) {
    return res.status(409).json({ error: 'Ya hay una ampliación pendiente de respuesta', code: 'EXTENSION_ALREADY_PENDING' });
  }

  // El findFirst de arriba es solo fast-path — la garantía real es el
  // índice único parcial `ampliaciones_pendiente_unico` (WHERE
  // estado='pendiente'), sobre presupuesto_id. Sin él, dos peticiones
  // casi simultáneas podían pasar ambas el findFirst y crear dos
  // ampliaciones "pendiente" para el mismo presupuesto — mismo patrón
  // ya cerrado en completeServiceRequest/CierreHoras (auditoría
  // 2026-08-14).
  let ampliacion;
  try {
    ampliacion = await prisma.ampliacion.create({
      data:
        presupuesto.tipo === 'por_horas'
          ? { presupuestoId: presupuesto.id, horasAdicionales: parsed.data.horasAdicionales, mensaje: parsed.data.mensaje }
          : { presupuestoId: presupuesto.id, montoAdicional: parsed.data.montoAdicional, mensaje: parsed.data.mensaje },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Ya hay una ampliación pendiente de respuesta', code: 'EXTENSION_ALREADY_PENDING' });
    }
    throw err;
  }

  enviarNotificacion(
    solicitud.clienteId,
    'nueva_ampliacion',
    { tipoAmpliacion: presupuesto.tipo === 'por_horas' ? 'por_horas' : 'monto' },
    { solicitudId: id }
  ).catch((e) =>
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
    return res.status(400).json({ error: 'Falta indicar si aceptas o rechazas la ampliación', code: 'EXTENSION_DECISION_REQUIRED' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud', code: 'REQUEST_NO_ACCESS' });
  }

  const ampliacion = await prisma.ampliacion.findUnique({
    where: { id: ampliacionId },
    include: { presupuesto: true },
  });
  if (!ampliacion || ampliacion.presupuesto.serviceRequestId !== id) {
    return res.status(404).json({ error: 'Ampliación no encontrada', code: 'EXTENSION_NOT_FOUND' });
  }

  const nuevoEstado = parsed.data.accion === 'aceptar' ? 'aceptado' : 'rechazado';
  const { count } = await prisma.ampliacion.updateMany({
    where: { id: ampliacionId, estado: 'pendiente' },
    data: { estado: nuevoEstado, resueltaAt: new Date() },
  });
  if (count === 0) {
    return res.status(409).json({ error: 'Esta ampliación ya no está pendiente de respuesta', code: 'EXTENSION_NOT_PENDING' });
  }

  enviarNotificacion(
    ampliacion.presupuesto.profesionalId,
    nuevoEstado === 'aceptado' ? 'ampliacion_aceptada' : 'ampliacion_rechazada',
    {},
    { solicitudId: id }
  ).catch(
    (e) => console.error(`[responderAmpliacion] Error al notificar al profesional de ${id}:`, e)
  );

  return res.json({ id: ampliacionId, estado: nuevoEstado });
}
