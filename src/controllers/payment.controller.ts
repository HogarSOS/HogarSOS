import { Request, Response } from 'express';
import { z } from 'zod';
import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import {
  createEscrowPaymentIntent,
  COMISION_CLIENTE_PORCENTAJE,
  COMISION_PROFESIONAL_PORCENTAJE,
} from '../services/payment.service';
import { enviarNotificacion } from '../services/notification.service';

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
const ESTADOS_STRIPE_ABANDONABLES = new Set(['requires_payment_method', 'canceled']);

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

  const { pago, clientSecret } = await createEscrowPaymentIntent({
    serviceRequestId,
    presupuestoId: presupuesto.id,
    ampliacionId,
    montoBase,
  });

  return res.status(201).json({
    paymentId: pago.id,
    clientSecret,
    montoBase: Number(pago.montoBase),
    montoTotal: Number(pago.montoTotal),
    comisionPlataforma: Number(pago.comisionPlataforma),
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
    default:
      break;
  }

  return res.json({ received: true });
}
