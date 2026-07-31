import { Request, Response } from 'express';
import { z } from 'zod';
import admin from 'firebase-admin';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { firestore } from '../config/firebase';
import { releasePayments, refundPayment } from '../services/payment.service';
import { REQUIRE_PROFESSIONAL_VERIFICATION } from '../config/featureFlags';
import { enviarNotificacion, enviarNotificacionMasiva } from '../services/notification.service';

const RADIO_BUSQUEDA_METROS = 50000; // 50 km, ajustable por categoría en el futuro

/**
 * Serializa el último Presupuesto de una solicitud (pendiente, aceptado
 * o rechazado — no solo el aceptado) para que el frontend distinga los
 * cuatro estados posibles (incluido "todavía no hay ninguno" = null) y
 * decida qué tarjeta mostrar. Usado en getServiceRequestById y
 * listMyAssignedRequests.
 */
function serializarPresupuesto(p: {
  id: string;
  tipo: string;
  monto: Prisma.Decimal | null;
  tarifaHora: Prisma.Decimal | null;
  horasEstimadas: Prisma.Decimal | null;
  mensaje: string | null;
  estado: string;
  createdAt: Date;
} | undefined) {
  if (!p) return null;
  return {
    id: p.id,
    tipo: p.tipo,
    monto: p.monto ? Number(p.monto) : null,
    tarifaHora: p.tarifaHora ? Number(p.tarifaHora) : null,
    horasEstimadas: p.horasEstimadas ? Number(p.horasEstimadas) : null,
    mensaje: p.mensaje,
    estado: p.estado,
    createdAt: p.createdAt,
  };
}

/** Misma idea que serializarPresupuesto, para la última Ampliacion de un presupuesto (cualquier estado). */
function serializarAmpliacion(a: {
  id: string;
  horasAdicionales: Prisma.Decimal | null;
  montoAdicional: Prisma.Decimal | null;
  mensaje: string | null;
  estado: string;
  createdAt: Date;
} | undefined) {
  if (!a) return null;
  return {
    id: a.id,
    horasAdicionales: a.horasAdicionales ? Number(a.horasAdicionales) : null,
    montoAdicional: a.montoAdicional ? Number(a.montoAdicional) : null,
    mensaje: a.mensaje,
    estado: a.estado,
    createdAt: a.createdAt,
  };
}

/** Misma idea, para el último CierreHoras de una solicitud (cualquier estado). */
function serializarCierreHoras(c: {
  id: string;
  horasReales: Prisma.Decimal;
  estado: string;
  createdAt: Date;
} | undefined) {
  if (!c) return null;
  return { id: c.id, horasReales: Number(c.horasReales), estado: c.estado, createdAt: c.createdAt };
}

/**
 * `Payment` ya no es 1:1 con la solicitud (puede haber una autorización
 * inicial + una por cada ampliación aceptada) — esto reduce todas las
 * filas a un único resumen para que el frontend siga viendo un solo
 * "estado de pago", sin tener que enterarse de cuántas autorizaciones
 * hay por debajo. `estado`: "retenido" si queda alguna sin capturar,
 * si no "liberado" si se liberó alguna, si no el resto de casos.
 */
export function agregarPagos(
  pagos: { estado: string; montoTotal: Prisma.Decimal; comisionPlataforma: Prisma.Decimal; montoProfesional: Prisma.Decimal }[]
) {
  if (pagos.length === 0) return null;

  const estado = pagos.some((p) => p.estado === 'retenido')
    ? 'retenido'
    : pagos.some((p) => p.estado === 'liberado')
      ? 'liberado'
      : pagos.some((p) => p.estado === 'fallido')
        ? 'fallido'
        : 'reembolsado';

  const relevantes = pagos.filter((p) => p.estado === 'retenido' || p.estado === 'liberado');
  const sumar = (clave: 'montoTotal' | 'comisionPlataforma' | 'montoProfesional') =>
    Number(relevantes.reduce((acc, p) => acc + Number(p[clave]), 0).toFixed(2));

  return {
    estado,
    montoTotal: sumar('montoTotal'),
    comisionPlataforma: sumar('comisionPlataforma'),
    montoProfesional: sumar('montoProfesional'),
  };
}

/**
 * true si hay algo aceptado (el presupuesto inicial, o una ampliación)
 * que todavía no tiene su autorización de Stripe correspondiente — es
 * la señal que necesita el frontend para mostrar el botón "Autorizar
 * pago", sea la primera vez o tras una ampliación, sin tener que
 * distinguir los dos casos por su cuenta.
 */
function calcularPagoPendienteDeAutorizar(
  presupuesto: { id: string; estado: string } | undefined,
  ampliacion: { id: string; estado: string } | undefined,
  pagos: { presupuestoId: string; ampliacionId: string | null }[]
): boolean {
  if (!presupuesto || presupuesto.estado !== 'aceptado') return false;
  const tienePagoInicial = pagos.some((p) => p.presupuestoId === presupuesto.id && !p.ampliacionId);
  if (!tienePagoInicial) return true;
  if (ampliacion && ampliacion.estado === 'aceptado') {
    const tienePagoAmpliacion = pagos.some((p) => p.ampliacionId === ampliacion.id);
    if (!tienePagoAmpliacion) return true;
  }
  return false;
}

const createRequestSchema = z.object({
  categoryId: z.number().int(),
  descripcion: z.string().min(5).max(1000),
  fotosUrls: z.array(z.string().url()).max(6).optional(),
  direccionTexto: z.string().optional(),
  latitud: z.number().min(-90).max(90),
  longitud: z.number().min(-180).max(180),
  urgencia: z.enum(['lo_antes_posible', 'hoy', 'manana', 'fecha_especifica']).default('lo_antes_posible'),
  // Requerida solo cuando urgencia = fecha_especifica — se valida más abajo,
  // porque zod no puede condicionar un campo a otro dentro del mismo objeto
  // de forma legible sin .refine(), y aquí es más claro hacerlo explícito.
  fechaDeseada: z.string().datetime().optional(),
});

/**
 * Crea una solicitud de servicio. La ubicación se guarda con SQL nativo
 * porque Prisma no traduce el tipo geography(Point, 4326) de PostGIS.
 */
export async function createServiceRequest(req: Request, res: Response) {
  const parsed = createRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const {
    categoryId,
    descripcion,
    fotosUrls,
    direccionTexto,
    latitud,
    longitud,
    urgencia,
    fechaDeseada,
  } = parsed.data;
  const clienteId = req.user!.userId;

  if (urgencia === 'fecha_especifica' && !fechaDeseada) {
    return res.status(400).json({ error: 'fechaDeseada es obligatoria cuando urgencia es "fecha_especifica"' });
  }

  const categoria = await prisma.serviceCategory.findUnique({ where: { id: categoryId } });
  if (!categoria || !categoria.activo) {
    return res.status(404).json({ error: 'Categoría de servicio no válida' });
  }

  const [solicitud] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO service_requests (
      id, cliente_id, category_id, descripcion, fotos_urls, direccion_texto,
      urgencia, fecha_deseada, ubicacion, estado, created_at
    )
    VALUES (
      uuid_generate_v4(), ${clienteId}::uuid, ${categoryId}, ${descripcion},
      ${fotosUrls ?? []}, ${direccionTexto ?? null},
      ${urgencia}::"UrgenciaSolicitud", ${fechaDeseada ? new Date(fechaDeseada) : null},
      ST_SetSRID(ST_MakePoint(${longitud}, ${latitud}), 4326)::geography,
      'pendiente', now()
    )
    RETURNING id
  `;

  // Aviso a los profesionales disponibles de esa categoría, cerca de la
  // solicitud — "fire and forget", nunca debe bloquear ni fallar la
  // creación de la solicitud en sí (ver notification.service.ts).
  notificarProfesionalesCercanos(solicitud.id, categoryId, categoria.nombre, latitud, longitud).catch((e) =>
    console.error('[createServiceRequest] Error al notificar profesionales cercanos:', e)
  );

  return res.status(201).json({ id: solicitud.id, estado: 'pendiente' });
}

async function notificarProfesionalesCercanos(
  solicitudId: string,
  categoryId: number,
  categoriaNombre: string,
  latitud: number,
  longitud: number
) {
  const verificacionFiltro = REQUIRE_PROFESSIONAL_VERIFICATION
    ? Prisma.sql`AND p.estado_verificacion = 'aprobado'`
    : Prisma.empty;

  const profesionales = await prisma.$queryRaw<{ user_id: string }[]>`
    SELECT DISTINCT p.user_id
    FROM professionals p
    JOIN professional_categories pc ON pc.professional_id = p.user_id
    WHERE pc.category_id = ${categoryId}
      AND p.disponible = true
      AND p.ubicacion_actual IS NOT NULL
      AND ST_DWithin(p.ubicacion_actual, ST_SetSRID(ST_MakePoint(${longitud}, ${latitud}), 4326)::geography, ${RADIO_BUSQUEDA_METROS})
      ${verificacionFiltro}
  `;

  if (profesionales.length === 0) return;

  await enviarNotificacionMasiva(
    profesionales.map((p) => p.user_id),
    { title: 'Nueva solicitud cerca de ti', body: `Alguien necesita ${categoriaNombre.toLowerCase()} cerca de tu ubicación` },
    { tipo: 'nueva_solicitud', solicitudId }
  );
}

export async function getServiceRequestById(req: Request, res: Response) {
  const { id } = req.params;
  const { userId, role } = req.user!;

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    include: {
      categoria: true,
      pagos: true,
      reviews: true,
      // Nombre del profesional asignado — el chat de esta solicitud
      // (ver ChatScreen en el frontend) no tenía forma de saber con
      // quién estaba hablando el cliente sin esto.
      profesional: { include: { user: { select: { nombre: true } } } },
      _count: { select: { postulaciones: { where: { estado: 'pendiente' } } } },
      presupuestos: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { ampliaciones: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
      cierresHoras: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }

  // Un cliente o profesional solo puede ver sus propias solicitudes;
  // el admin puede ver cualquiera. Esto complementa (no sustituye) el
  // row-level security recomendado a nivel de base de datos.
  const esParticipante = solicitud.clienteId === userId || solicitud.profesionalId === userId;
  if (role !== 'admin' && !esParticipante) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud' });
  }

  const presupuesto = solicitud.presupuestos[0];
  const ampliacion = presupuesto?.ampliaciones[0];

  return res.json({
    id: solicitud.id,
    categoria: solicitud.categoria.nombre,
    descripcion: solicitud.descripcion,
    profesionalNombre: solicitud.profesional?.user.nombre ?? null,
    fotosUrls: solicitud.fotosUrls,
    direccionTexto: solicitud.direccionTexto,
    urgencia: solicitud.urgencia,
    fechaDeseada: solicitud.fechaDeseada,
    precioFinal: solicitud.precioFinal ? Number(solicitud.precioFinal) : null,
    estado: solicitud.estado,
    createdAt: solicitud.createdAt,
    numCandidatos: solicitud._count.postulaciones,
    presupuesto: serializarPresupuesto(presupuesto),
    ampliacion: serializarAmpliacion(ampliacion),
    cierreHoras: serializarCierreHoras(solicitud.cierresHoras[0]),
    pagoPendienteDeAutorizar: calcularPagoPendienteDeAutorizar(presupuesto, ampliacion, solicitud.pagos),
    payment: agregarPagos(solicitud.pagos),
    // Array en vez de un único objeto: puede haber hasta dos
    // (cliente->profesional y profesional->cliente). El frontend
    // filtra por autorId == su propio usuario para saber "¿ya valoré
    // yo?" sin que el backend tenga que adivinar desde qué lado se
    // está pidiendo esto.
    reviews: solicitud.reviews.map((r) => ({
      autorId: r.autorId,
      puntuacion: r.puntuacion,
      comentario: r.comentario,
    })),
  });
}

/**
 * Lista solicitudes pendientes cerca del profesional autenticado,
 * limitadas a las categorías que ofrece y ordenadas por distancia.
 */
export async function listNearbyRequests(req: Request, res: Response) {
  const profesionalId = req.user!.userId;

  const profesional = await prisma.professional.findUnique({
    where: { userId: profesionalId },
    include: { categorias: true },
  });

  if (!profesional) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado' });
  }

  if (REQUIRE_PROFESSIONAL_VERIFICATION && profesional.estadoVerificacion !== 'aprobado') {
    return res.status(403).json({ error: 'Tu cuenta aún no ha sido verificada' });
  }

  if (!profesional.disponible) {
    return res.status(200).json({ solicitudes: [], aviso: 'Estás marcado como no disponible' });
  }

  const categoriaIds = profesional.categorias.map((c) => c.categoryId);
  if (categoriaIds.length === 0) {
    return res.status(200).json({ solicitudes: [], aviso: 'No tienes categorías configuradas' });
  }

  // Distancia calculada desde la última ubicación conocida del profesional.
  // user_id es `text` en la BD (sin @db.Uuid) — sin cast a ::uuid aquí,
  // igual que en professional.controller.ts (ver comentario allí).
  const solicitudes = await prisma.$queryRaw<
    {
      id: string;
      descripcion: string;
      distancia_metros: number;
      created_at: Date;
      urgencia: string;
      cliente_nombre: string;
      cliente_foto_url: string | null;
      ya_postulado: boolean;
    }[]
  >`
    SELECT sr.id, sr.descripcion, sr.created_at, sr.urgencia,
           ST_Distance(sr.ubicacion, p.ubicacion_actual) AS distancia_metros,
           u.nombre AS cliente_nombre, u.foto_perfil_url AS cliente_foto_url,
           (po.id IS NOT NULL) AS ya_postulado
    FROM service_requests sr
    JOIN professionals p ON p.user_id = ${profesionalId}
    JOIN users u ON u.id = sr.cliente_id
    LEFT JOIN postulaciones po ON po.service_request_id = sr.id AND po.profesional_id = ${profesionalId}
    WHERE sr.estado = 'pendiente'
      AND sr.category_id = ANY(${categoriaIds})
      AND p.ubicacion_actual IS NOT NULL
      AND ST_DWithin(sr.ubicacion, p.ubicacion_actual, ${RADIO_BUSQUEDA_METROS})
    ORDER BY distancia_metros ASC
    LIMIT 20
  `;

  return res.json({ solicitudes });
}

/**
 * Cancela una solicitud — solo el cliente que la creó, mientras siga
 * "pendiente" O "aceptada" (una vez "en_progreso"/completada ya no se
 * puede echar atrás). Se permite cancelar ya aceptada a propósito: el
 * profesional puede aceptar y mandar como primer mensaje del chat
 * cuándo puede ir (ver home_profesional_screen.dart) — si esa
 * disponibilidad no le sirve al cliente, necesita una forma real de
 * decir que no en vez de quedarse con un profesional asignado que no
 * puede venir cuando hace falta.
 *
 * Al cancelar una que ya estaba "aceptada" deja de aparecer como
 * trabajo asignado para ese profesional (listMyAssignedRequests filtra
 * por estado), así que no hace falta limpieza aparte tampoco ahí — pero
 * si el cliente ya había autorizado el pago (createEscrowPaymentIntent,
 * posterior a aceptar) hay que liberar esa retención en Stripe, o el
 * dinero se queda inmovilizado sin que nadie lo reciba nunca.
 *
 * Misma protección de condición de carrera que aceptar: la comprobación
 * de estado va dentro del propio UPDATE — si el profesional completa el
 * servicio justo en el instante en que el cliente cancela, gana quien
 * complete la transacción primero.
 */
export async function cancelServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const clienteId = req.user!.userId;

  try {
    const actual = await prisma.serviceRequest.findUnique({ where: { id } });
    if (!actual) throw new Error('NOT_FOUND');
    if (actual.clienteId !== clienteId) throw new Error('NO_AUTORIZADO');

    const { count } = await prisma.serviceRequest.updateMany({
      where: { id, clienteId, estado: { in: ['pendiente', 'aceptada'] } },
      data: { estado: 'cancelada' },
    });
    if (count === 0) throw new Error('YA_NO_CANCELABLE');

    // En su propio try/catch, igual que la sincronización de Firestore
    // al aceptar: cancelar ya quedó confirmado en Postgres arriba, un
    // fallo aquí (o que directamente no hubiera pago que reembolsar
    // porque se canceló mientras seguía "pendiente") no debe convertir
    // una cancelación válida en un error para el cliente.
    try {
      await refundPayment(id);
    } catch (e) {
      if (e instanceof Error && e.message !== 'PAGO_NO_ENCONTRADO') {
        console.error(`[cancelServiceRequest] Error al reembolsar el pago de ${id}:`, e);
      }
    }

    if (actual.profesionalId) {
      enviarNotificacion(actual.profesionalId, {
        title: 'Solicitud cancelada',
        body: 'El cliente ha cancelado un trabajo que tenías asignado',
      }, { tipo: 'solicitud_cancelada', solicitudId: id }).catch((e) =>
        console.error(`[cancelServiceRequest] Error al notificar al profesional de ${id}:`, e)
      );
    }

    return res.json({ id, estado: 'cancelada' });
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }
    if (err instanceof Error && err.message === 'NO_AUTORIZADO') {
      return res.status(403).json({ error: 'Solo el cliente que creó esta solicitud puede cancelarla' });
    }
    if (err instanceof Error && err.message === 'YA_NO_CANCELABLE') {
      return res.status(409).json({ error: 'Esta solicitud ya no se puede cancelar — el profesional ya empezó o ya se resolvió' });
    }
    throw err;
  }
}

/**
 * Borra definitivamente una solicitud del historial del cliente —
 * distinto de cancelar (que solo cambia el estado). Solo se permite
 * cuando ningún profesional llegó a aceptarla (profesionalId nulo) y
 * sigue en "pendiente" o "cancelada": en ese caso nunca pudo haber
 * pago retenido ni chat real, así que no hay nada que limpiar aparte
 * ni ningún historial de la otra parte que se pierda al borrarla.
 */
export async function deleteServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const clienteId = req.user!.userId;

  const actual = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!actual) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (actual.clienteId !== clienteId) {
    return res.status(403).json({ error: 'Solo el cliente que creó esta solicitud puede borrarla' });
  }
  if (actual.profesionalId !== null || !['pendiente', 'cancelada'].includes(actual.estado)) {
    return res.status(409).json({ error: 'Solo se pueden borrar solicitudes que nadie llegó a aceptar' });
  }

  await prisma.serviceRequest.delete({ where: { id } });
  return res.status(204).send();
}

/**
 * Quita una solicitud terminada de la lista de quien la pide, sin
 * borrar nada — a diferencia de deleteServiceRequest (arriba), que solo
 * vale para solicitudes que nadie llegó a aceptar. Aquí sí hubo
 * profesional de por medio (pago, chat, valoraciones posibles), así que
 * en vez de borrar se marca "archivado" para esa parte y listMy* la
 * deja de devolver — el historial sigue intacto en la base de datos por
 * si hace falta consultarlo (disputas, contabilidad), la otra parte
 * sigue viéndola en su propia lista hasta que también la archive.
 */
export async function archiveServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user!.userId;

  const actual = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!actual) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (!['completada', 'cancelada'].includes(actual.estado)) {
    return res.status(409).json({ error: 'Solo se pueden archivar solicitudes completadas o canceladas' });
  }

  if (actual.clienteId === userId) {
    await prisma.serviceRequest.update({ where: { id }, data: { archivadoCliente: true } });
    return res.status(204).send();
  }
  if (actual.profesionalId === userId) {
    await prisma.serviceRequest.update({ where: { id }, data: { archivadoProfesional: true } });
    return res.status(204).send();
  }
  return res.status(403).json({ error: 'No participas en esta solicitud' });
}

/**
 * Escribe (o reescribe) en Firestore los UIDs de Firebase del cliente y
 * el profesional de una solicitud — es lo que firestore.rules necesita
 * para autorizar el chat de esa solicitud concreta. Idempotente: se
 * puede llamar tantas veces como haga falta sin efectos secundarios,
 * a propósito, para poder reintentarla desde `syncChat` si el intento
 * original (dentro de acceptServiceRequest) falló en su momento.
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

/**
 * Re-sincroniza el chat de una solicitud ya aceptada. Existe porque la
 * sincronización automática al aceptar (dentro de acceptServiceRequest)
 * puede fallar en silencio (ver el try/catch de ahí) — sin este
 * endpoint, una solicitud que cayó en ese caso se quedaba con el chat
 * roto para siempre, sin ninguna forma de recuperarlo salvo tocar la
 * base de datos a mano. El frontend lo llama cada vez que se abre una
 * pantalla de chat, antes de suscribirse a los mensajes — si ya estaba
 * sincronizado, esto no cambia nada (mismo resultado, misma escritura).
 */
export async function syncChat(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud' });
  }
  if (!solicitud.profesionalId) {
    return res.status(409).json({ error: 'Esta solicitud todavía no tiene profesional asignado' });
  }

  await sincronizarChatFirestore(id, solicitud.clienteId, solicitud.profesionalId);

  return res.json({ sincronizado: true });
}

const chatNotifySchema = z.object({
  texto: z.string().min(1),
});

/**
 * El chat en sí vive 100% en Firestore, sin pasar por este backend (ver
 * chat_service.dart) — así que un mensaje nuevo nunca generaba
 * notificación push, aunque el resto del pipeline de FCM funcionara
 * bien: el backend simplemente no se enteraba de que se había enviado.
 * El frontend llama a este endpoint justo después de escribir el
 * mensaje en Firestore (fire-and-forget, no bloquea el envío) para que
 * el backend dispare el push al otro participante de la solicitud.
 */
export async function notifyChatMessage(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user!.userId;

  const parsed = chatNotifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta el texto del mensaje' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    select: {
      clienteId: true,
      profesionalId: true,
      cliente: { select: { nombre: true } },
      profesional: { select: { user: { select: { nombre: true } } } },
    },
  });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud' });
  }

  const esCliente = solicitud.clienteId === userId;
  const destinatarioId = esCliente ? solicitud.profesionalId : solicitud.clienteId;
  if (!destinatarioId) {
    // Solicitud sin profesional asignado todavía — no hay a quién avisar.
    return res.json({ notificado: false });
  }

  const remitenteNombre = (esCliente ? solicitud.cliente.nombre : solicitud.profesional?.user.nombre) ?? 'Alguien';
  // El título de la notificación es el nombre de quien escribe (no
  // "Nuevo mensaje" genérico) para que se vea igual que cualquier app de
  // mensajería normal — el cuerpo es el mensaje en sí, recortado por si
  // alguien manda un texto larguísimo.
  enviarNotificacion(
    destinatarioId,
    { title: remitenteNombre, body: parsed.data.texto.slice(0, 150) },
    { tipo: 'chat_mensaje', solicitudId: id }
  ).catch((e) => console.error(`[notifyChatMessage] Error al notificar mensaje de chat en ${id}:`, e));

  return res.json({ notificado: true });
}

/**
 * Marca el chat de esta solicitud como leído por quien llama (cliente o
 * profesional). Escribe en el propio documento de la solicitud en
 * Firestore (service_requests/{id}), no en el mensaje — el cliente
 * Flutter no tiene permiso de ESCRITURA sobre ese documento (las reglas
 * de Firestore desplegadas solo le dan `allow read`, ver
 * backend_wizard/firestore.rules), así que esto tiene que pasar por el
 * Admin SDK del backend. El frontend sí puede LEER ese mismo documento
 * en tiempo real, así que estos campos sirven tanto para el indicador
 * de "mensaje nuevo" en las listas de conversaciones como para el
 * check de "leído" dentro del propio chat.
 */
export async function markChatRead(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    select: { clienteId: true, profesionalId: true },
  });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud' });
  }

  const campo = solicitud.clienteId === userId ? 'lastReadCliente' : 'lastReadProfesional';
  await firestore
    .collection('service_requests')
    .doc(id)
    .set({ [campo]: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  return res.json({ ok: true });
}

// acceptServiceRequest ("el primero que acepta gana") se retiró — ver
// postulacion.controller.ts: selectPostulacion, que reutiliza el mismo
// patrón de updateMany atómico pero disparado por la elección del
// cliente entre varias candidaturas, no por el primer profesional que
// pulsa un botón.

const completeRequestSchema = z.object({
  // Solo obligatorio si el presupuesto aceptado es "por_horas" — se
  // valida más abajo, una vez se sabe el tipo (no lo elige el cliente
  // en este body, lo decide el presupuesto ya aceptado).
  horasReales: z.number().positive().optional(),
});

/**
 * "Cerrado": completa y libera el pago en el mismo paso, igual que en
 * la Fase 1 — el importe ya está acordado de antemano, no hay nada
 * que confirmar. "Por_horas": el profesional NO completa directamente
 * aquí — declara las horas reales y se crea un CierreHoras pendiente;
 * la solicitud sigue "aceptada" hasta que el cliente lo confirma (ver
 * responderCierreHoras, más abajo), que es cuando de verdad se libera
 * el pago. Así nunca se libera dinero solo porque el profesional lo
 * declare — el cliente tiene que estar de acuerdo con las horas.
 */
export async function completeServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const parsed = completeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    include: { presupuestos: { where: { estado: 'aceptado' }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud' });
  }
  if (solicitud.estado !== 'aceptada' && solicitud.estado !== 'en_progreso') {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para completarse' });
  }

  const pagoExistente = await prisma.payment.findFirst({ where: { serviceRequestId: id, estado: 'retenido' } });
  if (!pagoExistente) {
    return res.status(409).json({
      error: 'El cliente aún no ha autorizado el pago de este servicio',
    });
  }

  const presupuesto = solicitud.presupuestos[0];
  if (!presupuesto) {
    return res.status(409).json({ error: 'No hay un presupuesto aceptado para esta solicitud' });
  }

  if (presupuesto.tipo === 'por_horas') {
    if (!parsed.data.horasReales) {
      return res.status(400).json({ error: 'Indica las horas reales trabajadas' });
    }

    const yaPendiente = await prisma.cierreHoras.findFirst({ where: { serviceRequestId: id, estado: 'pendiente' } });
    if (yaPendiente) {
      return res.status(409).json({ error: 'Ya hay un cierre pendiente de confirmación del cliente' });
    }

    const cierre = await prisma.cierreHoras.create({
      data: { serviceRequestId: id, horasReales: parsed.data.horasReales },
    });

    enviarNotificacion(solicitud.clienteId, {
      title: 'El profesional ha terminado el trabajo',
      body: 'Confirma las horas trabajadas para liberar el pago',
    }, { tipo: 'cierre_horas_pendiente', solicitudId: id }).catch((e) =>
      console.error(`[completeServiceRequest] Error al notificar al cliente de ${id}:`, e)
    );

    return res.status(202).json({
      solicitudId: id,
      estado: solicitud.estado,
      cierreHorasId: cierre.id,
      pendienteConfirmacion: true,
    });
  }

  const precioFinal = Number(presupuesto.monto);

  await prisma.serviceRequest.update({
    where: { id },
    data: { estado: 'completada', precioFinal, completadaAt: new Date() },
  });

  enviarNotificacion(solicitud.clienteId, {
    title: 'Servicio completado',
    body: '¿Qué tal fue? Cuéntaselo a otros valorando al profesional',
  }, { tipo: 'solicitud_completada', solicitudId: id }).catch((e) =>
    console.error(`[completeServiceRequest] Error al notificar al cliente de ${id}:`, e)
  );

  try {
    const pagoLiberado = await releasePayments(id, precioFinal);
    return res.json({ solicitudId: id, estado: 'completada', pago: pagoLiberado });
  } catch (err) {
    // El servicio queda marcado como completado igualmente; el pago se
    // gestiona/reintenta aparte para no bloquear al profesional por un
    // fallo puntual de Stripe. Un admin puede revisar pagos en estado
    // "retenido" con solicitud "completada" como cola de reintento.
    // Loguear el error real es justo lo que faltaba en el bug del
    // Sprint 3 (el catch lo silenciaba del todo, sin ninguna pista de
    // qué había fallado en Stripe hasta que se investigó a mano).
    console.error(`[completeServiceRequest] Error al liberar el pago de ${id}:`, err);
    return res.status(202).json({
      solicitudId: id,
      estado: 'completada',
      aviso: 'Servicio completado, pero la liberación del pago falló y se reintentará',
    });
  }
}

const responderCierreHorasSchema = z.object({
  accion: z.enum(['aceptar', 'rechazar']),
});

/**
 * El cliente confirma (o rechaza) las horas reales que declaró el
 * profesional en un trabajo "por_horas". Aceptar es lo que de verdad
 * completa la solicitud y libera el pago — antes de esto, el trabajo
 * sigue "aceptada" aunque el profesional ya haya terminado. Rechazar
 * no dispara ninguna renegociación automática: queda para resolverse
 * por chat o, si no hay acuerdo, con una reclamación (createDispute,
 * ya existente) — no se construye un mecanismo nuevo para este caso.
 */
export async function responderCierreHoras(req: Request, res: Response) {
  const { id, cierreId } = req.params;
  const clienteId = req.user!.userId;

  const parsed = responderCierreHorasSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta indicar si aceptas o rechazas las horas declaradas' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    include: { presupuestos: { where: { estado: 'aceptado' }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud' });
  }

  const cierre = await prisma.cierreHoras.findUnique({ where: { id: cierreId } });
  if (!cierre || cierre.serviceRequestId !== id) {
    return res.status(404).json({ error: 'Cierre no encontrado' });
  }

  if (parsed.data.accion === 'rechazar') {
    const { count } = await prisma.cierreHoras.updateMany({
      where: { id: cierreId, estado: 'pendiente' },
      data: { estado: 'rechazado', resueltaAt: new Date() },
    });
    if (count === 0) {
      return res.status(409).json({ error: 'Este cierre ya no está pendiente de respuesta' });
    }
    if (solicitud.profesionalId) {
      enviarNotificacion(solicitud.profesionalId, {
        title: 'El cliente no está de acuerdo con las horas',
        body: 'Habladlo por chat, o el cliente puede abrir una reclamación si no llegáis a un acuerdo',
      }, { tipo: 'cierre_horas_rechazado', solicitudId: id }).catch((e) =>
        console.error(`[responderCierreHoras] Error al notificar al profesional de ${id}:`, e)
      );
    }
    return res.json({ id: cierreId, estado: 'rechazado' });
  }

  const presupuesto = solicitud.presupuestos[0];
  if (!presupuesto) {
    return res.status(409).json({ error: 'No hay un presupuesto aceptado para esta solicitud' });
  }

  const { count } = await prisma.cierreHoras.updateMany({
    where: { id: cierreId, estado: 'pendiente' },
    data: { estado: 'aceptado', resueltaAt: new Date() },
  });
  if (count === 0) {
    return res.status(409).json({ error: 'Este cierre ya no está pendiente de respuesta' });
  }

  const precioFinal = Number(presupuesto.tarifaHora) * Number(cierre.horasReales);

  await prisma.serviceRequest.update({
    where: { id },
    data: { estado: 'completada', precioFinal, completadaAt: new Date() },
  });

  if (solicitud.profesionalId) {
    enviarNotificacion(solicitud.profesionalId, {
      title: 'Horas confirmadas',
      body: 'El cliente ha confirmado las horas trabajadas — el pago ya se ha liberado',
    }, { tipo: 'cierre_horas_aceptado', solicitudId: id }).catch((e) =>
      console.error(`[responderCierreHoras] Error al notificar al profesional de ${id}:`, e)
    );
  }

  try {
    const pagoLiberado = await releasePayments(id, precioFinal);
    return res.json({ id: cierreId, estado: 'aceptado', pago: pagoLiberado });
  } catch (err) {
    console.error(`[responderCierreHoras] Error al liberar el pago de ${id}:`, err);
    return res.status(202).json({
      id: cierreId,
      estado: 'aceptado',
      aviso: 'Horas confirmadas, pero la liberación del pago falló y se reintentará',
    });
  }
}

/**
 * Lista los trabajos del profesional autenticado: en curso (aceptada/
 * en_progreso) Y completados recientes — antes solo incluía los
 * activos, así que en cuanto se completaba un trabajo desaparecía sin
 * dejar forma de valorar al cliente. Se limita a los últimos 50
 * completados para no cargar todo el historial de por vida en esta
 * misma lista.
 */
export async function listMyAssignedRequests(req: Request, res: Response) {
  const profesionalId = req.user!.userId;

  const solicitudes = await prisma.serviceRequest.findMany({
    where: { profesionalId, estado: { in: ['aceptada', 'en_progreso', 'completada'] }, archivadoProfesional: false },
    include: {
      categoria: true,
      cliente: { select: { nombre: true, telefono: true, fotoPerfilUrl: true } },
      pagos: true,
      reviews: true,
      presupuestos: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { ampliaciones: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
      cierresHoras: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { aceptadaAt: 'desc' },
    take: 50,
  });

  return res.json({
    solicitudes: solicitudes.map((s) => {
      const presupuesto = s.presupuestos[0];
      const ampliacion = presupuesto?.ampliaciones[0];
      return {
        id: s.id,
        categoria: s.categoria.nombre,
        descripcion: s.descripcion,
        estado: s.estado,
        direccionTexto: s.direccionTexto,
        clienteNombre: s.cliente.nombre,
        clienteTelefono: s.cliente.telefono,
        clienteFotoUrl: s.cliente.fotoPerfilUrl,
        precioFinal: s.precioFinal ? Number(s.precioFinal) : null,
        presupuesto: serializarPresupuesto(presupuesto),
        ampliacion: serializarAmpliacion(ampliacion),
        cierreHoras: serializarCierreHoras(s.cierresHoras[0]),
        createdAt: s.createdAt,
        tienePago: s.pagos.length > 0,
        payment: agregarPagos(s.pagos),
        tieneValoracion: s.reviews.some((r) => r.autorId === profesionalId),
      };
    }),
  });
}

/**
 * Lista las solicitudes del cliente autenticado, más recientes primero
 * (para la pantalla "Mis solicitudes" y para el seguimiento tras crear
 * una). Endpoint nuevo, de solo lectura, no toca ninguna ruta existente.
 */
export async function listMyServiceRequests(req: Request, res: Response) {
  const clienteId = req.user!.userId;

  const solicitudes = await prisma.serviceRequest.findMany({
    where: { clienteId, archivadoCliente: false },
    include: {
      categoria: true,
      pagos: true,
      reviews: true,
      profesional: { include: { user: { select: { nombre: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return res.json({
    solicitudes: solicitudes.map((s) => ({
      id: s.id,
      categoria: s.categoria.nombre,
      descripcion: s.descripcion,
      profesionalNombre: s.profesional?.user.nombre ?? null,
      estado: s.estado,
      urgencia: s.urgencia,
      precioFinal: s.precioFinal ? Number(s.precioFinal) : null,
      createdAt: s.createdAt,
      tienePago: s.pagos.length > 0,
      // Antes era "¿existe ALGUNA valoración?" — con reviews
      // bidireccionales eso ya no distingue si fue el cliente o el
      // profesional quien la dejó. Ahora comprueba específicamente si
      // el cliente (el dueño de esta lista) ya valoró.
      tieneValoracion: s.reviews.some((r) => r.autorId === clienteId),
    })),
  });
}
