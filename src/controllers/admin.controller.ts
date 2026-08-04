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

  try {
    const pagos = await reintentarLiberacion(serviceRequestId);
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

  return res.json(actualizada);
}
