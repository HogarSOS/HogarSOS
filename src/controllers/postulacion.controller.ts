import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { firestore } from '../config/firebase';
import { REQUIRE_PROFESSIONAL_VERIFICATION } from '../config/featureFlags';
import { enviarNotificacion, enviarNotificacionMasiva } from '../services/notification.service';
import { razonBloqueoTexto } from '../utils/contactFilter';

/**
 * Copia deliberada de sincronizarChatFirestore en
 * serviceRequest.controller.ts (no exportada de allí) — es un helper
 * de 10 líneas, más simple duplicarlo aquí que acoplar los dos
 * controladores solo para reutilizarlo.
 */
async function sincronizarChatFirestore(id: string, clienteId: string, profesionalId: string) {
  const [cliente, profesional] = await Promise.all([
    prisma.user.findUnique({ where: { id: clienteId } }),
    prisma.user.findUnique({ where: { id: profesionalId } }),
  ]);

  await firestore.collection('service_requests').doc(id).set(
    {
      clienteFirebaseUid: cliente?.firebaseUid ?? null,
      profesionalFirebaseUid: profesional?.firebaseUid ?? null,
    },
    { merge: true }
  );
}

const createPostulacionSchema = z.object({
  mensaje: z.string().trim().min(1).max(200),
});

/**
 * Un profesional se postula a una solicitud "pendiente" — sustituye al
 * antiguo "el primero que acepta gana". El mensaje pasa por el mismo
 * filtro de contacto que el chat, pero aquí sí se puede validar en
 * servidor porque este endpoint es nuestro, no Firestore.
 */
export async function createPostulacion(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const datos = createPostulacionSchema.parse(req.body);
  const bloqueo = razonBloqueoTexto(datos.mensaje);
  if (bloqueo) {
    return res.status(400).json({
      error: 'Por seguridad, los datos de contacto solo podrán compartirse cuando el trabajo haya sido aceptado.', code: 'CONTACT_INFO_BLOCKED',
      motivo: bloqueo,
    });
  }

  const profesional = await prisma.professional.findUnique({ where: { userId: profesionalId } });
  if (
    !profesional ||
    (REQUIRE_PROFESSIONAL_VERIFICATION && profesional.estadoVerificacion !== 'aprobado')
  ) {
    return res.status(403).json({ error: 'No autorizado para postularte a solicitudes', code: 'APPLICATION_NOT_AUTHORIZED' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.estado !== 'pendiente') {
    return res.status(409).json({ error: 'Esta solicitud ya no está disponible', code: 'REQUEST_NO_LONGER_AVAILABLE' });
  }

  try {
    const postulacion = await prisma.postulacion.create({
      data: { serviceRequestId: id, profesionalId, mensaje: datos.mensaje },
    });

    enviarNotificacion(solicitud.clienteId, 'nueva_postulacion', {}, { solicitudId: id }).catch((e) =>
      console.error(`[createPostulacion] Error al notificar al cliente de ${id}:`, e)
    );

    return res.status(201).json({ id: postulacion.id, estado: postulacion.estado });
  } catch (err: any) {
    // Constraint único (serviceRequestId, profesionalId) — mismo
    // patrón que el de Review, ver schema.prisma. Antes esto siempre
    // significaba "ya te has postulado" — pero desde que la misma tabla
    // también guarda solicitudes ignoradas (ver ignorarSolicitud), la
    // fila que chocó puede ser una ignorada previa, no una candidatura
    // real. updateMany condicionado a estado='ignorada' es la única
    // forma atómica de distinguir los dos casos: si NINGUNA fila
    // cumplía esa condición (count 0), es un conflicto real; si SÍ
    // (count 1), se convierte en la candidatura de verdad.
    if (err?.code === 'P2002') {
      const { count } = await prisma.postulacion.updateMany({
        where: { serviceRequestId: id, profesionalId, estado: 'ignorada' },
        data: { estado: 'pendiente', mensaje: datos.mensaje, resueltaAt: null },
      });
      if (count === 0) {
        return res.status(409).json({ error: 'Ya te has postulado a esta solicitud', code: 'APPLICATION_ALREADY_SENT' });
      }

      const postulacion = await prisma.postulacion.findUniqueOrThrow({
        where: { serviceRequestId_profesionalId: { serviceRequestId: id, profesionalId } },
      });

      enviarNotificacion(solicitud.clienteId, 'nueva_postulacion', {}, { solicitudId: id }).catch((e) =>
        console.error(`[createPostulacion] Error al notificar al cliente de ${id}:`, e)
      );

      return res.status(201).json({ id: postulacion.id, estado: postulacion.estado });
    }
    throw err;
  }
}

/**
 * El profesional ignora una solicitud cercana desde "Solicitudes cerca
 * de ti" — nunca fue ni será una candidatura, solo dice "esta no me
 * interesa" de forma persistente por cuenta (no por dispositivo). Se
 * guarda en la misma tabla que las candidaturas reales (ver el
 * comentario de EstadoPostulacion.ignorada en schema.prisma) para
 * reaprovechar el @@unique y el JOIN que listNearbyRequests ya hace.
 *
 * create() cubre el caso normal (sin fila previa). Si choca (P2002, ya
 * existe una fila), el updateMany de abajo SOLO convierte si esa fila
 * ya era 'ignorada' — re-ignorar es idempotente, pero nunca se pisa una
 * candidatura real ni un trabajo asignado.
 *
 * Revisión adversarial 2026-08-16 (carrera real, no hipotética):
 * ignorar y candidatarse pueden llegar casi a la vez desde dos
 * dispositivos con la misma cuenta (uso ya soportado, ver FCM
 * multi-dispositivo). La condición ORIGINAL de este updateMany era
 * `estado: { not: 'aceptada' }` — demasiado ancha: si createPostulacion
 * ganaba la carrera del create() (fila queda 'pendiente', con mensaje,
 * notificación 'nueva_postulacion' YA enviada al cliente), este
 * updateMany la sobrescribía igualmente a 'ignorada', dejando al
 * cliente notificado de una candidatura que ya no existía. Con
 * `estado: 'ignorada'`, un 'pendiente'/'rechazada' no cumple la
 * condición (count 0) y responde 409 en vez de pisarlo — el fallback de
 * createPostulacion es el ÚNICO camino que puede convertir una fila
 * 'ignorada' en candidatura real, nunca al revés.
 */
export async function ignorarSolicitud(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }

  // Sin lectura previa del estado — un findUnique + write dejaría una
  // ventana real entre comprobar y escribir (ver el comentario de
  // arriba). create() decide el caso sin fila previa; si choca (P2002),
  // el updateMany condicionado a estado='ignorada' es la única
  // escritura que decide de verdad — atómica, sin carrera.
  try {
    await prisma.postulacion.create({
      data: { serviceRequestId: id, profesionalId, estado: 'ignorada' },
    });
    return res.status(204).send();
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err;
  }

  const { count } = await prisma.postulacion.updateMany({
    where: { serviceRequestId: id, profesionalId, estado: 'ignorada' },
    data: { estado: 'ignorada', resueltaAt: new Date() },
  });
  if (count === 0) {
    // La fila existente es 'pendiente' (candidatura real sin resolver),
    // 'rechazada' (ya resuelta) o 'aceptada' (trabajo asignado) — en
    // los tres casos hay una interacción real previa que "ignorar" no
    // puede pisar por encima.
    return res.status(409).json({ error: 'No se puede ignorar: ya hay una candidatura tuya en esta solicitud', code: 'REQUEST_CANNOT_IGNORE' });
  }

  return res.status(204).send();
}

/**
 * Lista las candidaturas pendientes de una solicitud — solo el cliente
 * dueño. A propósito con ORDER BY random(): no se ordena por
 * valoración para que los profesionales nuevos tengan las mismas
 * oportunidades que los ya establecidos: se resuelve de nuevo en cada
 * carga, así que el orden cambia entre refrescos.
 *
 * Nunca selecciona teléfono/email del profesional — antes de la
 * contratación esos datos no deben llegar al cliente de ninguna forma.
 */
export async function listPostulaciones(req: Request, res: Response) {
  const { id } = req.params;
  const clienteId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud', code: 'REQUEST_NO_ACCESS' });
  }

  const postulaciones = await prisma.$queryRaw<
    {
      id: string;
      profesional_id: string;
      nombre: string;
      foto_perfil_url: string | null;
      valoracion_media: number;
      total_valoraciones: number;
      distancia_metros: number | null;
      mensaje: string | null;
      estado_verificacion: string;
      created_at: Date;
    }[]
  >`
    SELECT po.id, po.profesional_id, u.nombre, u.foto_perfil_url,
           u.valoracion_media::double precision AS valoracion_media, u.total_valoraciones, po.mensaje, po.created_at,
           p.estado_verificacion,
           CASE WHEN p.ubicacion_actual IS NOT NULL
                THEN ST_Distance(sr.ubicacion, p.ubicacion_actual)
                ELSE NULL END AS distancia_metros
    FROM postulaciones po
    JOIN professionals p ON p.user_id = po.profesional_id
    JOIN users u ON u.id = po.profesional_id
    JOIN service_requests sr ON sr.id = po.service_request_id
    WHERE po.service_request_id = ${id} AND po.estado = 'pendiente'
    ORDER BY random()
  `;

  return res.json({ postulaciones });
}

/**
 * El cliente elige un candidato entre las postulaciones pendientes —
 * mismo patrón de updateMany atómico que el antiguo acceptServiceRequest
 * (ver postulacion.controller.ts arriba y el comentario retirado de
 * serviceRequest.controller.ts), pero disparado por la elección del
 * cliente, no por el primer profesional que pulsa un botón.
 */
export async function selectPostulacion(req: Request, res: Response) {
  const { id, postulacionId } = req.params;
  const clienteId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud', code: 'REQUEST_NO_ACCESS' });
  }

  const postulacion = await prisma.postulacion.findUnique({ where: { id: postulacionId } });
  if (!postulacion || postulacion.serviceRequestId !== id) {
    return res.status(404).json({ error: 'Candidatura no encontrada', code: 'APPLICATION_NOT_FOUND' });
  }

  const otrasIds = await prisma.$transaction(async (tx) => {
    const otras = await tx.postulacion.findMany({
      where: { serviceRequestId: id, id: { not: postulacionId }, estado: 'pendiente' },
      select: { profesionalId: true },
    });

    const { count } = await tx.serviceRequest.updateMany({
      where: { id, estado: 'pendiente' },
      data: { profesionalId: postulacion.profesionalId, estado: 'aceptada', aceptadaAt: new Date() },
    });
    if (count === 0) throw new Error('YA_NO_DISPONIBLE');

    await tx.postulacion.update({
      where: { id: postulacionId },
      data: { estado: 'aceptada', resueltaAt: new Date() },
    });
    await tx.postulacion.updateMany({
      where: { serviceRequestId: id, id: { not: postulacionId }, estado: 'pendiente' },
      data: { estado: 'rechazada', resueltaAt: new Date() },
    });

    return otras.map((o) => o.profesionalId);
  }).catch((err) => {
    if (err instanceof Error && err.message === 'YA_NO_DISPONIBLE') return null;
    throw err;
  });

  if (otrasIds === null) {
    return res.status(409).json({ error: 'Esta solicitud ya no está disponible', code: 'REQUEST_NO_LONGER_AVAILABLE' });
  }

  try {
    await sincronizarChatFirestore(id, clienteId, postulacion.profesionalId);
  } catch (firestoreErr) {
    console.error(`[selectPostulacion] Fallo al sincronizar Firestore para ${id}:`, firestoreErr);
  }

  enviarNotificacion(postulacion.profesionalId, 'postulacion_aceptada', {}, { solicitudId: id }).catch((e) =>
    console.error(`[selectPostulacion] Error al notificar al elegido de ${id}:`, e)
  );

  if (otrasIds.length > 0) {
    enviarNotificacionMasiva(otrasIds, 'postulacion_rechazada', {}, { solicitudId: id }).catch((e) =>
      console.error(`[selectPostulacion] Error al notificar a los descartados de ${id}:`, e)
    );
  }

  return res.json({ id, estado: 'aceptada', profesionalId: postulacion.profesionalId });
}
