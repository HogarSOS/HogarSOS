import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import {
  refundPayment,
  releasePayments,
  listarPagosAtascados,
  reintentarLiberacion,
} from '../services/payment.service';
import { agregarPagos } from './serviceRequest.controller';
import { TAREAS, ejecutarTareaAhora } from '../jobs';
import { registrarAccionAdmin, listarAccionesAdmin } from '../services/adminAction.service';

/**
 * Estado de las tareas programadas (ver src/jobs/). Sin esto, saber si
 * el reintento automático de pagos está corriendo de verdad exigiría
 * bucear en los logs de Render.
 *
 * `fallosConsecutivos` alto es la señal de alarma: significa que algo
 * lleva roto varias pasadas, no que haya fallado una vez.
 */
export async function listJobs(_req: Request, res: Response) {
  const estados = await prisma.tareaProgramada.findMany();
  const porNombre = new Map(estados.map((e) => [e.nombre, e]));

  return res.json({
    tareas: TAREAS.map((tarea) => {
      const estado = porNombre.get(tarea.nombre);
      const ultima = estado?.ultimaEjecucionAt ?? null;
      return {
        nombre: tarea.nombre,
        descripcion: tarea.descripcion,
        intervaloMinutos: Math.round(tarea.intervaloMs / 60000),
        ultimaEjecucionAt: ultima,
        proximaEjecucionAprox: ultima ? new Date(ultima.getTime() + tarea.intervaloMs) : null,
        enCurso: Boolean(estado?.bloqueadoHasta && estado.bloqueadoHasta > new Date()),
        ejecuciones: estado?.ejecuciones ?? 0,
        fallosConsecutivos: estado?.fallosConsecutivos ?? 0,
        ultimoResultado: estado?.ultimoResultado ?? null,
        ultimoError: estado?.ultimoError ?? null,
      };
    }),
  });
}

/**
 * Fuerza una tarea sin esperar a su siguiente ciclo. Respeta el lock: si
 * ya está corriendo, devuelve 409 en vez de duplicarla.
 */
export async function runJob(req: Request, res: Response) {
  const { nombre } = req.params;
  const adminId = req.user!.userId;

  const tarea = TAREAS.find((t) => t.nombre === nombre);
  if (!tarea) {
    return res.status(404).json({
      error: 'Tarea no encontrada',
      code: 'JOB_NOT_FOUND',
      disponibles: TAREAS.map((t) => t.nombre),
    });
  }

  try {
    const resultado = await ejecutarTareaAhora(tarea);
    await registrarAccionAdmin({
      adminId,
      accion: 'ejecutar_tarea_manual',
      entidadTipo: 'job',
      entidadId: nombre,
      detalle: resultado,
    });
    return res.json({ nombre, resultado });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (mensaje === 'TAREA_YA_EN_CURSO') {
      return res.status(409).json({ error: 'Esta tarea ya se está ejecutando ahora mismo', code: 'JOB_ALREADY_RUNNING' });
    }
    console.error(`[runJob] La tarea "${nombre}" falló:`, err);
    return res.status(500).json({ error: 'La tarea falló', code: 'JOB_FAILED', detalle: mensaje });
  }
}

/**
 * Cola de pagos que necesitan atención humana (auditoría B2). Antes no
 * existía: el código prometía en un comentario que "un admin puede
 * revisar pagos en estado retenido con solicitud completada como cola de
 * reintento", pero no había ningún endpoint que lo permitiera — un pago
 * atascado solo se podía encontrar leyendo los logs de Render o el
 * dashboard de Stripe a mano.
 */
export async function listStuckPayments(_req: Request, res: Response) {
  const atascados = await listarPagosAtascados();

  return res.json({
    total: atascados.length,
    // Dinero ya cobrado al cliente que todavía no ha llegado a ningún
    // profesional: es la cifra que de verdad hay que vigilar.
    importeRetenidoEnPlataforma: Number(
      atascados
        .filter((p) => p.dineroRetenidoEnPlataforma)
        .reduce((acc, p) => acc + p.montoProfesional, 0)
        .toFixed(2)
    ),
    pagos: atascados,
  });
}

/**
 * Reintenta la liberación de una solicitud atascada. Seguro de pulsar
 * varias veces: `releasePayments` es idempotente y reanudable, así que
 * un doble clic no mueve dinero dos veces (el segundo recibe 409).
 */
export async function retryPaymentRelease(req: Request, res: Response) {
  const { serviceRequestId } = req.params;
  const adminId = req.user!.userId;

  try {
    const pagos = await reintentarLiberacion(serviceRequestId);
    await registrarAccionAdmin({
      adminId,
      accion: 'reintentar_liberacion_pago',
      entidadTipo: 'service_request',
      entidadId: serviceRequestId,
      detalle: `${pagos.length} pago(s) liberado(s)`,
    });
    return res.json({ serviceRequestId, liberados: pagos.length, pagos });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);

    // Cada causa necesita una acción distinta del admin, así que no se
    // colapsan todas en un 500 genérico.
    const respuestas: Record<string, { status: number; error: string }> = {
      SOLICITUD_NO_ENCONTRADA: { status: 404, error: 'Solicitud no encontrada' },
      PAGO_NO_ENCONTRADO: { status: 409, error: 'No queda ninguna autorización pendiente de liberar en esta solicitud' },
      LIBERACION_YA_EN_CURSO: { status: 409, error: 'Ya hay una liberación en curso para esta solicitud. Espera unos segundos y vuelve a intentarlo.' },
      PAGO_NO_AUTORIZADO_TODAVIA: { status: 409, error: 'El cliente nunca llegó a confirmar el pago. Esto no se arregla reintentando: tiene que volver a autorizarlo en la app.' },
      PROFESIONAL_SIN_CUENTA_STRIPE: { status: 409, error: 'El profesional no ha completado el onboarding de Stripe Connect' },
      PROFESIONAL_CUENTA_STRIPE_NO_OPERATIVA: { status: 409, error: 'Stripe todavía no habilita los pagos de este profesional (verificación pendiente)' },
    };

    const conocida = respuestas[mensaje];
    if (conocida) {
      return res.status(conocida.status).json({ error: conocida.error, code: mensaje });
    }

    console.error(`[retryPaymentRelease] Fallo al reintentar la liberación de ${serviceRequestId}:`, err);
    return res.status(502).json({
      error: 'El reintento falló en Stripe. El pago sigue recuperable: vuelve a intentarlo.',
      code: 'PAYMENT_RETRY_STRIPE_FAILED',
      detalle: mensaje,
    });
  }
}

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
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }
  if (!parsed.data.aprobar && !parsed.data.motivoRechazo) {
    return res.status(400).json({ error: 'Un rechazo requiere motivoRechazo', code: 'VERIFICATION_REJECT_REASON_REQUIRED' });
  }

  const profesional = await prisma.professional.findUnique({ where: { userId: professionalId } });
  if (!profesional) {
    return res.status(404).json({ error: 'Profesional no encontrado', code: 'PROFESSIONAL_NOT_FOUND' });
  }
  if (profesional.estadoVerificacion !== 'pendiente') {
    return res.status(409).json({ error: 'Este profesional no tiene una verificación pendiente', code: 'VERIFICATION_NOT_PENDING' });
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

  await registrarAccionAdmin({
    adminId,
    accion: parsed.data.aprobar ? 'aprobar_profesional' : 'rechazar_profesional',
    entidadTipo: 'professional',
    entidadId: professionalId,
    estadoAnterior: 'pendiente',
    estadoNuevo: actualizado.estadoVerificacion,
    detalle: parsed.data.motivoRechazo ?? null,
  });

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
        include: { categoria: true, pagos: true, cliente: { select: { nombre: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Decimal (montoTotal/comisionPlataforma/montoProfesional) se serializa
  // como string si no se convierte explícitamente — mismo patrón que en
  // el resto del backend. Hoy el frontend no lee estos campos (ver
  // admin_models.dart), pero se corrige igualmente para no dejarlo como
  // una bomba de relojería para cuando se amplíe el panel. `payment`
  // ahora es un resumen agregado (puede haber más de una autorización
  // por solicitud — inicial + ampliaciones), mismo helper que usa
  // getServiceRequestById.
  return res.json(
    disputas.map((d) => ({
      ...d,
      serviceRequest: {
        ...d.serviceRequest,
        payment: agregarPagos(d.serviceRequest.pagos),
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
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const disputa = await prisma.dispute.findUnique({ where: { id } });
  if (!disputa) {
    return res.status(404).json({ error: 'Disputa no encontrada', code: 'DISPUTE_NOT_FOUND' });
  }
  if (disputa.estado === 'resuelta_cliente' || disputa.estado === 'resuelta_profesional') {
    return res.status(409).json({ error: 'Esta disputa ya fue resuelta', code: 'DISPUTE_ALREADY_RESOLVED' });
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
      // A favor del profesional: se libera TODO lo retenido (inicial +
      // cualquier ampliación), no un importe parcial — el admin está
      // fallando a favor del importe completo ya autorizado.
      // 'capturado' incluido: una liberación anterior pudo capturar sin
      // llegar a transferir. Su base ya está congelada en capturadoBase,
      // así que se usa esa y no la autorizada.
      const pendientes = await prisma.payment.findMany({
        where: {
          serviceRequestId: disputa.serviceRequestId,
          estado: { in: ['retenido', 'capturado'] },
        },
      });
      const importeFinal = pendientes.reduce(
        (acc, p) => acc + Number(p.capturadoBase ?? p.montoBase),
        0
      );
      await releasePayments(disputa.serviceRequestId, importeFinal);
      await prisma.serviceRequest.update({
        where: { id: disputa.serviceRequestId },
        data: { estado: 'completada' },
      });
    }
  } catch (err) {
    const mensaje = (err as Error).message;

    // La disputa NO se marca resuelta si el dinero no se pudo mover, a
    // propósito: el estado de la disputa debe reflejar la realidad. Pero
    // antes eso la dejaba inmortal — el reintento encontraba las filas ya
    // fuera de 'retenido' y lanzaba PAGO_NO_ENCONTRADO para siempre.
    // Ahora releasePayments/refundPayment son reanudables, así que
    // repetir esta misma llamada continúa desde donde se quedó.
    console.error(`[resolveDispute] Fallo al aplicar la resolución de la disputa ${id}:`, err);
    return res.status(502).json({
      error: 'La resolución no pudo aplicarse en Stripe. Vuelve a intentarlo: la operación se reanuda desde donde se quedó, no se duplica.',
      code: 'DISPUTE_RESOLUTION_STRIPE_FAILED',
      detalle: mensaje,
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

  await registrarAccionAdmin({
    adminId,
    accion: 'resolver_disputa',
    entidadTipo: 'dispute',
    entidadId: id,
    estadoAnterior: disputa.estado,
    estadoNuevo: actualizada.estado,
    detalle: notas,
  });

  return res.json(actualizada);
}

function serializarUsuarioAdmin(usuario: {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  role: string;
  activo: boolean;
  firebaseUid: string | null;
}) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    telefono: usuario.telefono,
    role: usuario.role,
    activo: usuario.activo,
    // Una cuenta que se borró a sí misma (RGPD, ver deleteMe en
    // user.controller.ts) también queda con activo:false, pero no es lo
    // mismo que un bloqueo de admin: sus datos personales ya se
    // anonimizaron y firebaseUid queda null (nunca más podrá iniciar
    // sesión con esas credenciales, existan o no). El panel lo necesita
    // para no ofrecer "Activar" sobre una cuenta que el propio usuario
    // decidió eliminar.
    cuentaEliminada: usuario.firebaseUid === null,
  };
}

/**
 * Localiza un usuario por ID para el panel de admin, antes de decidir
 * si bloquearlo/activarlo. Deliberadamente NO es un listado — todavía
 * no existe una pantalla de usuarios (fase 2 del roadmap del panel);
 * esto es solo la búsqueda puntual mínima que hace falta para no
 * operar a ciegas sobre un ID.
 */
export async function getUserForAdmin(req: Request, res: Response) {
  const { id } = req.params;

  const usuario = await prisma.user.findUnique({ where: { id } });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
  }

  return res.json(serializarUsuarioAdmin(usuario));
}

/**
 * Bloquea o activa un usuario (invierte `User.activo`). El login
 * (auth.controller.ts) y el refresh de token ya respetan este campo —
 * no se toca nada de esa lógica aquí, solo quién puede cambiarlo.
 *
 * Tres reglas de seguridad, en este orden:
 * 1. Un admin no puede cambiar el estado de su propia cuenta —
 *    evita que se bloquee a sí mismo (o cualquier ambigüedad sobre
 *    reactivarse) desde este endpoint.
 * 2. No se puede desactivar al último administrador ACTIVO — sin esto,
 *    la plataforma podría quedarse sin ningún admin capaz de revertirlo.
 *    Se cuenta en cada llamada (no se cachea), a propósito: con más de
 *    un admin en el futuro, la respuesta correcta depende de cuántos
 *    sigan activos en ESE momento, no de un número fijo.
 * 3. No se puede "activar" una cuenta que el propio usuario borró
 *    (RGPD) — ver el comentario de `cuentaEliminada` arriba.
 */
export async function toggleUserActive(req: Request, res: Response) {
  const { id } = req.params;
  const adminId = req.user!.userId;

  const usuario = await prisma.user.findUnique({ where: { id } });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
  }

  if (usuario.id === adminId) {
    return res.status(409).json({
      error: 'No puedes cambiar el estado de tu propia cuenta',
      code: 'ADMIN_CANNOT_TOGGLE_SELF',
    });
  }

  if (usuario.activo && usuario.role === 'admin') {
    const adminsActivos = await prisma.user.count({ where: { role: 'admin', activo: true } });
    if (adminsActivos <= 1) {
      return res.status(409).json({
        error: 'No puedes desactivar al único administrador activo',
        code: 'ADMIN_CANNOT_BLOCK_LAST_ADMIN',
      });
    }
  }

  if (!usuario.activo && usuario.firebaseUid === null) {
    return res.status(409).json({
      error: 'Esta cuenta fue eliminada por el propio usuario y no se puede reactivar',
      code: 'ADMIN_CANNOT_REACTIVATE_DELETED_ACCOUNT',
    });
  }

  const actualizado = await prisma.user.update({
    where: { id },
    data: { activo: !usuario.activo },
  });

  await registrarAccionAdmin({
    adminId,
    accion: actualizado.activo ? 'activar_usuario' : 'bloquear_usuario',
    entidadTipo: 'user',
    entidadId: id,
    estadoAnterior: String(usuario.activo),
    estadoNuevo: String(actualizado.activo),
  });

  return res.json(serializarUsuarioAdmin(actualizado));
}

/**
 * Historial de auditoría del panel admin (Bloque 4). Sin filtros, el
 * global más reciente; con `entidadTipo`+`entidadId`, el historial de
 * una entidad concreta (ej. todas las acciones sobre un usuario).
 */
export async function listAdminActions(req: Request, res: Response) {
  const { entidadTipo, entidadId, adminId } = req.query;

  const acciones = await listarAccionesAdmin({
    entidadTipo: typeof entidadTipo === 'string' ? entidadTipo : undefined,
    entidadId: typeof entidadId === 'string' ? entidadId : undefined,
    adminId: typeof adminId === 'string' ? adminId : undefined,
  });

  return res.json({ acciones });
}
