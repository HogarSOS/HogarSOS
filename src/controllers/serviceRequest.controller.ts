import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { firestore } from '../config/firebase';
import { releasePayment } from '../services/payment.service';
import { REQUIRE_PROFESSIONAL_VERIFICATION } from '../config/featureFlags';

const RADIO_BUSQUEDA_METROS = 15000; // 15 km, ajustable por categoría en el futuro

const createRequestSchema = z.object({
  categoryId: z.number().int(),
  descripcion: z.string().min(5).max(1000),
  fotosUrls: z.array(z.string().url()).max(6).optional(),
  direccionTexto: z.string().optional(),
  latitud: z.number().min(-90).max(90),
  longitud: z.number().min(-180).max(180),
  precioEstimado: z.number().positive().optional(),
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
    precioEstimado,
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
      precio_estimado, urgencia, fecha_deseada, ubicacion, estado, created_at
    )
    VALUES (
      uuid_generate_v4(), ${clienteId}::uuid, ${categoryId}, ${descripcion},
      ${fotosUrls ?? []}, ${direccionTexto ?? null}, ${precioEstimado ?? null},
      ${urgencia}::"UrgenciaSolicitud", ${fechaDeseada ? new Date(fechaDeseada) : null},
      ST_SetSRID(ST_MakePoint(${longitud}, ${latitud}), 4326)::geography,
      'pendiente', now()
    )
    RETURNING id
  `;

  return res.status(201).json({ id: solicitud.id, estado: 'pendiente' });
}

export async function getServiceRequestById(req: Request, res: Response) {
  const { id } = req.params;
  const { userId, role } = req.user!;

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    include: { categoria: true, payment: true, review: true },
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

  return res.json({
    id: solicitud.id,
    categoria: solicitud.categoria.nombre,
    descripcion: solicitud.descripcion,
    fotosUrls: solicitud.fotosUrls,
    direccionTexto: solicitud.direccionTexto,
    urgencia: solicitud.urgencia,
    fechaDeseada: solicitud.fechaDeseada,
    precioEstimado: solicitud.precioEstimado ? Number(solicitud.precioEstimado) : null,
    precioFinal: solicitud.precioFinal ? Number(solicitud.precioFinal) : null,
    estado: solicitud.estado,
    createdAt: solicitud.createdAt,
    payment: solicitud.payment
      ? {
          estado: solicitud.payment.estado,
          montoTotal: Number(solicitud.payment.montoTotal),
          comisionPlataforma: Number(solicitud.payment.comisionPlataforma),
          montoProfesional: Number(solicitud.payment.montoProfesional),
        }
      : null,
    review: solicitud.review
      ? { puntuacion: solicitud.review.puntuacion, comentario: solicitud.review.comentario }
      : null,
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
    { id: string; descripcion: string; distancia_metros: number; created_at: Date; urgencia: string }[]
  >`
    SELECT sr.id, sr.descripcion, sr.created_at, sr.urgencia,
           ST_Distance(sr.ubicacion, p.ubicacion_actual) AS distancia_metros
    FROM service_requests sr
    JOIN professionals p ON p.user_id = ${profesionalId}
    WHERE sr.estado = 'pendiente'
      AND sr.category_id = ANY(${categoriaIds})
      AND p.ubicacion_actual IS NOT NULL
      AND ST_DWithin(sr.ubicacion, p.ubicacion_actual, ${RADIO_BUSQUEDA_METROS})
    ORDER BY distancia_metros ASC
    LIMIT 20
  `;

  return res.json({ solicitudes });
}

export async function acceptServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const profesional = await prisma.professional.findUnique({ where: { userId: profesionalId } });
  if (
    !profesional ||
    (REQUIRE_PROFESSIONAL_VERIFICATION && profesional.estadoVerificacion !== 'aprobado')
  ) {
    return res.status(403).json({ error: 'No autorizado para aceptar solicitudes' });
  }

  // Transacción para evitar condición de carrera: dos profesionales
  // no pueden aceptar la misma solicitud a la vez.
  try {
    const solicitud = await prisma.$transaction(async (tx) => {
      const actual = await tx.serviceRequest.findUnique({ where: { id } });

      if (!actual) throw new Error('NOT_FOUND');
      if (actual.estado !== 'pendiente') throw new Error('YA_NO_DISPONIBLE');

      return tx.serviceRequest.update({
        where: { id },
        data: { profesionalId, estado: 'aceptada', aceptadaAt: new Date() },
      });
    });

    // Sincroniza a Firestore los UIDs de Firebase de ambas partes, para
    // que firestore.rules pueda restringir el chat de esta solicitud
    // solo al cliente y al profesional asignado (ver backend/firestore.rules).
    //
    // Aparte, en su propio try/catch a propósito: aceptar la solicitud ya
    // quedó confirmado en Postgres arriba — si esto falla (p. ej. la API
    // de Firestore deshabilitada en el proyecto), no debe convertir un
    // "aceptado con éxito" en un 500 para el profesional. El chat de esa
    // solicitud puede quedar sin sincronizar, pero la aceptación es real.
    try {
      const [cliente, profesional] = await Promise.all([
        prisma.user.findUnique({ where: { id: solicitud.clienteId } }),
        prisma.user.findUnique({ where: { id: profesionalId } }),
      ]);

      await firestore.collection('service_requests').doc(id).set(
        {
          clienteFirebaseUid: cliente?.firebaseUid ?? null,
          profesionalFirebaseUid: profesional?.firebaseUid ?? null,
        },
        { merge: true }
      );
    } catch (firestoreErr) {
      console.error(`[acceptServiceRequest] Fallo al sincronizar Firestore para ${id}:`, firestoreErr);
    }

    return res.json(solicitud);
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }
    if (err instanceof Error && err.message === 'YA_NO_DISPONIBLE') {
      return res.status(409).json({ error: 'La solicitud ya no está disponible' });
    }
    throw err;
  }
}

const completeRequestSchema = z.object({
  precioFinal: z.number().positive(),
});

/**
 * Marca la solicitud como completada y libera el pago retenido:
 * captura el cargo en Stripe y transfiere al profesional (menos comisión).
 * El pago debe existir ya en estado "retenido" — se crea antes, cuando
 * el cliente autoriza el cargo (ver payment.controller.ts).
 */
export async function completeServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const parsed = completeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta el precio final del servicio' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({ where: { id } });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud' });
  }
  if (solicitud.estado !== 'aceptada' && solicitud.estado !== 'en_progreso') {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para completarse' });
  }

  const pagoExistente = await prisma.payment.findUnique({ where: { serviceRequestId: id } });
  if (!pagoExistente) {
    return res.status(409).json({
      error: 'El cliente aún no ha autorizado el pago de este servicio',
    });
  }

  await prisma.serviceRequest.update({
    where: { id },
    data: { estado: 'completada', precioFinal: parsed.data.precioFinal, completadaAt: new Date() },
  });

  try {
    const pagoLiberado = await releasePayment(id);
    return res.json({ solicitudId: id, estado: 'completada', pago: pagoLiberado });
  } catch (err) {
    // El servicio queda marcado como completado igualmente; el pago se
    // gestiona/reintenta aparte para no bloquear al profesional por un
    // fallo puntual de Stripe. Un admin puede revisar pagos en estado
    // "retenido" con solicitud "completada" como cola de reintento.
    return res.status(202).json({
      solicitudId: id,
      estado: 'completada',
      aviso: 'Servicio completado, pero la liberación del pago falló y se reintentará',
    });
  }
}

/**
 * Lista las solicitudes del cliente autenticado, más recientes primero
 * (para la pantalla "Mis solicitudes" y para el seguimiento tras crear
 * una). Endpoint nuevo, de solo lectura, no toca ninguna ruta existente.
 */
export async function listMyServiceRequests(req: Request, res: Response) {
  const clienteId = req.user!.userId;

  const solicitudes = await prisma.serviceRequest.findMany({
    where: { clienteId },
    include: { categoria: true, payment: true, review: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return res.json({
    solicitudes: solicitudes.map((s) => ({
      id: s.id,
      categoria: s.categoria.nombre,
      descripcion: s.descripcion,
      estado: s.estado,
      urgencia: s.urgencia,
      precioEstimado: s.precioEstimado ? Number(s.precioEstimado) : null,
      precioFinal: s.precioFinal ? Number(s.precioFinal) : null,
      createdAt: s.createdAt,
      tienePago: Boolean(s.payment),
      tieneValoracion: Boolean(s.review),
    })),
  });
}
