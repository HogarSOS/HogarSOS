import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';

const COMISION_PLATAFORMA_PORCENTAJE = Number(process.env.PLATFORM_COMMISSION_PERCENT ?? 18);

/**
 * Modelo de pago tipo escrow, usando Stripe Connect:
 *
 * 1. AUTORIZAR (createEscrowPaymentIntent): se crea un PaymentIntent con
 *    capture_method: 'manual'. Esto AUTORIZA el cargo en la tarjeta del
 *    cliente pero NO mueve el dinero todavía — queda "retenido".
 *
 * 2. CAPTURAR + TRANSFERIR (releasePayment): cuando el profesional marca
 *    el servicio como completado, se captura el cargo (el dinero se
 *    mueve de verdad) y se transfiere la parte del profesional a su
 *    cuenta Stripe Connect. La plataforma se queda con la comisión.
 *
 * Nota: Stripe autoriza los cargos por un máximo de ~7 días según el
 * método de pago. Si un servicio tarda más en completarse, haría falta
 * lógica adicional de re-autorización — no cubierto en este MVP.
 */

export function calcularComision(montoTotal: number) {
  const comision = Number((montoTotal * (COMISION_PLATAFORMA_PORCENTAJE / 100)).toFixed(2));
  const montoProfesional = Number((montoTotal - comision).toFixed(2));
  return { comision, montoProfesional };
}

export async function createEscrowPaymentIntent(params: {
  serviceRequestId: string;
  montoTotal: number;
  clienteStripeCustomerId?: string;
}) {
  const { serviceRequestId, montoTotal, clienteStripeCustomerId } = params;
  const { comision, montoProfesional } = calcularComision(montoTotal);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(montoTotal * 100), // Stripe trabaja en céntimos
    currency: 'eur',
    capture_method: 'manual', // clave del modelo escrow: autoriza sin capturar
    customer: clienteStripeCustomerId,
    metadata: { serviceRequestId },
  });

  const pago = await prisma.payment.create({
    data: {
      serviceRequestId,
      montoTotal,
      comisionPlataforma: comision,
      montoProfesional,
      estado: 'retenido',
      stripePaymentIntentId: paymentIntent.id,
    },
  });

  return { pago, clientSecret: paymentIntent.client_secret };
}

/**
 * Captura el cargo retenido y transfiere la parte del profesional.
 * Se llama al completar el servicio.
 */
export async function releasePayment(serviceRequestId: string) {
  const pago = await prisma.payment.findUnique({ where: { serviceRequestId } });
  if (!pago) throw new Error('PAGO_NO_ENCONTRADO');
  if (pago.estado !== 'retenido') throw new Error('PAGO_NO_RETENIDO');
  if (!pago.stripePaymentIntentId) throw new Error('SIN_PAYMENT_INTENT');

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id: serviceRequestId },
    include: { profesional: true },
  });
  if (!solicitud?.profesional?.stripeAccountId) {
    throw new Error('PROFESIONAL_SIN_CUENTA_STRIPE');
  }

  // 1. Capturar el cargo (el dinero pasa de "autorizado" a "cobrado de verdad")
  await stripe.paymentIntents.capture(pago.stripePaymentIntentId);

  // 2. Transferir la parte del profesional a su cuenta Stripe Connect.
  //    La comisión se queda automáticamente en la cuenta de la plataforma.
  const transfer = await stripe.transfers.create({
    amount: Math.round(Number(pago.montoProfesional) * 100),
    currency: 'eur',
    destination: solicitud.profesional.stripeAccountId,
    source_transaction: pago.stripePaymentIntentId,
  });

  return prisma.payment.update({
    where: { serviceRequestId },
    data: { estado: 'liberado', liberadoAt: new Date(), stripeTransferId: transfer.id },
  });
}

/** Cancela la autorización y reembolsa si el servicio se cancela antes de completarse. */
export async function refundPayment(serviceRequestId: string) {
  const pago = await prisma.payment.findUnique({ where: { serviceRequestId } });
  if (!pago?.stripePaymentIntentId) throw new Error('PAGO_NO_ENCONTRADO');

  await stripe.paymentIntents.cancel(pago.stripePaymentIntentId);

  return prisma.payment.update({
    where: { serviceRequestId },
    data: { estado: 'reembolsado' },
  });
}
