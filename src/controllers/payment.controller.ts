import { Request, Response } from 'express';
import { z } from 'zod';
import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import { createEscrowPaymentIntent } from '../services/payment.service';

const createIntentSchema = z.object({
  serviceRequestId: z.string().uuid(),
});

/**
 * El cliente llama a esto tras seleccionar profesional (o justo antes
 * de que empiece el trabajo). Autoriza el cargo en la tarjeta sin
 * capturarlo todavía — el dinero queda retenido hasta que el servicio
 * se complete. Devuelve el client_secret para que la app Flutter
 * confirme el pago con el SDK de Stripe (Payment Sheet).
 */
export async function createPaymentIntent(req: Request, res: Response) {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta serviceRequestId' });
  }

  const { serviceRequestId } = parsed.data;
  const clienteId = req.user!.userId;

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id: serviceRequestId },
    include: { payment: true },
  });

  if (!solicitud) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  if (solicitud.clienteId !== clienteId) {
    return res.status(403).json({ error: 'No eres el cliente de esta solicitud' });
  }
  if (solicitud.estado !== 'aceptada') {
    return res.status(409).json({ error: 'La solicitud debe estar aceptada por un profesional antes de pagar' });
  }
  if (solicitud.payment) {
    return res.status(409).json({ error: 'Ya existe un pago para esta solicitud' });
  }
  if (!solicitud.precioEstimado) {
    return res.status(409).json({ error: 'La solicitud no tiene un precio estimado definido' });
  }

  const { pago, clientSecret } = await createEscrowPaymentIntent({
    serviceRequestId,
    montoTotal: Number(solicitud.precioEstimado),
  });

  return res.status(201).json({
    paymentId: pago.id,
    clientSecret,
    montoTotal: Number(pago.montoTotal),
    comisionPlataforma: Number(pago.comisionPlataforma),
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
