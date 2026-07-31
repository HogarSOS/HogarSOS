import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';

const COMISION_PLATAFORMA_PORCENTAJE = Number(process.env.PLATFORM_COMMISSION_PERCENT ?? 18);

/**
 * Modelo de pago tipo escrow, usando Stripe Connect:
 *
 * 1. AUTORIZAR (createEscrowPaymentIntent): se crea un PaymentIntent con
 *    capture_method: 'manual'. Esto AUTORIZA el cargo en la tarjeta del
 *    cliente pero NO mueve el dinero todavía — queda "retenido". Puede
 *    llamarse más de una vez por solicitud: la autorización inicial
 *    (del presupuesto aceptado) y, si el trabajo es "por_horas" y se
 *    alarga, una autorización más por cada ampliación aceptada — cada
 *    una es un PaymentIntent independiente, no se modifica el importe
 *    de uno ya existente (más simple y compatible entre bancos que
 *    depender de la autorización incremental nativa de Stripe).
 *
 * 2. CAPTURAR + TRANSFERIR (releasePayments): cuando el trabajo se da
 *    por completado con un importe final conocido, se recorren todas
 *    las autorizaciones "retenido" de esa solicitud en orden y se
 *    captura de cada una lo que haga falta (completo, o parcial en la
 *    última) hasta cubrir el importe final; lo que sobre se cancela
 *    sin cobrarlo. Se transfiere la parte del profesional de cada
 *    captura a su cuenta Stripe Connect — la plataforma se queda con
 *    la comisión de cada una.
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
  presupuestoId: string;
  ampliacionId?: string;
  montoTotal: number;
  clienteStripeCustomerId?: string;
}) {
  const { serviceRequestId, presupuestoId, ampliacionId, montoTotal, clienteStripeCustomerId } = params;
  const { comision, montoProfesional } = calcularComision(montoTotal);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(montoTotal * 100), // Stripe trabaja en céntimos
    currency: 'eur',
    capture_method: 'manual', // clave del modelo escrow: autoriza sin capturar
    customer: clienteStripeCustomerId,
    metadata: { serviceRequestId, presupuestoId, ...(ampliacionId ? { ampliacionId } : {}) },
  });

  const pago = await prisma.payment.create({
    data: {
      serviceRequestId,
      presupuestoId,
      ampliacionId,
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
 * Captura lo necesario de las autorizaciones "retenido" de una
 * solicitud hasta cubrir `importeFinal`, y cancela (sin cobrar) el
 * resto. Se llama al cerrar el trabajo — para "cerrado" el importe
 * final es siempre el total autorizado (una sola autorización, se
 * captura entera); para "por_horas" puede ser menor que lo autorizado
 * (varias autorizaciones si hubo ampliaciones, la última se captura
 * solo en parte y el resto queda liberado en la tarjeta del cliente).
 */
export async function releasePayments(serviceRequestId: string, importeFinal: number) {
  const pagos = await prisma.payment.findMany({
    where: { serviceRequestId, estado: 'retenido' },
    orderBy: { createdAt: 'asc' },
  });
  if (pagos.length === 0) throw new Error('PAGO_NO_ENCONTRADO');

  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id: serviceRequestId },
    include: { profesional: true },
  });
  if (!solicitud?.profesional?.stripeAccountId) {
    throw new Error('PROFESIONAL_SIN_CUENTA_STRIPE');
  }

  let restante = importeFinal;
  const resultados = [];

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) throw new Error('SIN_PAYMENT_INTENT');

    if (restante <= 0) {
      // Nada que cobrar de esta autorización — se cancela entera, el
      // cliente nunca llega a pagarla.
      await stripe.paymentIntents.cancel(pago.stripePaymentIntentId);
      resultados.push(
        await prisma.payment.update({ where: { id: pago.id }, data: { estado: 'reembolsado' } })
      );
      continue;
    }

    const montoAutorizado = Number(pago.montoTotal);
    const aCapturar = Number(Math.min(restante, montoAutorizado).toFixed(2));
    const capturaParcial = aCapturar < montoAutorizado;

    // Capturar menos del importe autorizado libera automáticamente el
    // resto de esa autorización en Stripe — no hace falta cancelarla
    // aparte.
    const paymentIntentCapturado = await stripe.paymentIntents.capture(
      pago.stripePaymentIntentId,
      capturaParcial ? { amount_to_capture: Math.round(aCapturar * 100) } : undefined
    );

    const chargeId = typeof paymentIntentCapturado.latest_charge === 'string'
      ? paymentIntentCapturado.latest_charge
      : paymentIntentCapturado.latest_charge?.id;

    const { comision, montoProfesional } = calcularComision(aCapturar);
    const transfer = await stripe.transfers.create({
      amount: Math.round(montoProfesional * 100),
      currency: 'eur',
      destination: solicitud.profesional.stripeAccountId,
      source_transaction: chargeId,
    });

    resultados.push(
      await prisma.payment.update({
        where: { id: pago.id },
        data: {
          estado: 'liberado',
          liberadoAt: new Date(),
          stripeTransferId: transfer.id,
          // Se ajustan a lo REALMENTE capturado (puede ser menos que
          // lo autorizado) para que la suma de las filas "liberado"
          // refleje el dinero que de verdad se movió.
          montoTotal: aCapturar,
          comisionPlataforma: comision,
          montoProfesional,
        },
      })
    );

    restante = Number((restante - aCapturar).toFixed(2));
  }

  return resultados;
}

/** Cancela y reembolsa todas las autorizaciones retenidas de una solicitud — se llama al cancelarse antes de completarse. */
export async function refundPayment(serviceRequestId: string) {
  const pagos = await prisma.payment.findMany({ where: { serviceRequestId, estado: 'retenido' } });
  if (pagos.length === 0) throw new Error('PAGO_NO_ENCONTRADO');

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) continue;
    await stripe.paymentIntents.cancel(pago.stripePaymentIntentId);
    await prisma.payment.update({ where: { id: pago.id }, data: { estado: 'reembolsado' } });
  }
}
