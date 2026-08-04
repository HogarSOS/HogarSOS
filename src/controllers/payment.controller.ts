import { Request, Response } from 'express';
import { z } from 'zod';
import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import {
  createEscrowPaymentIntent,
  obtenerResumenPagos,
  obtenerOCrearStripeCustomerId,
  crearEphemeralKey,
  COMISION_CLIENTE_PORCENTAJE,
  COMISION_PROFESIONAL_PORCENTAJE,
} from '../services/payment.service';
import { enviarNotificacion } from '../services/notification.service';
import { enviarEmail } from '../services/email.service';
import { sincronizarEstadoCuentaStripe } from '../services/professional.service';

const createIntentSchema = z.object({
  serviceRequestId: z.string().uuid(),
});

/**
 * `payment.service.createEscrowPaymentIntent` crea la fila Payment (con
 * estado 'retenido') en el mismo momento en que se crea el PaymentIntent
 * en Stripe — ANTES de que el cliente confirme nada con el Payment
 * Sheet. Si esa confirmación nunca llega a completarse (el SDK de Stripe
 * falla al inicializarse, el usuario cierra la app, se cae la conexión a
 * mitad...) la fila se queda ahí para siempre y bloquea cualquier
 * reintento — el bug real detrás de "no se pudo procesar el pago,
 * inténtalo de nuevo" seguido de "no hay nada pendiente de autorizar".
 * Antes de tratar un pago existente como bloqueante, se comprueba su
 * estado real en Stripe: si nunca llegó a confirmarse (o se canceló),
 * no es una autorización real — se deja reintentar reutilizando el
 * mismo PaymentIntent en vez de crear uno nuevo.
 */
/**
 * `requires_action` y `requires_confirmation` son CRÍTICOS al pasar a
 * Stripe Live (revisión final pre-lanzamiento). En modo test las tarjetas
 * no disparan 3D Secure salvo que se usen las específicas, así que este
 * caso casi no aparecía; en producción, la mayoría de tarjetas europeas
 * SÍ lo disparan por PSD2/SCA.
 *
 * Escenario real: el cliente pulsa pagar, se abre el 3DS de su banco y
 * cierra la app (o se le acaba el tiempo). El PaymentIntent se queda en
 * `requires_action`. Sin incluirlo aquí, al volver a pulsar "pagar" el
 * endpoint no lo consideraba reintentable, seguía buscando ampliaciones
 * pendientes y acababa devolviendo 409 "No hay nada pendiente de
 * autorizar" — dejando al cliente sin poder pagar y con un mensaje que
 * dice justo lo contrario de lo que pasa.
 *
 * Devolver el mismo `client_secret` permite al Payment Sheet retomar la
 * autenticación donde se quedó, que es el comportamiento que Stripe
 * espera.
 */
const ESTADOS_STRIPE_ABANDONABLES = new Set([
  'requires_payment_method',
  'canceled',
  'requires_action',
  'requires_confirmation',
]);

async function intentoAbandonado(pago: { stripePaymentIntentId: string | null }) {
  if (!pago.stripePaymentIntentId) return null;
  const paymentIntent = await stripe.paymentIntents.retrieve(pago.stripePaymentIntentId);
  return ESTADOS_STRIPE_ABANDONABLES.has(paymentIntent.status) ? paymentIntent.client_secret : null;
}

/**
 * El cliente llama a esto para autorizar un cargo — puede ser la
 * autorización inicial (tras aceptar el presupuesto) o una autorización
 * adicional (tras aceptar una ampliación de horas): el endpoint decide
 * cuál toca según lo que quede pendiente de autorizar, así el frontend
 * llama siempre al mismo sitio (mismo PagoScreen) en los dos casos.
 * Autoriza el cargo en la tarjeta sin capturarlo todavía — el dinero
 * queda retenido hasta que el trabajo se cierra. Devuelve el
 * client_secret para que la app confirme con el Payment Sheet de Stripe.
 */
export async function createPaymentIntent(req: Request, res: Response) {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta serviceRequestId', code: 'PAYMENT_REQUEST_ID_MISSING' });
  }

  const { serviceRequestId } = parsed.data;
  const clienteId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id: serviceRequestId },
    include: {
      pagos: true,
      presupuestos: {
        where: { estado: 'aceptado' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { ampliaciones: { where: { estado: 'aceptado' }, orderBy: { createdAt: 'asc' } } },
      },
    },
  });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada', code: 'REQUEST_NOT_FOUND' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No eres el cliente de esta solicitud', code: 'NOT_REQUEST_CLIENT' });
  }
  if (solicitud.estado !== 'aceptada' && solicitud.estado !== 'en_progreso') {
    return res.status(409).json({ error: 'La solicitud debe estar aceptada por un profesional antes de pagar', code: 'PAYMENT_REQUEST_NOT_ACCEPTED' });
  }
  const presupuesto = solicitud.presupuestos[0];
  if (!presupuesto) {
    return res.status(409).json({ error: 'Todavía no hay un presupuesto aceptado para esta solicitud', code: 'NO_ACCEPTED_BUDGET' });
  }

  const pagoInicial = solicitud.pagos.find((p) => p.presupuestoId === presupuesto.id && !p.ampliacionId);

  // Se resuelve una sola vez por petición — los reintentos de abajo lo
  // reutilizan para generar una Ephemeral Key fresca (siempre de un
  // solo uso, no se puede reutilizar la de un intento de Payment Sheet
  // anterior) sin volver a crear el Customer.
  const stripeCustomerId = await obtenerOCrearStripeCustomerId(clienteId);

  let montoBase: number;
  let ampliacionId: string | undefined;

  if (!pagoInicial) {
    montoBase =
      presupuesto.tipo === 'cerrado'
        ? Number(presupuesto.monto)
        : Number(presupuesto.tarifaHora) * Number(presupuesto.horasEstimadas);
  } else {
    const reintentoInicial = await intentoAbandonado(pagoInicial);
    if (reintentoInicial) {
      return res.status(201).json({
        paymentId: pagoInicial.id,
        clientSecret: reintentoInicial,
        montoBase: Number(pagoInicial.montoBase),
        montoTotal: Number(pagoInicial.montoTotal),
        comisionPlataforma: Number(pagoInicial.comisionPlataforma),
        customerId: stripeCustomerId,
        ephemeralKeySecret: await crearEphemeralKey(stripeCustomerId),
      });
    }

    const ampliacionSinAutorizar = presupuesto.ampliaciones.find(
      (a) => !solicitud.pagos.some((p) => p.ampliacionId === a.id)
    );
    if (!ampliacionSinAutorizar) {
      const ultimoPagoAmpliacion = [...solicitud.pagos].reverse().find((p) => p.ampliacionId);
      const reintentoAmpliacion = ultimoPagoAmpliacion ? await intentoAbandonado(ultimoPagoAmpliacion) : null;
      if (reintentoAmpliacion && ultimoPagoAmpliacion) {
        return res.status(201).json({
          paymentId: ultimoPagoAmpliacion.id,
          clientSecret: reintentoAmpliacion,
          montoBase: Number(ultimoPagoAmpliacion.montoBase),
          montoTotal: Number(ultimoPagoAmpliacion.montoTotal),
          comisionPlataforma: Number(ultimoPagoAmpliacion.comisionPlataforma),
          customerId: stripeCustomerId,
          ephemeralKeySecret: await crearEphemeralKey(stripeCustomerId),
        });
      }
      return res.status(409).json({ error: 'No hay nada pendiente de autorizar para esta solicitud', code: 'PAYMENT_NOTHING_PENDING' });
    }
    ampliacionId = ampliacionSinAutorizar.id;
    montoBase =
      presupuesto.tipo === 'cerrado'
        ? Number(ampliacionSinAutorizar.montoAdicional)
        : Number(ampliacionSinAutorizar.horasAdicionales) * Number(presupuesto.tarifaHora);
  }

  const { pago, clientSecret, customerId, ephemeralKeySecret } = await createEscrowPaymentIntent({
    serviceRequestId,
    presupuestoId: presupuesto.id,
    ampliacionId,
    montoBase,
    clienteStripeCustomerId: stripeCustomerId,
  });

  return res.status(201).json({
    paymentId: pago.id,
    clientSecret,
    montoBase: Number(pago.montoBase),
    montoTotal: Number(pago.montoTotal),
    comisionPlataforma: Number(pago.comisionPlataforma),
    customerId,
    ephemeralKeySecret,
  });
}

/**
 * Porcentajes de comisión vigentes ahora mismo — cualquier usuario
 * logueado puede consultarlos (cliente para ver cuánto pagará de más,
 * profesional para ver cuánto recibirá de menos) antes de aceptar un
 * presupuesto/ampliación. Puramente informativo: los importes reales
 * se calculan y fijan en el backend al crear cada autorización.
 */
export async function getComisiones(_req: Request, res: Response) {
  return res.json({
    comisionClientePorcentaje: COMISION_CLIENTE_PORCENTAJE,
    comisionProfesionalPorcentaje: COMISION_PROFESIONAL_PORCENTAJE,
  });
}

/**
 * Centro de Pagos del profesional (roadmap económico, punto 1 y 6):
 * cuenta de cobro, pendiente, disponible e historial de cobros.
 */
export async function getPaymentsSummary(req: Request, res: Response) {
  const userId = req.user!.userId;

  const resumen = await obtenerResumenPagos(userId).catch((e) => {
    if (e instanceof Error && e.message === 'PROFESSIONAL_NOT_FOUND') return null;
    throw e;
  });

  if (!resumen) {
    return res.status(404).json({ error: 'Perfil de profesional no encontrado', code: 'PROFESSIONAL_PROFILE_NOT_FOUND' });
  }

  return res.json({
    estadoCuentaStripe: resumen.estadoCuentaStripe,
    pendiente: resumen.pendiente,
    disponible: resumen.disponible,
    moneda: resumen.moneda,
    historial: resumen.historial.map((h) => ({
      id: h.id,
      monto: h.monto,
      fecha: h.fecha,
      categoria: h.categoria,
      descripcion: h.descripcion,
      nombreCliente: h.nombreCliente,
    })),
  });
}

/**
 * Webhook de Stripe. No lleva JWT propio — Stripe autentica la petición
 * con una firma (stripe-signature) verificada contra STRIPE_WEBHOOK_SECRET.
 * IMPORTANTE: esta ruta debe montarse con express.raw(), no express.json(),
 * porque Stripe firma el cuerpo crudo de la petición (ver nota en index.ts).
 */
export async function stripeWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature as string,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (err) {
    return res.status(400).send(`Firma de webhook inválida: ${(err as Error).message}`);
  }

  switch (event.type) {
    // Se dispara cuando un PaymentIntent con capture_method: manual
    // pasa a 'requires_capture' — es decir, cuando la autorización en
    // la tarjeta del cliente se confirma de verdad (no antes: crear el
    // PaymentIntent en createPaymentIntent() no garantiza que el
    // cliente llegue a confirmarlo con el Payment Sheet). Este es el
    // único punto fiable para avisar al profesional de que el pago ya
    // está retenido.
    case 'payment_intent.amount_capturable_updated': {
      const intent = event.data.object as { id: string };
      const pago = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: intent.id },
        include: { serviceRequest: { select: { profesionalId: true } } },
      });
      if (pago?.serviceRequest.profesionalId) {
        enviarNotificacion(pago.serviceRequest.profesionalId, 'pago_autorizado', {}, {
          solicitudId: pago.serviceRequestId,
        }).catch((e) => console.error(`[stripeWebhook] Error al notificar pago autorizado de ${pago.id}:`, e));
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as { id: string };
      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: intent.id },
        data: { estado: 'fallido' },
      });
      break;
    }
    case 'payment_intent.canceled': {
      const intent = event.data.object as { id: string };
      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: intent.id },
        data: { estado: 'reembolsado' },
      });
      break;
    }
    // 'payment_intent.succeeded' se dispara tras la captura manual, que
    // ya gestionamos síncronamente en releasePayment() — no se duplica aquí.
    //
    // Se dispara cada vez que cambia el estado de una cuenta Connect
    // (onboarding completado, Stripe pide más documentación, cuenta
    // restringida, etc.) — sin esto, `getProfile` es la única vía de
    // refresco (ver comentario en professional.controller.ts) y solo se
    // actualiza cuando el propio profesional abre su perfil.
    /**
     * Contracargo: el cliente ha reclamado a SU BANCO, no a nosotros.
     *
     * Riesgo real al pasar a Live (en test esto no ocurre nunca): Stripe
     * retira del saldo de la plataforma el importe reclamado MÁS ~15 € de
     * comisión de disputa, de forma inmediata y sin preguntar. Como el
     * profesional ya cobró su parte vía transfer, ese dinero sale
     * íntegramente del bolsillo de HogarSOS — y con una comisión del 5%,
     * un solo contracargo se come el margen de muchos trabajos.
     *
     * Aquí NO se automatiza ninguna respuesta a propósito: responder a
     * una disputa requiere aportar pruebas concretas (chat, fotos,
     * confirmación del cliente) y decidir si merece la pena pelearla.
     * Eso es un juicio humano con plazo legal, no algo que deba hacer un
     * webhook. Lo que sí es imperdonable es ENTERARSE TARDE: Stripe da
     * un plazo limitado para responder y, si se pasa, la disputa se
     * pierde automáticamente.
     */
    case 'charge.dispute.created': {
      const disputa = event.data.object as {
        id: string;
        amount: number;
        currency: string;
        reason?: string;
        payment_intent?: string;
        evidence_details?: { due_by?: number };
      };

      const importe = (disputa.amount / 100).toFixed(2);
      const limite = disputa.evidence_details?.due_by
        ? new Date(disputa.evidence_details.due_by * 1000).toISOString()
        : 'sin fecha indicada';

      // Log a nivel error para que destaque entre el ruido de Render.
      console.error(
        `[stripeWebhook] ⚠️ CONTRACARGO ${disputa.id}: ${importe} ${disputa.currency.toUpperCase()} ` +
        `(motivo: ${disputa.reason ?? 'no indicado'}, PaymentIntent: ${disputa.payment_intent ?? 'desconocido'}). ` +
        `Plazo para aportar pruebas: ${limite}. Responder desde el dashboard de Stripe.`
      );

      // El pago afectado se marca para que no pase desapercibido en el
      // Centro de Pagos ni en la cola de admin.
      if (disputa.payment_intent) {
        await prisma.payment
          .updateMany({
            where: { stripePaymentIntentId: disputa.payment_intent },
            data: { ultimoErrorLiberacion: `CONTRACARGO ${disputa.id} (${importe} EUR)` },
          })
          .catch((e) => console.error(`[stripeWebhook] No se pudo marcar el pago del contracargo ${disputa.id}:`, e));
      }

      // Aviso por correo a soporte. "Fire and forget" con captura: un
      // fallo de SMTP no debe hacer que devolvamos 500 y que Stripe
      // reintente el webhook en bucle.
      const destinatario = process.env.SMTP_USER;
      if (destinatario) {
        enviarEmail(
          destinatario,
          `⚠️ Contracargo de ${importe} € en Hogar SOS`,
          `<p>Se ha abierto un contracargo en Stripe.</p>
           <ul>
             <li><strong>Importe:</strong> ${importe} ${disputa.currency.toUpperCase()}</li>
             <li><strong>Motivo:</strong> ${disputa.reason ?? 'no indicado'}</li>
             <li><strong>PaymentIntent:</strong> ${disputa.payment_intent ?? 'desconocido'}</li>
             <li><strong>Plazo para aportar pruebas:</strong> ${limite}</li>
           </ul>
           <p>Stripe ya ha retirado el importe más la comisión de disputa del saldo de la plataforma.
              Si no se responde antes del plazo, la disputa se pierde automáticamente.</p>
           <p>Responder desde el dashboard de Stripe → Payments → Disputes.</p>`
        ).catch((e) => console.error(`[stripeWebhook] No se pudo avisar por correo del contracargo ${disputa.id}:`, e));
      } else {
        console.error('[stripeWebhook] SMTP_USER sin definir: el aviso de contracargo solo queda en el log.');
      }
      break;
    }

    case 'account.updated': {
      const account = event.data.object as { id: string };
      const profesional = await prisma.professional.findFirst({
        where: { stripeAccountId: account.id },
      });
      if (profesional) {
        await sincronizarEstadoCuentaStripe(profesional.userId, account.id).catch((e) =>
          console.error(`[stripeWebhook] Error al sincronizar cuenta Stripe de ${profesional.userId}:`, e)
        );
      }
      break;
    }
    default:
      break;
  }

  return res.json({ received: true });
}
