import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { stripe } from '../config/stripe';
import { REQUIRE_PROFESSIONAL_VERIFICATION } from '../config/featureFlags';
import { derivarEstadoCuentaStripe, sincronizarEstadoCuentaStripe, intentarAprobacionAutomatica } from '../services/professional.service';

export async function getProfile(req: Request, res: Response) {
  const userId = req.user!.userId;

  const profesional = await prisma.professional.findUnique({
    where: { userId },
    include: {
      user: { select: { nombre: true, email: true, telefono: true } },
      categorias: { include: { category: true } },
    },
  });

  if (!profesional) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }

  // Refresco en caliente del estado de Stripe mientras no esté
  // 'configurada' — no depende solo de que llegue el webhook
  // account.updated (que hoy no puede verificar su firma porque
  // STRIPE_WEBHOOK_SECRET está vacío en producción). Una vez
  // 'configurada' dejamos de consultar Stripe en cada carga de perfil.
  if (profesional.stripeAccountId && !(profesional.stripeChargesEnabled && profesional.stripePayoutsEnabled)) {
    try {
      const actualizado = await sincronizarEstadoCuentaStripe(userId, profesional.stripeAccountId);
      Object.assign(profesional, actualizado);
    } catch (e) {
      console.error(`[getProfile] Error al sincronizar estado de Stripe para ${userId}:`, e);
    }
  }

  // Reviews recibidas — antes solo se veían desde el perfil PÚBLICO
  // (getPublicProfile más abajo); el propio profesional no tenía
  // ninguna forma de ver sus propias opiniones dentro de la app.
  const reviews = await prisma.review.findMany({
    where: { destinatarioId: userId },
    include: { autor: { select: { nombre: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return res.json({
    nombre: profesional.user.nombre,
    email: profesional.user.email,
    telefono: profesional.user.telefono,
    estadoVerificacion: profesional.estadoVerificacion,
    tipoProfesional: profesional.tipoProfesional,
    tarifaBase: Number(profesional.tarifaBase),
    valoracionMedia: Number(profesional.valoracionMedia),
    totalTrabajos: profesional.totalTrabajos,
    disponible: profesional.disponible,
    modoDisponibilidad: profesional.modoDisponibilidad,
    descripcion: profesional.descripcion,
    fotoPerfilUrl: profesional.fotoPerfilUrl,
    // Sin esto, el propio profesional no tenía forma de saber si ya
    // había enviado su documento de identidad o no — la app solo podía
    // mostrarle "completa tu perfil" para siempre, aunque ya lo hubiera
    // enviado y solo estuviera pendiente de que un admin lo revisara.
    documentoIdentidadUrl: profesional.documentoIdentidadUrl || null,
    categorias: profesional.categorias.map((c) => c.category.nombre),
    estadoCuentaStripe: derivarEstadoCuentaStripe(profesional),
    opiniones: reviews.map((r) => ({
      autor: r.autor.nombre,
      puntuacion: r.puntuacion,
      comentario: r.comentario,
      fecha: r.createdAt,
    })),
  });
}

const availabilitySchema = z.object({
  disponible: z.boolean(),
  // Modo declarado ("disponible en horario laboral" vs "servicio 24h"),
  // independiente de `disponible` (si está aceptando trabajos ahora
  // mismo). Opcional porque el toggle rápido de "en línea/fuera de
  // línea" no siempre cambia el modo a la vez.
  modoDisponibilidad: z.enum(['horario_laboral', 'veinticuatro_horas']).optional(),
  latitud: z.number().min(-90).max(90).optional(),
  longitud: z.number().min(-180).max(180).optional(),
});

/**
 * Actualiza si el profesional está aceptando trabajos y, opcionalmente,
 * su ubicación actual (se llama periódicamente desde la app mientras
 * está "en línea", similar a apps de reparto/transporte).
 */
export async function updateAvailability(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = availabilitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const profesionalExistente = await prisma.professional.findUnique({ where: { userId } });
  if (!profesionalExistente) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }
  let profesional = profesionalExistente;

  // Roadmap económico punto 5: Registro → (Verificación + Stripe en
  // paralelo) → Disponible para trabajar — "disponible" es el punto de
  // llegada de AMBAS ramas, no solo la de verificación. Sin esto, un
  // profesional podía aceptar trabajos que luego jamás se le podrían
  // pagar (mismo hueco que releasePayments ya cerraba del lado del pago
  // — ver PROFESIONAL_CUENTA_STRIPE_NO_OPERATIVA en payment.service.ts).
  // Solo bloquea al INTENTAR activarse — un profesional ya disponible no
  // se desactiva retroactivamente por esto.
  if (REQUIRE_PROFESSIONAL_VERIFICATION && parsed.data.disponible) {
    // Re-sincroniza con Stripe ANTES de evaluar los gates, no después:
    // esto puede disparar la aprobación automática (roadmap punto 8) si
    // completar el perfil era lo único que faltaba, y de paso evita un
    // falso negativo si el profesional acaba de terminar el onboarding
    // y el webhook todavía no ha llegado (ver incidencia conocida en
    // professional.service.ts).
    if (profesional.stripeAccountId && derivarEstadoCuentaStripe(profesional) !== 'configurada') {
      profesional = await sincronizarEstadoCuentaStripe(userId, profesional.stripeAccountId).catch(() => profesional);
    }

    if (profesional.estadoVerificacion !== 'aprobado') {
      return res.status(403).json({ error: 'No puedes ponerte disponible hasta ser verificado', code: 'PROFESSIONAL_NOT_VERIFIED' });
    }
    if (derivarEstadoCuentaStripe(profesional) !== 'configurada') {
      return res.status(403).json({ error: 'No puedes ponerte disponible hasta configurar tu cuenta de cobro', code: 'PROFESSIONAL_STRIPE_NOT_CONFIGURED' });
    }
  }

  const { disponible, modoDisponibilidad, latitud, longitud } = parsed.data;

  if (latitud !== undefined && longitud !== undefined) {
    // ubicacion_actual es tipo geography — se actualiza con SQL nativo.
    // user_id es `text` en la BD (String de Prisma, sin @db.Uuid), así que
    // NO se castea a ::uuid aquí: Postgres no tiene operador "=" entre
    // text y uuid y la query fallaba en tiempo de ejecución (42883).
    await prisma.$executeRaw`
      UPDATE professionals
      SET disponible = ${disponible},
          modo_disponibilidad = COALESCE(${modoDisponibilidad}::"ModoDisponibilidad", modo_disponibilidad),
          ubicacion_actual = ST_SetSRID(ST_MakePoint(${longitud}, ${latitud}), 4326)::geography
      WHERE user_id = ${userId}
    `;
  } else {
    await prisma.professional.update({
      where: { userId },
      data: { disponible, ...(modoDisponibilidad ? { modoDisponibilidad } : {}) },
    });
  }

  return res.json({ disponible, modoDisponibilidad: modoDisponibilidad ?? profesional.modoDisponibilidad });
}

const updateProfileSchema = z.object({
  descripcion: z.string().max(250).optional(),
  tarifaBase: z.number().positive().optional(),
  fotoPerfilUrl: z.string().url().optional(),
});

/**
 * Actualiza los datos editables del perfil del profesional (no la
 * disponibilidad, que ya tiene su propio endpoint arriba, ni la
 * documentación de verificación, que tiene el suyo más abajo).
 */
export async function updateMyProfile(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const profesional = await prisma.professional.findUnique({ where: { userId } });
  if (!profesional) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }

  const actualizado = await prisma.professional.update({
    where: { userId },
    data: parsed.data,
  });

  return res.json({
    descripcion: actualizado.descripcion,
    tarifaBase: Number(actualizado.tarifaBase),
    fotoPerfilUrl: actualizado.fotoPerfilUrl,
  });
}

const verificationSchema = z.object({
  documentoIdentidadUrl: z.string().url().optional(),
  certificadosUrl: z.array(z.string().url()).optional(),
  seguroRcUrl: z.string().url().optional(),
  categoriaIds: z.array(z.number().int()).min(1),
  // Opcional desde la revisión de UX pre-lanzamiento: con el sistema de
  // presupuestos por solicitud (cerrado/por_horas, ver payment.service.ts)
  // el precio real ya no depende de esta tarifa declarada en el perfil —
  // exigirla en la verificación era una fricción heredada de un modelo de
  // precios que ya no existe. Se conserva porque el cliente todavía puede
  // filtrar profesionales por "precio máximo" en la búsqueda (ver
  // searchProfessionals más abajo), así que quien la rellene sigue
  // beneficiándose de aparecer en ese filtro.
  tarifaBase: z.number().positive().optional(),
  // Roadmap económico punto 4: HogarSOS no decide ni verifica esta
  // situación, solo registra lo que el profesional declara — por eso
  // no hay validación adicional más allá de que sea uno de los 3
  // valores aprobados para la versión inicial en España.
  tipoProfesional: z.enum(['autonomo', 'empresa', 'persona_fisica']),
});

/**
 * El profesional envía su documentación para revisión de un admin.
 * Vuelve a poner el estado en "pendiente" incluso si ya había sido
 * rechazado antes, para permitir reenvíos tras corregir documentos.
 */
export async function submitVerificationDocs(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const { documentoIdentidadUrl, certificadosUrl, seguroRcUrl, categoriaIds, tarifaBase, tipoProfesional } =
    parsed.data;

  const categoriasValidas = await prisma.serviceCategory.findMany({
    where: { id: { in: categoriaIds }, activo: true },
  });
  if (categoriasValidas.length !== categoriaIds.length) {
    return res.status(400).json({ error: 'Una o más categorías no son válidas', code: 'CATEGORIES_INVALID' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.professional.update({
      where: { userId },
      data: {
        documentoIdentidadUrl,
        certificadosUrl: certificadosUrl ?? [],
        seguroRcUrl,
        tarifaBase,
        tipoProfesional,
        estadoVerificacion: 'pendiente',
      },
    });

    await tx.professionalCategory.deleteMany({ where: { professionalId: userId } });
    await tx.professionalCategory.createMany({
      data: categoriaIds.map((categoryId) => ({ professionalId: userId, categoryId })),
    });
  });

  // Roadmap económico punto 8 (aprobación semiautomática): completar el
  // perfil es una de las dos ramas en paralelo (la otra es Stripe, ver
  // sincronizarEstadoCuentaStripe) — si la cuenta de Stripe ya estaba
  // configurada de antes, esto es lo único que faltaba para aprobar.
  const profesionalActualizado = await prisma.professional.findUnique({ where: { userId } });
  const estadoFinal = profesionalActualizado
    ? await intentarAprobacionAutomatica(profesionalActualizado)
    : null;

  return res.json({ estadoVerificacion: estadoFinal?.estadoVerificacion ?? 'pendiente', tipoProfesional });
}

const updateCategoriesSchema = z.object({
  categoriaIds: z.array(z.number().int()).min(1),
});

/**
 * Permite al profesional cambiar sus categorías de servicio de forma
 * independiente del flujo de verificación: a diferencia de
 * `submitVerificationDocs`, esto NO toca documentos ni
 * `estadoVerificacion` — es solo un cambio de datos de perfil.
 */
export async function updateMyCategories(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = updateCategoriesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const { categoriaIds } = parsed.data;

  const profesional = await prisma.professional.findUnique({ where: { userId } });
  if (!profesional) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }

  const categoriasValidas = await prisma.serviceCategory.findMany({
    where: { id: { in: categoriaIds }, activo: true },
  });
  if (categoriasValidas.length !== categoriaIds.length) {
    return res.status(400).json({ error: 'Una o más categorías no son válidas', code: 'CATEGORIES_INVALID' });
  }

  await prisma.$transaction(async (tx) => {
    await tx.professionalCategory.deleteMany({ where: { professionalId: userId } });
    await tx.professionalCategory.createMany({
      data: categoriaIds.map((categoryId) => ({ professionalId: userId, categoryId })),
    });
  });

  return res.json({ categorias: categoriasValidas.map((c) => c.nombre) });
}

/**
 * Inicia el onboarding de Stripe Connect (o reabre el mismo flujo para
 * revisar/editar los datos ya enviados) para que el profesional pueda
 * recibir transferencias. Devuelve una URL de Stripe (hosted) a la que
 * la app debe redirigir/abrir en un WebView.
 *
 * BUG 003 (QA, 2026-08-03): "una vez configurada la cuenta de cobro no
 * puede modificarse". La causa real y única era que el frontend
 * ocultaba esta tarjeta por completo en cuanto `estadoCuentaStripe`
 * pasaba a `configurada` — sin ningún botón visible, daba igual qué
 * generase el backend (ver mi_perfil_profesional_screen.dart).
 *
 * CORRECCIÓN (mismo día, verificado contra Stripe real): el primer
 * intento de arreglo cambió el `type` del accountLink a
 * `account_update` cuando la cuenta ya está `configurada`, asumiendo
 * que `account_onboarding` no dejaría editar nada con la cuenta ya
 * completa. Probado en real: Stripe rechaza `account_update` para
 * cuentas Express con el error "Valid types for this account are
 * [account_onboarding]" — ese tipo de accountLink solo existe para
 * cuentas Custom, no Express (que es lo que crea este backend, ver
 * `stripe.accounts.create` de abajo). Ese intento rompía el botón
 * "Editar cuenta de cobro" con un 500. Verificado también que
 * `account_onboarding` con una cuenta Express ya completa SÍ muestra
 * una pantalla real de "Revisar y confirmar" con "Editar" por sección
 * (tipo de empresa, datos de la empresa, etc.) — no hace falta ningún
 * tipo especial, `account_onboarding` ya sirve para editar.
 */
export async function startStripeOnboarding(req: Request, res: Response) {
  const userId = req.user!.userId;

  const profesional = await prisma.professional.findUnique({
    where: { userId },
    include: { user: true },
  });
  if (!profesional) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }

  let accountId = profesional.stripeAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'ES',
      // Profesionales registrados solo por teléfono no tienen email —
      // Stripe lo pedirá igualmente durante el propio onboarding
      // (accountLink de más abajo) si hace falta.
      email: profesional.user.email ?? undefined,
      capabilities: {
        transfers: { requested: true },
      },
    });
    accountId = account.id;
    await prisma.professional.update({ where: { userId }, data: { stripeAccountId: accountId } });
  }

  // El fallback anterior era 'https://hogarsos.com' — dominio equivocado
  // (.com en vez de .es), así que sin APP_BASE_URL definida el retorno del
  // onboarding de Stripe iba a un sitio que ni siquiera controlamos.
  // Ahora validateEnv.ts exige APP_BASE_URL en producción, y el fallback
  // solo cubre desarrollo local.
  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appBaseUrl}/stripe/onboarding/refresh`,
    return_url: `${appBaseUrl}/stripe/onboarding/completado`,
    type: 'account_onboarding',
  });

  return res.json({ onboardingUrl: accountLink.url });
}

const searchSchema = z.object({
  categoryId: z.coerce.number().int().optional(),
  query: z.string().trim().max(100).optional(),
  latitud: z.coerce.number().min(-90).max(90).optional(),
  longitud: z.coerce.number().min(-180).max(180).optional(),
  minValoracion: z.coerce.number().min(0).max(5).optional(),
  precioMax: z.coerce.number().positive().optional(),
  soloDisponibles: z.coerce.boolean().optional(),
  radioMetros: z.coerce.number().positive().max(100000).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Búsqueda pública de profesionales para el cliente (Fase 2 —
 * marketplace). Nunca devuelve profesionales sin verificar (estado
 * != 'aprobado') — la verificación existe precisamente para controlar
 * quién es visible para clientes, así que esta regla ya existía
 * implícitamente en el negocio, solo la hacíamos cumplir en el flujo
 * de aceptar solicitudes; aquí se aplica también en el descubrimiento.
 *
 * Solo lectura, no crea ni modifica nada — endpoint nuevo, aditivo,
 * no toca ninguna ruta ni tabla existente.
 */
export async function searchProfessionals(req: Request, res: Response) {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros de búsqueda inválidos', code: 'SEARCH_PARAMS_INVALID', detalles: parsed.error.flatten() });
  }

  const { categoryId, query, latitud, longitud, minValoracion, precioMax, soloDisponibles, radioMetros, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  const whereBase: Prisma.ProfessionalWhereInput = {
    ...(REQUIRE_PROFESSIONAL_VERIFICATION ? { estadoVerificacion: 'aprobado' } : {}),
    ...(categoryId ? { categorias: { some: { categoryId } } } : {}),
    ...(minValoracion !== undefined ? { valoracionMedia: { gte: minValoracion } } : {}),
    ...(precioMax !== undefined ? { tarifaBase: { lte: precioMax } } : {}),
    ...(soloDisponibles ? { disponible: true } : {}),
    ...(query ? { user: { nombre: { contains: query, mode: 'insensitive' } } } : {}),
  };

  // Con coordenadas: se calcula distancia real con PostGIS y se ordena
  // por cercanía (SQL nativo, igual que en serviceRequest.controller.ts,
  // porque Prisma no traduce el tipo geography). Sin coordenadas: se
  // ordena por valoración, el criterio razonable por defecto.
  if (latitud !== undefined && longitud !== undefined) {
    const verificacionFiltro = REQUIRE_PROFESSIONAL_VERIFICATION
      ? Prisma.sql`AND p.estado_verificacion = 'aprobado'`
      : Prisma.empty;
    const categoriaFiltro = categoryId ? Prisma.sql`AND pc.category_id = ${categoryId}` : Prisma.empty;
    const valoracionFiltro = minValoracion !== undefined ? Prisma.sql`AND p.valoracion_media >= ${minValoracion}` : Prisma.empty;
    const precioFiltro = precioMax !== undefined ? Prisma.sql`AND p.tarifa_base <= ${precioMax}` : Prisma.empty;
    const queryFiltro = query ? Prisma.sql`AND u.nombre ILIKE ${'%' + query + '%'}` : Prisma.empty;
    const disponibleFiltro = soloDisponibles ? Prisma.sql`AND p.disponible = true` : Prisma.empty;
    const radioFiltro = radioMetros
      ? Prisma.sql`AND ST_DWithin(p.ubicacion_actual, ST_SetSRID(ST_MakePoint(${longitud}, ${latitud}), 4326)::geography, ${radioMetros})`
      : Prisma.empty;

    const resultados = await prisma.$queryRaw<any[]>`
      SELECT DISTINCT ON (p.user_id)
        p.user_id AS "userId", u.nombre, p.tarifa_base::double precision AS "tarifaBase",
        p.valoracion_media::double precision AS "valoracionMedia", p.total_trabajos AS "totalTrabajos",
        p.disponible, p.foto_perfil_url AS "fotoPerfilUrl", p.estado_verificacion AS "estadoVerificacion",
        p.tipo_profesional AS "tipoProfesional",
        ST_Distance(p.ubicacion_actual, ST_SetSRID(ST_MakePoint(${longitud}, ${latitud}), 4326)::geography) AS "distanciaMetros"
      FROM professionals p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN professional_categories pc ON pc.professional_id = p.user_id
      WHERE 1 = 1
        ${verificacionFiltro} ${categoriaFiltro} ${valoracionFiltro} ${precioFiltro} ${queryFiltro} ${disponibleFiltro} ${radioFiltro}
      ORDER BY p.user_id, "distanciaMetros" ASC NULLS LAST
      OFFSET ${offset} LIMIT ${limit}
    `;

    const conCategorias = await _adjuntarCategorias(resultados);
    return res.json({ resultados: conCategorias, page, limit });
  }

  const profesionales = await prisma.professional.findMany({
    where: whereBase,
    include: {
      user: { select: { nombre: true } },
      categorias: { include: { category: true } },
    },
    orderBy: { valoracionMedia: 'desc' },
    skip: offset,
    take: limit,
  });

  const resultados = profesionales.map((p) => ({
    userId: p.userId,
    nombre: p.user.nombre,
    tarifaBase: Number(p.tarifaBase),
    valoracionMedia: Number(p.valoracionMedia),
    totalTrabajos: p.totalTrabajos,
    disponible: p.disponible,
    fotoPerfilUrl: p.fotoPerfilUrl,
    estadoVerificacion: p.estadoVerificacion,
    tipoProfesional: p.tipoProfesional,
    categorias: p.categorias.map((c) => c.category.nombre),
  }));

  return res.json({ resultados, page, limit });
}

/** Adjunta los nombres de categorías a resultados que vinieron de $queryRaw (sin `include` de Prisma). */
async function _adjuntarCategorias(resultados: any[]) {
  const ids = resultados.map((r) => r.userId);
  if (ids.length === 0) return [];

  const relaciones = await prisma.professionalCategory.findMany({
    where: { professionalId: { in: ids } },
    include: { category: true },
  });

  const mapa = new Map<string, string[]>();
  for (const rel of relaciones) {
    const lista = mapa.get(rel.professionalId) ?? [];
    lista.push(rel.category.nombre);
    mapa.set(rel.professionalId, lista);
  }

  return resultados.map((r) => ({ ...r, categorias: mapa.get(r.userId) ?? [] }));
}

/**
 * Perfil público de un profesional (para la pantalla de detalle del
 * cliente — Fase 3), con sus valoraciones. No expone documentos de
 * verificación ni email/teléfono — esos siguen siendo privados.
 */
export async function getPublicProfile(req: Request, res: Response) {
  const { id } = req.params;

  const profesional = await prisma.professional.findUnique({
    where: REQUIRE_PROFESSIONAL_VERIFICATION
      ? { userId: id, estadoVerificacion: 'aprobado' }
      : { userId: id },
    include: {
      user: { select: { nombre: true } },
      categorias: { include: { category: true } },
    },
  });

  if (!profesional) {
    return res.status(404).json({ error: 'Profesional no encontrado', code: 'PROFESSIONAL_NOT_FOUND' });
  }

  const reviews = await prisma.review.findMany({
    where: { destinatarioId: id },
    include: { autor: { select: { nombre: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return res.json({
    userId: profesional.userId,
    nombre: profesional.user.nombre,
    tarifaBase: Number(profesional.tarifaBase),
    valoracionMedia: Number(profesional.valoracionMedia),
    totalTrabajos: profesional.totalTrabajos,
    disponible: profesional.disponible,
    descripcion: profesional.descripcion,
    fotoPerfilUrl: profesional.fotoPerfilUrl,
    estadoVerificacion: profesional.estadoVerificacion,
    tipoProfesional: profesional.tipoProfesional,
    categorias: profesional.categorias.map((c) => c.category.nombre),
    reviews: reviews.map((r) => ({
      autor: r.autor.nombre,
      puntuacion: r.puntuacion,
      comentario: r.comentario,
      fecha: r.createdAt,
    })),
  });
}
