import { prisma } from '../config/prisma';
import { stripe } from '../config/stripe';
import { enviarNotificacion } from '../services/notification.service';
import { TareaProgramada } from './scheduler';

/**
 * B5: las autorizaciones de Stripe caducan.
 *
 * EL PROBLEMA
 * -----------
 * Un PaymentIntent con `capture_method: 'manual'` mantiene el cargo
 * autorizado en la tarjeta un máximo de ~7 días (menos con algunas
 * tarjetas europeas). Pasado ese plazo Stripe lo cancela solo.
 *
 * En servicios del hogar, "te lo hago la semana que viene" es el caso
 * normal, no la excepción. El resultado era: el profesional hace el
 * trabajo, cierra el servicio, y `releasePayments` falla porque la
 * autorización ya no existe. Trabajo hecho, cero cobrado, y NADIE
 * avisado — el webhook `payment_intent.canceled` marcaba la fila como
 * 'reembolsado' en silencio.
 *
 * LO QUE HACE ESTA TAREA
 * ----------------------
 * 1. AVISA al día 5 a cliente y profesional: quedan ~2 días. Es el
 *    único momento en que todavía se puede hacer algo (cerrar el
 *    trabajo, o volver a autorizar).
 * 2. DETECTA las ya caducadas releyendo el PaymentIntent en Stripe, las
 *    marca 'reembolsado' y AVISA a ambas partes de que hay que volver a
 *    autorizar el pago. Esto es lo que convierte un fallo silencioso en
 *    algo accionable.
 * 3. Sirve de RED DE SEGURIDAD si el webhook de Stripe nunca llegó
 *    (secreto mal configurado, caída puntual): el estado real se
 *    reconcilia igual en la siguiente pasada.
 *
 * LO QUE ESTA TAREA *NO* HACE
 * ---------------------------
 * No elimina el problema de raíz, solo evita que cueste dinero en
 * silencio. La solución de fondo exige una decisión de producto:
 * limitar `fechaDeseada` a ≤5 días desde la autorización, o migrar de
 * "autorizar ahora / capturar al cerrar" a "guardar la tarjeta con
 * SetupIntent / cobrar off-session al cerrar", que no tiene ventana de
 * caducidad. Ver el informe de auditoría.
 */

const UN_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Stripe garantiza ~7 días. Se avisa al 5º para dejar margen real de
 * reacción y porque algunas tarjetas caducan antes de los 7.
 */
const DIAS_PARA_AVISAR = 5;

/** A partir de aquí se comprueba activamente contra Stripe si ya caducó. */
const DIAS_PARA_VERIFICAR_CADUCIDAD = 6;

/** Estados en los que un PaymentIntent ya no puede capturarse: la autorización se perdió. */
const ESTADOS_STRIPE_CADUCADOS = new Set(['canceled', 'requires_payment_method']);

/** Ambas partes necesitan enterarse: el cliente porque tiene que reautorizar, el profesional porque su cobro depende de ello. */
async function notificarAmbasPartes(
  solicitud: { id: string; clienteId: string; profesionalId: string | null },
  tipo: 'autorizacion_por_caducar' | 'autorizacion_caducada'
): Promise<void> {
  const destinatarios = [solicitud.clienteId, solicitud.profesionalId].filter(
    (id): id is string => Boolean(id)
  );

  await Promise.all(
    destinatarios.map((userId) =>
      enviarNotificacion(userId, tipo, {}, { solicitudId: solicitud.id }).catch((e) =>
        console.error(`[autorizacionesPorCaducar] Error al notificar a ${userId} sobre ${solicitud.id}:`, e)
      )
    )
  );
}

export async function revisarAutorizacionesPorCaducar(): Promise<string> {
  const ahora = Date.now();

  const pendientes = await prisma.payment.findMany({
    where: {
      // Solo 'retenido': una autorización ya capturada no caduca, el
      // dinero salió de la tarjeta y el problema pasa a ser el de B2.
      estado: 'retenido',
      createdAt: { lt: new Date(ahora - DIAS_PARA_AVISAR * UN_DIA_MS) },
      serviceRequest: { estado: { in: ['aceptada', 'en_progreso'] } },
    },
    include: {
      serviceRequest: { select: { id: true, clienteId: true, profesionalId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  let avisados = 0;
  let caducados = 0;
  let sinCambios = 0;

  for (const pago of pendientes) {
    const diasDeVida = (ahora - pago.createdAt.getTime()) / UN_DIA_MS;

    // --- Comprobación activa de caducidad (a partir del día 6) ---
    if (diasDeVida >= DIAS_PARA_VERIFICAR_CADUCIDAD && pago.stripePaymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(pago.stripePaymentIntentId);

      if (ESTADOS_STRIPE_CADUCADOS.has(intent.status)) {
        // Condicionado a que la fila SIGA en 'retenido': el webhook
        // payment_intent.canceled ahora también marca y notifica la
        // caducidad (era silencioso), y puede ganar esta carrera entre
        // la lectura del findMany de arriba y este punto. count 0 =
        // el webhook ya lo hizo — notificar aquí también duplicaría
        // el aviso a ambas partes.
        const { count } = await prisma.payment.updateMany({
          where: { id: pago.id, estado: 'retenido' },
          data: { estado: 'reembolsado' },
        });
        if (count === 0) {
          sinCambios++;
          continue;
        }
        await notificarAmbasPartes(pago.serviceRequest, 'autorizacion_caducada');
        caducados++;
        console.warn(
          `[autorizacionesPorCaducar] Autorización caducada en la solicitud ${pago.serviceRequestId} ` +
          `(pago ${pago.id}, estado en Stripe: ${intent.status}). Hace falta reautorizar.`
        );
        continue;
      }
    }

    // --- Aviso preventivo (una sola vez por autorización) ---
    if (!pago.avisoCaducidadEnviadoAt) {
      await notificarAmbasPartes(pago.serviceRequest, 'autorizacion_por_caducar');
      await prisma.payment.update({
        where: { id: pago.id },
        data: { avisoCaducidadEnviadoAt: new Date() },
      });
      avisados++;
      continue;
    }

    sinCambios++;
  }

  return `${pendientes.length} autorización(es) con más de ${DIAS_PARA_AVISAR} días: ${avisados} avisada(s), ${caducados} caducada(s), ${sinCambios} ya avisada(s) previamente`;
}

export const tareaAutorizacionesPorCaducar: TareaProgramada = {
  nombre: 'autorizaciones-por-caducar',
  descripcion:
    'Avisa a cliente y profesional cuando una autorización de pago está a punto de caducar (~7 días de Stripe), y detecta las ya caducadas para que no fallen en silencio.',
  intervaloMs: 6 * 60 * 60 * 1000,
  duracionMaximaMs: 10 * 60 * 1000,
  ejecutar: revisarAutorizacionesPorCaducar,
};
