import { Request, Response } from 'express';
import { z } from 'zod';
import admin from 'firebase-admin';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { firestore } from '../config/firebase';
import { releasePayments, refundPayment, diagnosticarPagoSinConfirmar } from '../services/payment.service';
import { asociarArchivosASolicitud } from '../services/archivo.service';
import { REQUIRE_PROFESSIONAL_VERIFICATION } from '../config/featureFlags';
import { enviarNotificacion, enviarNotificacionMasiva, enviarNotificacionCruda } from '../services/notification.service';

const RADIO_BUSQUEDA_METROS = 50000; // 50 km, ajustable por categoría en el futuro

// Pasadas estas horas sin que ningún profesional la acepte, una solicitud
// deja de ofrecerse como "nueva disponible" en listNearbyRequests — no se
// cancela ni se toca su estado (el cliente la sigue viendo pendiente en su
// propia lista), simplemente ya no tiene sentido mostrarla como si acabara
// de llegar.
const SOLICITUD_EXPIRA_HORAS = 48;

// Protección anti-evasión de comisión en presupuestos "por_horas"
// (auditoría 2026-08-14): el cliente autoriza en Stripe tarifaHora ×
// horasEstimadas, pero el importe que de verdad se captura y comisiona
// es tarifaHora × horasReales, un número que declara el profesional
// libremente al cerrar. Sin ningún control, un profesional (a veces en
// connivencia con el cliente) puede declarar unas horasReales muy por
// debajo de lo estimado — el resto de la autorización se libera sola,
// sin cobrar nada, y esa diferencia puede pagarse en mano fuera de la
// app. Dos umbrales, con objetivos distintos:
//
// - UMBRAL_MINIMO_ABSOLUTO_HORAS: un suelo físico, independiente de la
//   estimación. Ningún servicio a domicilio real de este catálogo
//   (fontanería, electricidad, limpieza, pet sitting...) se completa en
//   menos de 30 minutos una vez el profesional se ha desplazado — por
//   debajo de eso, el valor no es una reducción legítima, es un dato
//   fabricado. Se bloquea directamente (400), no se pide confirmación.
// - UMBRAL_RATIO_REDUCCION_ANOMALA: una estimación de horas es, por
//   naturaleza, aproximada — el profesional la hace sin haber visto
//   todavía el alcance real del trabajo, así que terminar en un 60-70%
//   de lo estimado es normal y no debe generar fricción. Caer por
//   debajo de la MITAD de lo estimado es un patrón mucho más raro
//   estadísticamente y es exactamente la firma del escenario de evasión
//   descrito en la auditoría (10h estimadas → 1h reales = 10%). No se
//   bloquea (podría ser legítimo: el profesional se equivocó al
//   estimar) pero exige que el cliente confirme explícitamente viendo
//   la comparación, en vez de poder aceptarlo sin darse cuenta.
export const UMBRAL_MINIMO_ABSOLUTO_HORAS = 0.5;
export const UMBRAL_RATIO_REDUCCION_ANOMALA = 0.5;

/**
 * Compara horasReales contra horasEstimadas y determina si la
 * reducción es lo bastante grande como para requerir confirmación
 * explícita adicional del cliente. Sin horasEstimadas (no debería
 * pasar para un presupuesto por_horas ya aceptado, pero el campo es
 * nullable en el schema) no hay nada que comparar.
 */
export function evaluarReduccionHoras(horasReales: number, horasEstimadas: number | null) {
  if (!horasEstimadas || horasEstimadas <= 0) {
    return { anomala: false, porcentaje: null as number | null };
  }
  const porcentaje = Math.round((horasReales / horasEstimadas) * 100);
  return { anomala: horasReales < horasEstimadas * UMBRAL_RATIO_REDUCCION_ANOMALA, porcentaje };
}

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
  incluyeIva: boolean;
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
    incluyeIva: p.incluyeIva,
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

/**
 * Misma idea, para el último CierreHoras de una solicitud (cualquier
 * estado). Recibe también `horasEstimadas` (del presupuesto por_horas
 * al que pertenece, no de la propia fila CierreHoras) para poder
 * exponer `reduccionAnomala`/`porcentaje` sin necesidad de guardarlos
 * — la comparación siempre se hace contra el valor vigente, y
 * `horasEstimadas` de un presupuesto ya aceptado es inmutable (ver
 * presupuesto.controller.ts), así que no hay riesgo de que cambie
 * entre el cálculo original y esta serialización.
 */
function serializarCierreHoras(
  c: { id: string; horasReales: Prisma.Decimal; estado: string; createdAt: Date } | undefined,
  horasEstimadas?: Prisma.Decimal | null
) {
  if (!c) return null;
  const horasRealesNum = Number(c.horasReales);
  const horasEstimadasNum = horasEstimadas ? Number(horasEstimadas) : null;
  const anomalia = evaluarReduccionHoras(horasRealesNum, horasEstimadasNum);
  return {
    id: c.id,
    horasReales: horasRealesNum,
    horasEstimadas: horasEstimadasNum,
    estado: c.estado,
    createdAt: c.createdAt,
    reduccionAnomala: anomalia.anomala,
    porcentaje: anomalia.porcentaje,
  };
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
  pagos: {
    estado: string;
    montoBase: Prisma.Decimal;
    montoTotal: Prisma.Decimal;
    comisionPlataforma: Prisma.Decimal;
    montoProfesional: Prisma.Decimal;
  }[]
) {
  // 'pendiente' (PaymentIntent creado, cliente todavía no confirmó el
  // Payment Sheet) no cuenta como un pago real todavía — mostrarlo aquí
  // es justo el bug que hacía ver una solicitud como "pagada"/"autorizada"
  // sin que Stripe hubiera confirmado nada. Si solo hay filas 'pendiente',
  // se trata igual que si no hubiera ningún pago.
  const pagosConfirmados = pagos.filter((p) => p.estado !== 'pendiente');
  if (pagosConfirmados.length === 0) return null;

  // M1 (auditoría Fable 2026-08-15): 'capturado' (cliente ya cobrado,
  // transferencia al profesional atascada a medias — ver comentario en
  // completeServiceRequest) no estaba contemplado aquí, así que un pago
  // en ese estado caía al 'reembolsado' del final con importes en 0, el
  // extremo opuesto de lo que en realidad pasó. Se trata igual que
  // 'retenido': el trabajo sigue "en curso" desde la perspectiva del
  // cliente/profesional, la liberación se reintenta sola (o vía admin).
  const estado = pagosConfirmados.some((p) => p.estado === 'retenido' || p.estado === 'capturado')
    ? 'retenido'
    : pagosConfirmados.some((p) => p.estado === 'liberado')
      ? 'liberado'
      : pagosConfirmados.some((p) => p.estado === 'fallido')
        ? 'fallido'
        : 'reembolsado';

  const relevantes = pagosConfirmados.filter(
    (p) => p.estado === 'retenido' || p.estado === 'capturado' || p.estado === 'liberado'
  );
  const sumar = (clave: 'montoBase' | 'montoTotal' | 'comisionPlataforma' | 'montoProfesional') =>
    Number(relevantes.reduce((acc, p) => acc + Number(p[clave]), 0).toFixed(2));

  return {
    estado,
    montoBase: sumar('montoBase'),
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
export function calcularPagoPendienteDeAutorizar(
  presupuesto: { id: string; estado: string } | undefined,
  ampliacion: { id: string; estado: string } | undefined,
  pagos: { presupuestoId: string; ampliacionId: string | null; estado: string }[]
): boolean {
  if (!presupuesto || presupuesto.estado !== 'aceptado') return false;
  // 'pendiente' no cuenta como "ya autorizado" (ver agregarPagos más
  // arriba) — si el único Payment que hay para este presupuesto/
  // ampliación se quedó en 'pendiente' (Payment Sheet abandonado o
  // fallido antes de confirmarse), el botón "Autorizar pago" debe seguir
  // visible para que el cliente pueda reintentarlo.
  const confirmados = pagos.filter((p) => p.estado !== 'pendiente');
  const tienePagoInicial = confirmados.some((p) => p.presupuestoId === presupuesto.id && !p.ampliacionId);
  if (!tienePagoInicial) return true;
  if (ampliacion && ampliacion.estado === 'aceptado') {
    const tienePagoAmpliacion = confirmados.some((p) => p.ampliacionId === ampliacion.id);
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
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
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
    return res.status(400).json({ error: 'fechaDeseada es obligatoria cuando urgencia es "fecha_especifica"', code: 'REQUEST_DATE_REQUIRED' });
  }

  const categoria = await prisma.serviceCategory.findUnique({ where: { id: categoryId } });
  if (!categoria || !categoria.activo) {
    return res.status(404).json({ error: 'Categoría de servicio no válida', code: 'CATEGORY_INVALID' });
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

  // Las fotos se subieron ANTES de que esta solicitud existiera (el
  // asistente sube y luego crea), así que este es el primer momento en
  // que se puede saber a qué pertenecen. Sin esta asociación no habría
  // forma de comprobar después si quien pide ver la foto es participante
  // de la solicitud (auditoría B4).
  await asociarArchivosASolicitud(fotosUrls ?? [], solicitud.id, 'foto_solicitud', clienteId);

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
    'nueva_solicitud',
    { categoria: categoriaNombre },
    { solicitudId }
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
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }

  // Un cliente o profesional solo puede ver sus propias solicitudes;
  // el admin puede ver cualquiera. Esto complementa (no sustituye) el
  // row-level security recomendado a nivel de base de datos.
  const esParticipante = solicitud.clienteId === userId || solicitud.profesionalId === userId;
  if (role !== 'admin' && !esParticipante) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud', code: 'REQUEST_NO_ACCESS' });
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
    cierreHoras: serializarCierreHoras(solicitud.cierresHoras[0], presupuesto?.horasEstimadas),
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
type FilaNearbyRequest = {
  estadoVerificacion: string;
  disponible: boolean;
  categoriaIds: number[];
  id: string | null;
  descripcion: string | null;
  distanciaMetros: number | null;
  createdAt: Date | null;
  urgencia: string | null;
  clienteNombre: string | null;
  clienteFotoUrl: string | null;
  yaPostulado: boolean;
};

export async function listNearbyRequests(req: Request, res: Response) {
  const profesionalId = req.user!.userId;

  const noExpiradaDesde = new Date(Date.now() - SOLICITUD_EXPIRA_HORAS * 60 * 60 * 1000);

  // Segunda investigación B-01 (2026-08-17): el intento anterior (P0)
  // fusionaba el findUnique del profesional + este $queryRaw dentro de
  // un prisma.$transaction — reducía el NÚMERO de adquisiciones de
  // conexión (2 a 1) pero, al ir envuelto en BEGIN/COMMIT y retener la
  // misma conexión sin liberarla entre las dos consultas, midió PEOR
  // bajo carga real (P95 más alto en los 3 niveles, 5 errores 500 reales
  // a 75 usuarios que antes no existían) — revertido tras confirmarlo
  // contra producción (ver docs/auditoria/prueba_estres_B01_2026-08-17.md).
  //
  // Esta versión no usa $transaction en absoluto: es UNA sola sentencia
  // $queryRaw autocommit, el mismo patrón de uso de conexión que
  // assigned/mine y mine (que nunca fallaron, ni antes ni después de
  // P0) — no solo menos adquisiciones, sino ninguna retención prolongada.
  //
  // El CTE `prof` siempre da 0 filas si el profesional no existe (con lo
  // que toda la consulta da 0 filas → 404), o exactamente 1 fila en
  // cualquier otro caso — el LEFT JOIN a service_requests solo aporta
  // filas si `disponible=true` (si no, sr.* queda NULL, igual que el
  // "no disponible" del código anterior) y ANY() sobre un array de
  // categorías vacío nunca es cierto (igual que "sin categorías").
  // Verificado con EXPLAIN ANALYZE y con los 7 casos reales posibles
  // contra producción antes de escribir esto (ver informe).
  const filas = await prisma.$queryRaw<FilaNearbyRequest[]>`
    WITH prof AS (
      SELECT
        p.user_id, p.estado_verificacion, p.disponible, p.ubicacion_actual,
        COALESCE(
          (SELECT array_agg(pc.category_id) FROM professional_categories pc WHERE pc.professional_id = p.user_id),
          '{}'
        ) AS categoria_ids
      FROM professionals p
      WHERE p.user_id = ${profesionalId}
    )
    SELECT
      prof.estado_verificacion AS "estadoVerificacion",
      prof.disponible,
      prof.categoria_ids AS "categoriaIds",
      sr.id, sr.descripcion,
      ST_Distance(sr.ubicacion, prof.ubicacion_actual) AS "distanciaMetros",
      sr.created_at AS "createdAt", sr.urgencia,
      u.nombre AS "clienteNombre", u.foto_perfil_url AS "clienteFotoUrl",
      (po.id IS NOT NULL) AS "yaPostulado"
    FROM prof
    LEFT JOIN service_requests sr
      ON prof.disponible = true
      AND sr.estado = 'pendiente'
      AND sr.category_id = ANY(prof.categoria_ids)
      AND sr.created_at > ${noExpiradaDesde}
      AND prof.ubicacion_actual IS NOT NULL
      AND ST_DWithin(sr.ubicacion, prof.ubicacion_actual, ${RADIO_BUSQUEDA_METROS})
    LEFT JOIN users u ON u.id = sr.cliente_id
    -- Ignorada por este profesional (ver ignorarSolicitud,
    -- postulacion.controller.ts) — desaparece de la lista, a diferencia
    -- de una candidatura real (po.estado='pendiente'), que se queda
    -- visible con yaPostulado=true.
    LEFT JOIN postulaciones po ON po.service_request_id = sr.id AND po.profesional_id = ${profesionalId}
    WHERE (po.id IS NULL OR po.estado != 'ignorada')
    ORDER BY "distanciaMetros" ASC NULLS LAST
    LIMIT 20
  `;

  if (filas.length === 0) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }

  const estado = filas[0];

  if (REQUIRE_PROFESSIONAL_VERIFICATION && estado.estadoVerificacion !== 'aprobado') {
    return res.status(403).json({ error: 'Tu cuenta aún no ha sido verificada', code: 'ACCOUNT_NOT_VERIFIED' });
  }

  if (!estado.disponible) {
    return res.status(200).json({ solicitudes: [], aviso: 'Estás marcado como no disponible' });
  }

  if (estado.categoriaIds.length === 0) {
    return res.status(200).json({ solicitudes: [], aviso: 'No tienes categorías configuradas' });
  }

  // La fila "solo de estado" (cuando disponible/categorías pasan el
  // filtro pero no hay ninguna solicitud real que coincida) trae
  // id=null — sin este filtro se devolvería una solicitud fantasma con
  // todos los campos en null.
  const solicitudes = filas
    .filter((f) => f.id !== null)
    .map((f) => ({
      id: f.id,
      descripcion: f.descripcion,
      created_at: f.createdAt,
      urgencia: f.urgencia,
      distancia_metros: f.distanciaMetros,
      cliente_nombre: f.clienteNombre,
      cliente_foto_url: f.clienteFotoUrl,
      ya_postulado: f.yaPostulado,
    }));

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

    // A4 (auditoría Fable 2026-08-15): "Iniciar trabajo" es opcional por
    // diseño (ver EN_CURSO_USAR_DISPUTA más abajo), así que un
    // profesional que nunca lo pulsó podía terminar el trabajo, declarar
    // sus horas (CierreHoras 'pendiente') y el cliente igual cancelaba
    // desde aquí — 'aceptada' seguía siendo un estado cancelable — con
    // reembolso total de un trabajo ya entregado. La existencia de un
    // CierreHoras 'pendiente' es la señal objetiva de "ya se entregó",
    // así que se excluye atómicamente en el propio updateMany (mismo
    // WHERE, sin una lectura aparte que pueda quedar desfasada).
    const { count } = await prisma.serviceRequest.updateMany({
      where: {
        id, clienteId, estado: { in: ['pendiente', 'aceptada'] },
        cierresHoras: { none: { estado: 'pendiente' } },
      },
      data: { estado: 'cancelada' },
    });
    if (count === 0) {
      // Auditoría: `actual.estado` es una foto de ANTES del UPDATE
      // atómico de arriba — si el profesional pulsó "Iniciar trabajo"
      // justo en medio (aceptada -> en_progreso), esa foto sigue
      // diciendo "aceptada" aunque el UPDATE ya haya fallado por el
      // motivo correcto. Usarla aquí daría el mensaje genérico en vez
      // de "abre una reclamación", aunque la propia cancelación ya se
      // bloqueó bien. Una relectura de solo lectura (nunca un segundo
      // WRITE, nunca toca Stripe, no compite con nada) es suficiente
      // para acertar el mensaje sin tocar la atomicidad de la decisión
      // real, que ya tomó el UPDATE de arriba.
      const actualizado = await prisma.serviceRequest.findUnique({
        where: { id },
        select: { estado: true, cierresHoras: { where: { estado: 'pendiente' }, select: { id: true }, take: 1 } },
      });
      if (actualizado?.estado === 'en_progreso') throw new Error('EN_CURSO_USAR_DISPUTA');
      if ((actualizado?.cierresHoras?.length ?? 0) > 0) throw new Error('CIERRE_PENDIENTE_USAR_DISPUTA');
      throw new Error('YA_NO_CANCELABLE');
    }

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
      enviarNotificacion(actual.profesionalId, 'solicitud_cancelada', {}, { solicitudId: id }).catch((e) =>
        console.error(`[cancelServiceRequest] Error al notificar al profesional de ${id}:`, e)
      );
    }

    return res.json({ id, estado: 'cancelada' });
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
    }
    if (err instanceof Error && err.message === 'NO_AUTORIZADO') {
      return res.status(403).json({ error: 'Solo el cliente que creó esta solicitud puede cancelarla', code: 'REQUEST_ONLY_CREATOR_CANCEL' });
    }
    if (err instanceof Error && err.message === 'YA_NO_CANCELABLE') {
      return res.status(409).json({ error: 'Esta solicitud ya no se puede cancelar — el profesional ya empezó o ya se resolvió', code: 'REQUEST_CANNOT_CANCEL' });
    }
    if (err instanceof Error && err.message === 'EN_CURSO_USAR_DISPUTA') {
      return res.status(409).json({
        error: 'El profesional ya ha marcado este trabajo como en curso — para cancelarlo ahora, abre una reclamación',
        code: 'REQUEST_IN_PROGRESS_USE_DISPUTE',
      });
    }
    if (err instanceof Error && err.message === 'CIERRE_PENDIENTE_USAR_DISPUTA') {
      return res.status(409).json({
        error: 'El profesional ya declaró las horas trabajadas de este servicio — para cancelarlo ahora, abre una reclamación',
        code: 'REQUEST_HOURS_CLOSURE_PENDING_USE_DISPUTE',
      });
    }
    throw err;
  }
}

/**
 * El profesional marca que ha empezado a trabajar de verdad —
 * "aceptada" -> "en_progreso". Protege su cobro: a partir de aquí
 * `cancelServiceRequest` deja de aceptar la cancelación instantánea del
 * cliente (ver EN_CURSO_USAR_DISPUTA arriba), que solo puede recurrir a
 * una reclamación (createDispute) si de verdad necesita echarse atrás.
 *
 * Deliberadamente NO obligatorio para poder completar el trabajo:
 * `completeServiceRequest` ya acepta tanto "aceptada" como
 * "en_progreso" — este botón es una protección opcional que el
 * profesional puede usar o no, no una puerta que haya que cruzar sí o
 * sí. Mismo patrón atómico que el resto del archivo: el `updateMany`
 * condicionado al estado actual es la única sección crítica.
 */
export async function startServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const actual = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!actual) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (actual.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud', code: 'NOT_ASSIGNED_PROFESSIONAL' });
  }

  const { count } = await prisma.serviceRequest.updateMany({
    where: { id, profesionalId, estado: 'aceptada' },
    data: { estado: 'en_progreso', iniciadoAt: new Date() },
  });
  if (count === 0) {
    return res.status(409).json({
      error: 'Esta solicitud no está en un estado válido para iniciar el trabajo',
      code: 'REQUEST_INVALID_STATE_START',
    });
  }

  enviarNotificacion(actual.clienteId, 'trabajo_en_curso', {}, { solicitudId: id }).catch((e) =>
    console.error(`[startServiceRequest] Error al notificar al cliente de ${id}:`, e)
  );

  return res.json({ id, estado: 'en_progreso' });
}

/**
 * Deshace un "Iniciar trabajo" pulsado por error — "en_progreso" ->
 * "aceptada" de nuevo. A propósito NO toca Stripe ni genera ningún
 * reembolso: la retención de la autorización es la misma en "aceptada"
 * que en "en_progreso" (ver createEscrowPaymentIntent), este endpoint
 * solo revierte la protección frente a la cancelación del cliente, no
 * el dinero. Solo el propio profesional puede deshacer su propio inicio
 * — nunca perjudica al cliente (solo le devuelve la cancelación
 * instantánea), así que no hace falta ninguna ventana de tiempo ni
 * revisión aparte.
 */
export async function undoStartServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const profesionalId = req.user!.userId;

  const actual = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!actual) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (actual.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud', code: 'NOT_ASSIGNED_PROFESSIONAL' });
  }

  const { count } = await prisma.serviceRequest.updateMany({
    where: { id, profesionalId, estado: 'en_progreso' },
    data: { estado: 'aceptada', iniciadoAt: null },
  });
  if (count === 0) {
    return res.status(409).json({
      error: 'Esta solicitud no está "en curso", no hay nada que deshacer',
      code: 'REQUEST_NOT_IN_PROGRESS',
    });
  }

  return res.json({ id, estado: 'aceptada' });
}

/**
 * Borra definitivamente una solicitud del historial del cliente —
 * distinto de cancelar (que solo cambia el estado). Solo se permite
 * cuando ningún profesional llegó a aceptarla (profesionalId nulo) y
 * sigue en "pendiente" o "cancelada": en ese caso nunca pudo haber
 * pago retenido ni chat real, así que no hay ningún historial de la
 * otra parte que se pierda al borrarla.
 *
 * SÍ puede haber Postulacion en estado 'pendiente' (candidaturas reales
 * sin resolver) o 'ignorada' (ver ignorarSolicitud, postulacion.controller.ts)
 * — la FK postulaciones_service_request_id_fkey es ON DELETE RESTRICT a
 * propósito (auditoría 2026-08-16), así que hay que borrarlas primero,
 * en la misma transacción. 'aceptada'/'rechazada' nunca coexisten con
 * profesionalId=null (ambas solo se escriben dentro de la transacción
 * de selectPostulacion, que fija profesionalId Y el estado a la vez) —
 * el guard de arriba ya las bloquea antes de llegar aquí, así que
 * deliberadamente NO se incluyen en este borrado: si alguna vez esa
 * invariante se rompiera por otro camino, la FK debe seguir frenando el
 * borrado en vez de perder ese historial en silencio.
 */
export async function deleteServiceRequest(req: Request, res: Response) {
  const { id } = req.params;
  const clienteId = req.user!.userId;

  const actual = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!actual) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (actual.clienteId !== clienteId) {
    return res.status(403).json({ error: 'Solo el cliente que creó esta solicitud puede borrarla', code: 'REQUEST_ONLY_CREATOR_DELETE' });
  }
  if (actual.profesionalId !== null || !['pendiente', 'cancelada'].includes(actual.estado)) {
    return res.status(409).json({ error: 'Solo se pueden borrar solicitudes que nadie llegó a aceptar', code: 'REQUEST_CANNOT_DELETE_ACCEPTED' });
  }

  await prisma.$transaction([
    prisma.postulacion.deleteMany({
      where: { serviceRequestId: id, estado: { in: ['pendiente', 'ignorada'] } },
    }),
    prisma.serviceRequest.delete({ where: { id } }),
  ]);
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
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (!['completada', 'cancelada'].includes(actual.estado)) {
    return res.status(409).json({ error: 'Solo se pueden archivar solicitudes completadas o canceladas', code: 'REQUEST_CANNOT_ARCHIVE' });
  }

  if (actual.clienteId === userId) {
    await prisma.serviceRequest.update({ where: { id }, data: { archivadoCliente: true } });
    return res.status(204).send();
  }
  if (actual.profesionalId === userId) {
    await prisma.serviceRequest.update({ where: { id }, data: { archivadoProfesional: true } });
    return res.status(204).send();
  }
  return res.status(403).json({ error: 'No participas en esta solicitud', code: 'REQUEST_NO_ACCESS' });
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
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud', code: 'REQUEST_NO_ACCESS' });
  }
  if (!solicitud.profesionalId) {
    return res.status(409).json({ error: 'Esta solicitud todavía no tiene profesional asignado', code: 'REQUEST_NO_PROFESSIONAL_ASSIGNED' });
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
    return res.status(400).json({ error: 'Falta el texto del mensaje', code: 'CHAT_MESSAGE_REQUIRED' });
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
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud', code: 'REQUEST_NO_ACCESS' });
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
  enviarNotificacionCruda(
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
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== userId && solicitud.profesionalId !== userId) {
    return res.status(403).json({ error: 'No participas en esta solicitud', code: 'REQUEST_NO_ACCESS' });
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

// El texto anterior ("...la liberación del pago falló y se reintentará")
// era falso: no existía ninguna cola de reintento, así que un pago que
// fallaba aquí no se recuperaba nunca sin intervención manual en el
// dashboard de Stripe. Ahora la liberación es reanudable desde el punto
// exacto en que se quedó y hay endpoints de admin para forzarla
// (GET /api/admin/payments/stuck, POST /api/admin/payments/:id/retry),
// así que el aviso ya describe lo que de verdad ocurre.
const AVISO_LIBERACION_PENDIENTE =
  'Servicio completado. El cobro no ha podido completarse todavía y ha quedado en la cola de reintento — el importe no se pierde.';

// P1 (auditoría 2026-08-14): PAGO_NO_AUTORIZADO_TODAVIA agrupaba bajo un
// único aviso genérico dos situaciones distintas — que el cliente nunca
// confirmara el Payment Sheet, o que SÍ lo hiciera y esa autorización ya
// hubiera caducado (B5). diagnosticarPagoSinConfirmar distingue ambas
// releyendo el estado real en Stripe. El texto de "caducada" reutiliza
// la misma terminología que ya usan las notificaciones de B5
// (autorizacion_caducada, ver i18n/notifications.ts) para no introducir
// vocabulario nuevo.
function avisoPagoSinConfirmar(
  prefijo: string,
  motivo: 'nunca_autorizado' | 'autorizacion_caducada'
): string {
  return motivo === 'autorizacion_caducada'
    ? `${prefijo}, pero la autorización de pago del cliente ha caducado: hay que autorizarlo de nuevo en la app`
    : `${prefijo}, pero el cliente todavía no ha confirmado el pago en la app`;
}

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
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    include: {
      presupuestos: {
        where: { estado: 'aceptado' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { ampliaciones: { where: { estado: 'aceptado' } } },
      },
    },
  });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.profesionalId !== profesionalId) {
    return res.status(403).json({ error: 'No eres el profesional asignado a esta solicitud', code: 'NOT_ASSIGNED_PROFESSIONAL' });
  }
  if (solicitud.estado !== 'aceptada' && solicitud.estado !== 'en_progreso') {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para completarse', code: 'REQUEST_INVALID_STATE_COMPLETE' });
  }

  // 'capturado' cuenta igual que 'retenido': es una autorización que el
  // cliente SÍ confirmó y de la que ya se cobró, pero cuya transferencia
  // al profesional se quedó a medias en un intento anterior. Sin
  // incluirlo aquí, un trabajo con la liberación a medio terminar
  // respondería "el cliente aún no ha autorizado el pago", que es falso
  // y justo lo contrario de lo que pasa.
  const pagosConfirmados = await prisma.payment.findMany({
    where: { serviceRequestId: id, estado: { in: ['retenido', 'capturado'] } },
    select: { ampliacionId: true },
  });
  if (pagosConfirmados.length === 0) {
    return res.status(409).json({
      error: 'El cliente aún no ha autorizado el pago de este servicio', code: 'PAYMENT_NOT_AUTHORIZED',
    });
  }

  const presupuesto = solicitud.presupuestos[0];
  if (!presupuesto) {
    return res.status(409).json({ error: 'No hay un presupuesto aceptado para esta solicitud', code: 'NO_ACCEPTED_BUDGET' });
  }

  if (presupuesto.tipo === 'por_horas') {
    if (!parsed.data.horasReales) {
      return res.status(400).json({ error: 'Indica las horas reales trabajadas', code: 'HOURS_REQUIRED' });
    }

    // Suelo físico anti-evasión (ver UMBRAL_MINIMO_ABSOLUTO_HORAS más
    // arriba) — se bloquea aquí, no se pide confirmación, porque un
    // valor por debajo de este suelo no es una reducción legítima que
    // el cliente pueda razonablemente aceptar, es un dato fabricado.
    if (parsed.data.horasReales < UMBRAL_MINIMO_ABSOLUTO_HORAS) {
      return res.status(400).json({
        error: `Las horas reales declaradas son inferiores al mínimo permitido (${UMBRAL_MINIMO_ABSOLUTO_HORAS}h)`,
        code: 'HOURS_TOO_LOW',
      });
    }

    const yaPendiente = await prisma.cierreHoras.findFirst({ where: { serviceRequestId: id, estado: 'pendiente' } });
    if (yaPendiente) {
      return res.status(409).json({ error: 'Ya hay un cierre pendiente de confirmación del cliente', code: 'HOURS_CLOSURE_ALREADY_PENDING' });
    }

    // El findFirst de arriba es solo fast-path (evita una escritura
    // innecesaria en el caso normal) — la garantía real es el índice
    // único parcial `cierres_horas_pendiente_unico` (WHERE
    // estado='pendiente'). Sin él, dos peticiones casi simultáneas
    // podían pasar ambas el findFirst (ninguna ve todavía la fila de
    // la otra) y crear dos CierreHoras "pendiente" para la misma
    // solicitud — mismo patrón ya usado para candidaturas, ver
    // postulacion.controller.ts.
    let cierre;
    try {
      cierre = await prisma.cierreHoras.create({
        data: { serviceRequestId: id, horasReales: parsed.data.horasReales },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return res.status(409).json({ error: 'Ya hay un cierre pendiente de confirmación del cliente', code: 'HOURS_CLOSURE_ALREADY_PENDING' });
      }
      throw err;
    }

    enviarNotificacion(solicitud.clienteId, 'cierre_horas_pendiente', {}, { solicitudId: id }).catch((e) =>
      console.error(`[completeServiceRequest] Error al notificar al cliente de ${id}:`, e)
    );

    return res.status(202).json({
      solicitudId: id,
      estado: solicitud.estado,
      cierreHorasId: cierre.id,
      pendienteConfirmacion: true,
    });
  }

  // "cerrado": el importe final es el monto base más cualquier
  // ampliación (montoAdicional) que el cliente haya aceptado — cada una
  // tiene su propia autorización de Stripe retenida aparte (ver
  // createPaymentIntent), y releasePayments necesita conocer la suma
  // total para no dejarlas fuera y cancelarlas sin cobrar.
  //
  // A2 (auditoría Fable 2026-08-15): aceptar una ampliación (ver
  // responderAmpliacion) NO autoriza su pago por sí solo — es un paso
  // aparte que el cliente puede no haber completado todavía. Sin este
  // check, precioFinal sumaba montoAdicional igualmente y
  // releasePayments capturaba de menos en silencio (infra-cobro del
  // profesional, invisible para cualquier cola de admin).
  const ampliacionSinPago = presupuesto.ampliaciones.find(
    (a) => !pagosConfirmados.some((p) => p.ampliacionId === a.id)
  );
  if (ampliacionSinPago) {
    return res.status(409).json({
      error: 'Hay una ampliación aceptada cuyo pago todavía no está autorizado', code: 'AMPLIACION_SIN_PAGO_CONFIRMADO',
    });
  }

  const montoAmpliaciones = presupuesto.ampliaciones.reduce(
    (acc, a) => acc + Number(a.montoAdicional ?? 0),
    0
  );
  const precioFinal = Number(presupuesto.monto) + montoAmpliaciones;

  // updateMany condicionado al estado ya comprobado arriba (no un
  // update plano): entre el findUnique del principio de esta función y
  // este punto no hay ninguna otra escritura, pero sí puede haberla de
  // OTRA petición concurrente (p.ej. el cliente cancelando desde otro
  // dispositivo justo aquí) — sin esto, esta escritura resucitaría una
  // solicitud ya cancelada/reembolsada a 'completada' (auditoría Fable
  // 2026-08-15, hallazgo A1).
  const { count: completadaCount } = await prisma.serviceRequest.updateMany({
    where: { id, estado: { in: ['aceptada', 'en_progreso'] } },
    data: { estado: 'completada', precioFinal, completadaAt: new Date() },
  });
  if (completadaCount === 0) {
    return res.status(409).json({ error: 'La solicitud no está en un estado válido para completarse', code: 'REQUEST_INVALID_STATE_COMPLETE' });
  }

  enviarNotificacion(solicitud.clienteId, 'solicitud_completada', {}, { solicitudId: id }).catch((e) =>
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
    // PAGO_NO_AUTORIZADO_TODAVIA (ver releasePayments) no es un fallo
    // puntual de Stripe que "se reintente" solo: el cliente nunca llegó
    // a confirmar el Payment Sheet, o su autorización ya caducó, así que
    // no hay nada que reintentar hasta que vuelva a autorizar en la app
    // (ver avisoPagoSinConfirmar). Distinguirlo evita que el profesional
    // espere indefinidamente un cobro que no se resolverá solo.
    const pagoSinConfirmar = err instanceof Error && err.message === 'PAGO_NO_AUTORIZADO_TODAVIA';
    let aviso = AVISO_LIBERACION_PENDIENTE;
    if (pagoSinConfirmar) {
      const motivo = await diagnosticarPagoSinConfirmar(id).catch(() => 'nunca_autorizado' as const);
      aviso = avisoPagoSinConfirmar('Servicio completado', motivo);
    }
    return res.status(202).json({
      solicitudId: id,
      estado: 'completada',
      aviso,
    });
  }
}

const responderCierreHorasSchema = z.object({
  accion: z.enum(['aceptar', 'rechazar']),
  // Solo relevante para accion: 'aceptar' cuando la reducción es
  // anómala (ver evaluarReduccionHoras) — el cliente tiene que haber
  // visto explícitamente la comparación horasEstimadas/horasReales
  // (pantalla de seguimiento) y confirmarlo aparte. Sin esto, aceptar
  // una reducción anómala responde 409 en vez de liberar el pago — así
  // un cliente (posiblemente en connivencia con el profesional) no
  // puede aceptar sin más una declaración de horas muy por debajo de
  // lo estimado, y una app desactualizada o modificada no puede
  // saltarse el aviso llamando al endpoint directamente.
  confirmarReduccionGrande: z.boolean().optional(),
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
    return res.status(400).json({ error: 'Falta indicar si aceptas o rechazas las horas declaradas', code: 'HOURS_DECISION_REQUIRED' });
  }

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id },
    include: { presupuestos: { where: { estado: 'aceptado' }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No tienes acceso a esta solicitud', code: 'REQUEST_NO_ACCESS' });
  }

  const cierre = await prisma.cierreHoras.findUnique({ where: { id: cierreId } });
  if (!cierre || cierre.serviceRequestId !== id) {
    return res.status(404).json({ error: 'Cierre no encontrado', code: 'HOURS_CLOSURE_NOT_FOUND' });
  }

  if (parsed.data.accion === 'rechazar') {
    const { count } = await prisma.cierreHoras.updateMany({
      where: { id: cierreId, estado: 'pendiente' },
      data: { estado: 'rechazado', resueltaAt: new Date() },
    });
    if (count === 0) {
      return res.status(409).json({ error: 'Este cierre ya no está pendiente de respuesta', code: 'HOURS_CLOSURE_NOT_PENDING' });
    }
    if (solicitud.profesionalId) {
      enviarNotificacion(solicitud.profesionalId, 'cierre_horas_rechazado', {}, { solicitudId: id }).catch((e) =>
        console.error(`[responderCierreHoras] Error al notificar al profesional de ${id}:`, e)
      );
    }
    return res.json({ id: cierreId, estado: 'rechazado' });
  }

  const presupuesto = solicitud.presupuestos[0];
  if (!presupuesto) {
    return res.status(409).json({ error: 'No hay un presupuesto aceptado para esta solicitud', code: 'NO_ACCEPTED_BUDGET' });
  }

  // Gate anti-evasión (auditoría 2026-08-14): antes de tocar ningún
  // estado, si la reducción declarada es anómala frente a
  // horasEstimadas y el cliente no ha mandado la confirmación
  // explícita, se corta aquí. No se marca el cierre como resuelto —
  // sigue "pendiente", así que el cliente puede reintentar con la
  // confirmación en cuanto la vea en pantalla.
  const anomalia = evaluarReduccionHoras(Number(cierre.horasReales), presupuesto.horasEstimadas ? Number(presupuesto.horasEstimadas) : null);
  if (anomalia.anomala && !parsed.data.confirmarReduccionGrande) {
    return res.status(409).json({
      error: 'La reducción declarada es muy grande respecto a las horas estimadas; confírmala explícitamente',
      code: 'HOURS_REDUCTION_CONFIRMATION_REQUIRED',
      horasReales: Number(cierre.horasReales),
      horasEstimadas: presupuesto.horasEstimadas ? Number(presupuesto.horasEstimadas) : null,
      porcentaje: anomalia.porcentaje,
    });
  }

  const precioFinal = Number(presupuesto.tarifaHora) * Number(cierre.horasReales);

  // Las dos escrituras (cierre -> 'aceptado' y solicitud -> 'completada')
  // van en una sola transacción: si la solicitud ya no está en un estado
  // válido (p.ej. el cliente la canceló desde otro dispositivo, o quedó
  // 'disputada' entre medias), la BD revierte también el cambio del
  // cierre, en vez de dejarlo "aceptado" para siempre sin que la
  // solicitud llegue a completarse ni el pago se libere. Antes de esto,
  // responderCierreHoras ni siquiera comprobaba solicitud.estado, así
  // que podía completar y liberar el pago de una solicitud 'disputada',
  // saltándose el bloqueo que sí tiene completeServiceRequest (auditoría
  // Fable 2026-08-15, hallazgo A1).
  const resultado = await prisma.$transaction(async (tx) => {
    const cierreUpdate = await tx.cierreHoras.updateMany({
      where: { id: cierreId, estado: 'pendiente' },
      data: { estado: 'aceptado', resueltaAt: new Date() },
    });
    if (cierreUpdate.count === 0) {
      return { ok: false as const, code: 'HOURS_CLOSURE_NOT_PENDING' as const };
    }
    const solicitudUpdate = await tx.serviceRequest.updateMany({
      where: { id, estado: { in: ['aceptada', 'en_progreso'] } },
      data: { estado: 'completada', precioFinal, completadaAt: new Date() },
    });
    if (solicitudUpdate.count === 0) {
      return { ok: false as const, code: 'REQUEST_INVALID_STATE_COMPLETE' as const };
    }
    return { ok: true as const };
  });

  if (!resultado.ok) {
    const mensaje = resultado.code === 'HOURS_CLOSURE_NOT_PENDING'
      ? 'Este cierre ya no está pendiente de respuesta'
      : 'La solicitud no está en un estado válido para confirmar las horas';
    return res.status(409).json({ error: mensaje, code: resultado.code });
  }

  if (solicitud.profesionalId) {
    enviarNotificacion(solicitud.profesionalId, 'cierre_horas_aceptado', {}, { solicitudId: id }).catch((e) =>
      console.error(`[responderCierreHoras] Error al notificar al profesional de ${id}:`, e)
    );
  }

  try {
    const pagoLiberado = await releasePayments(id, precioFinal);
    return res.json({ id: cierreId, estado: 'aceptado', pago: pagoLiberado });
  } catch (err) {
    console.error(`[responderCierreHoras] Error al liberar el pago de ${id}:`, err);
    const pagoSinConfirmar = err instanceof Error && err.message === 'PAGO_NO_AUTORIZADO_TODAVIA';
    let aviso = AVISO_LIBERACION_PENDIENTE;
    if (pagoSinConfirmar) {
      const motivo = await diagnosticarPagoSinConfirmar(id).catch(() => 'nunca_autorizado' as const);
      aviso = avisoPagoSinConfirmar('Horas confirmadas', motivo);
    }
    return res.status(202).json({
      id: cierreId,
      estado: 'aceptado',
      aviso,
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
        cierreHoras: serializarCierreHoras(s.cierresHoras[0], presupuesto?.horasEstimadas),
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
      presupuestos: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { ampliaciones: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
      cierresHoras: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return res.json({
    solicitudes: solicitudes.map((s) => {
      const presupuesto = s.presupuestos[0];
      const ampliacion = presupuesto?.ampliaciones[0];
      const cierreHoras = s.cierresHoras[0];
      return {
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
        // El listado no manda el presupuesto/ampliación/cierreHoras
        // completos (eso ya vive en el detalle, seguimiento_solicitud_screen)
        // — solo este booleano, para que la tarjeta de la lista pueda
        // destacar visualmente "tienes algo pendiente de confirmar" sin
        // que el cliente tenga que entrar a cada solicitud a comprobarlo.
        requiereAccion:
          presupuesto?.estado === 'pendiente' ||
          ampliacion?.estado === 'pendiente' ||
          cierreHoras?.estado === 'pendiente',
      };
    }),
  });
}
