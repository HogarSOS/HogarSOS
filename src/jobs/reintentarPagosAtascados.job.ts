import { prisma } from '../config/prisma';
import { reintentarLiberacion, ESTADOS_DISPUTA_BLOQUEANTE } from '../services/payment.service';
import { TareaProgramada } from './scheduler';

/**
 * Cierra el último cabo suelto de B2: la liberación de pagos ya era
 * idempotente y reanudable, pero el reintento había que dispararlo a
 * mano desde el panel de admin. Esta tarea lo automatiza.
 *
 * NO reimplementa nada de la lógica de dinero: llama al mismo
 * `reintentarLiberacion` que usa el endpoint manual, que a su vez llama
 * al mismo `releasePayments` del flujo normal. Un único camino de código
 * mueve dinero en todo el proyecto.
 */

/**
 * Margen antes del primer reintento automático. Sin él, esta tarea
 * competiría con la petición HTTP que acaba de fallar y que puede estar
 * todavía reintentando por su cuenta — el lock lo haría inofensivo, pero
 * ensuciaría los contadores de intentos sin aportar nada.
 */
const GRACIA_PRIMER_REINTENTO_MS = 2 * 60 * 1000;

/**
 * Backoff exponencial por número de intentos ya realizados: 5 min, 15,
 * 45, 2 h, 6 h... con tope a 12 h. Un pago que falla de forma
 * persistente (cuenta Connect bloqueada, Stripe caído) no debe generar
 * una llamada cada 10 minutos indefinidamente.
 */
function esperaMinimaMs(intentos: number): number {
  const DOCE_HORAS = 12 * 60 * 60 * 1000;
  return Math.min(5 * 60 * 1000 * Math.pow(3, Math.max(0, intentos - 1)), DOCE_HORAS);
}

/**
 * Errores que NO se arreglan reintentando, por mucho que se espere:
 * hace falta una acción humana o del propio usuario. Reintentarlos solo
 * gastaría llamadas a Stripe y enterraría en ruido los que sí son
 * recuperables.
 */
const ERRORES_NO_REINTENTABLES = new Set([
  // El cliente nunca confirmó el Payment Sheet — tiene que volver a
  // autorizar el pago desde la app, no hay nada que reintentar.
  'PAGO_NO_AUTORIZADO_TODAVIA',
  // El profesional no ha terminado su onboarding de Connect. Se
  // reactivará solo cuando lo haga (sincronizarEstadoCuentaStripe
  // limpia el error al liberar con éxito).
  'PROFESIONAL_SIN_CUENTA_STRIPE',
]);

export async function reintentarPagosAtascados(): Promise<string> {
  const ahora = Date.now();

  const candidatos = await prisma.payment.findMany({
    where: {
      OR: [
        // El dinero ya salió de la tarjeta del cliente y no ha llegado
        // al profesional. Máxima prioridad.
        { estado: 'capturado' },
        // El trabajo se dio por terminado pero la liberación nunca llegó
        // a completarse.
        { estado: 'retenido', serviceRequest: { estado: 'completada' } },
      ],
      createdAt: { lt: new Date(ahora - GRACIA_PRIMER_REINTENTO_MS) },
      // P2 #7: exclusión temprana, solo por eficiencia — evita gastar una
      // llamada a Stripe (y ensuciar `fallos` con algo ya sabido) en un
      // pago que heartbeat() iba a rechazar de todas formas. La
      // protección real sigue siendo heartbeat(), no esta consulta: si
      // la disputa llega justo después de esta lectura, heartbeat() la
      // atrapa igual antes de la siguiente llamada mutante a Stripe.
      AND: [{ OR: [{ stripeDisputeStatus: null }, { stripeDisputeStatus: { notIn: [...ESTADOS_DISPUTA_BLOQUEANTE] } }] }],
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  // Varias autorizaciones (inicial + ampliaciones) pueden pertenecer a
  // la misma solicitud, y releasePayments trabaja por solicitud entera:
  // sin agrupar, se llamaría varias veces a lo mismo y todas menos la
  // primera chocarían con LIBERACION_YA_EN_CURSO.
  const porSolicitud = new Map<string, (typeof candidatos)[number]>();
  for (const pago of candidatos) {
    if (!porSolicitud.has(pago.serviceRequestId)) porSolicitud.set(pago.serviceRequestId, pago);
  }

  let reintentados = 0;
  let recuperados = 0;
  let omitidos = 0;
  const fallos: string[] = [];

  for (const [serviceRequestId, pago] of porSolicitud) {
    if (pago.ultimoErrorLiberacion && ERRORES_NO_REINTENTABLES.has(pago.ultimoErrorLiberacion)) {
      omitidos++;
      continue;
    }

    const ultimoIntento = pago.ultimoIntentoLiberacionAt?.getTime() ?? 0;
    if (ultimoIntento && ahora - ultimoIntento < esperaMinimaMs(pago.intentosLiberacion)) {
      omitidos++;
      continue;
    }

    reintentados++;
    try {
      const liberados = await reintentarLiberacion(serviceRequestId);
      recuperados += liberados.length;
      console.log(`[reintentarPagosAtascados] Recuperada la solicitud ${serviceRequestId} (${liberados.length} pago(s)).`);
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e);
      // LIBERACION_YA_EN_CURSO no es un fallo: alguien (el propio
      // profesional cerrando el trabajo, o un admin) está liberándolo
      // ahora mismo. Se reevaluará en la siguiente pasada.
      if (mensaje !== 'LIBERACION_YA_EN_CURSO' && mensaje !== 'PAGO_NO_ENCONTRADO') {
        fallos.push(`${serviceRequestId}: ${mensaje}`);
      }
    }
  }

  const resumen =
    `${porSolicitud.size} solicitud(es) atascada(s), ${reintentados} reintentada(s), ` +
    `${recuperados} pago(s) liberado(s), ${omitidos} omitida(s) por backoff o error no reintentable`;

  return fallos.length > 0 ? `${resumen}. Fallos: ${fallos.slice(0, 5).join(' | ')}` : resumen;
}

export const tareaReintentarPagosAtascados: TareaProgramada = {
  nombre: 'reintentar-pagos-atascados',
  descripcion:
    'Reintenta automáticamente la liberación de pagos que quedaron a medias entre la captura y la transferencia al profesional.',
  intervaloMs: 10 * 60 * 1000,
  // Holgado: cada solicitud puede implicar varias llamadas a Stripe, y
  // hasta 50 candidatas por pasada.
  duracionMaximaMs: 10 * 60 * 1000,
  ejecutar: reintentarPagosAtascados,
};
