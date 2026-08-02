import Stripe from 'stripe';
import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import { sincronizarEstadoCuentaStripe, derivarEstadoCuentaStripe, EstadoCuentaStripe } from './professional.service';

export const COMISION_CLIENTE_PORCENTAJE = Number(process.env.PLATFORM_COMMISSION_CLIENT_PERCENT ?? 5);
export const COMISION_PROFESIONAL_PORCENTAJE = Number(process.env.PLATFORM_COMMISSION_PROFESSIONAL_PERCENT ?? 5);

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
 * Modelo de comisión: el profesional cotiza un `montoBase` (lo que él
 * cobra). El cliente paga `montoBase * (1 + %cliente)`, el profesional
 * recibe `montoBase * (1 - %profesional)` — ambos porcentajes son
 * variables de entorno independientes, sin ningún concepto de "promo"
 * en el código: si en un momento dado ambas están a 0, es simplemente
 * el valor vigente (la UI decide si eso merece un distintivo especial).
 *
 * IMPORTANTE: `releasePayments` NUNCA recalcula el desglose con los
 * porcentajes vigentes en ese momento — los porcentajes pueden haber
 * cambiado entre la autorización y la liberación (que puede ocurrir
 * días después). En vez de eso, escala proporcionalmente los importes
 * YA FIJADOS en cada autorización (`montoTotal`/`montoProfesional` de
 * esa fila) según qué fracción de su `montoBase` autorizado se está
 * consumiendo realmente. Así cada autorización honra el acuerdo con el
 * que el cliente/profesional la aceptaron, pase lo que pase después.
 *
 * Nota: Stripe autoriza los cargos por un máximo de ~7 días según el
 * método de pago. Si un servicio tarda más en completarse, haría falta
 * lógica adicional de re-autorización — no cubierto en este MVP.
 */

export function calcularDesglose(montoBase: number) {
  const montoTotalCliente = Number((montoBase * (1 + COMISION_CLIENTE_PORCENTAJE / 100)).toFixed(2));
  const montoProfesional = Number((montoBase * (1 - COMISION_PROFESIONAL_PORCENTAJE / 100)).toFixed(2));
  const comisionPlataforma = Number((montoTotalCliente - montoProfesional).toFixed(2));
  return { montoBase, montoTotalCliente, montoProfesional, comisionPlataforma };
}

export async function createEscrowPaymentIntent(params: {
  serviceRequestId: string;
  presupuestoId: string;
  ampliacionId?: string;
  montoBase: number;
  clienteStripeCustomerId?: string;
}) {
  const { serviceRequestId, presupuestoId, ampliacionId, montoBase, clienteStripeCustomerId } = params;
  const { montoTotalCliente, montoProfesional, comisionPlataforma } = calcularDesglose(montoBase);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(montoTotalCliente * 100), // Stripe trabaja en céntimos
    currency: 'eur',
    capture_method: 'manual', // clave del modelo escrow: autoriza sin capturar
    // Solo tarjeta: la cuenta tiene activados por defecto métodos como
    // Klarna/Amazon Pay/Satispay que NO soportan captura manual, y con
    // automatic_payment_methods habilitado (el default de la cuenta) el
    // Payment Sheet del móvil falla al inicializarse por esos métodos
    // incompatibles antes de que el cliente llegue a ver el formulario
    // de tarjeta. Tarjeta es además el único método que tiene sentido
    // para un pago retenido de días.
    payment_method_types: ['card'],
    customer: clienteStripeCustomerId,
    metadata: { serviceRequestId, presupuestoId, ...(ampliacionId ? { ampliacionId } : {}) },
  });

  const pago = await prisma.payment.create({
    data: {
      serviceRequestId,
      presupuestoId,
      ampliacionId,
      montoBase,
      montoTotal: montoTotalCliente,
      comisionPlataforma,
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
export async function releasePayments(serviceRequestId: string, baseFinal: number) {
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

  // stripeAccountId != null solo dice que el profesional EMPEZÓ el
  // onboarding, no que Stripe ya pueda transferirle — sin esto,
  // stripe.transfers.create() de más abajo fallaba en Stripe con una
  // cuenta que existe pero no tiene payouts habilitados (verificación
  // de identidad pendiente, documentación adicional pedida, etc.).
  // Se re-sincroniza en caliente en vez de fiarse del flag ya
  // guardado en BD, por si el webhook account.updated no ha llegado
  // todavía (ver professional.service.ts).
  const cuentaActualizada = await sincronizarEstadoCuentaStripe(
    solicitud.profesional.userId,
    solicitud.profesional.stripeAccountId
  );
  if (!cuentaActualizada.stripePayoutsEnabled) {
    throw new Error('PROFESIONAL_CUENTA_STRIPE_NO_OPERATIVA');
  }

  let restanteBase = baseFinal;
  const resultados = [];

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) throw new Error('SIN_PAYMENT_INTENT');

    if (restanteBase <= 0) {
      // Nada que cobrar de esta autorización — se cancela entera, el
      // cliente nunca llega a pagarla.
      await stripe.paymentIntents.cancel(pago.stripePaymentIntentId);
      resultados.push(
        await prisma.payment.update({ where: { id: pago.id }, data: { estado: 'reembolsado' } })
      );
      continue;
    }

    const montoBaseAutorizado = Number(pago.montoBase);
    const baseAConsumir = Number(Math.min(restanteBase, montoBaseAutorizado).toFixed(2));
    const capturaParcial = baseAConsumir < montoBaseAutorizado;
    const fraccion = baseAConsumir / montoBaseAutorizado;

    // Escalamos lo YA FIJADO en esta autorización — nunca recalculamos
    // el desglose con los porcentajes vigentes ahora mismo (ver nota en
    // la cabecera del archivo). Con consumo completo usamos el valor
    // exacto guardado, para no arrastrar el redondeo de la fracción.
    const aCapturarCliente = capturaParcial
      ? Number((Number(pago.montoTotal) * fraccion).toFixed(2))
      : Number(pago.montoTotal);
    const montoProfesionalTransfer = capturaParcial
      ? Number((Number(pago.montoProfesional) * fraccion).toFixed(2))
      : Number(pago.montoProfesional);

    // Capturar menos del importe autorizado libera automáticamente el
    // resto de esa autorización en Stripe — no hace falta cancelarla
    // aparte.
    const paymentIntentCapturado = await stripe.paymentIntents.capture(
      pago.stripePaymentIntentId,
      capturaParcial ? { amount_to_capture: Math.round(aCapturarCliente * 100) } : undefined
    );

    const chargeId = typeof paymentIntentCapturado.latest_charge === 'string'
      ? paymentIntentCapturado.latest_charge
      : paymentIntentCapturado.latest_charge?.id;

    const transfer = await stripe.transfers.create({
      amount: Math.round(montoProfesionalTransfer * 100),
      currency: 'eur',
      destination: solicitud.profesional.stripeAccountId,
      source_transaction: chargeId,
    });

    const comisionReal = Number((aCapturarCliente - montoProfesionalTransfer).toFixed(2));

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
          montoBase: baseAConsumir,
          montoTotal: aCapturarCliente,
          comisionPlataforma: comisionReal,
          montoProfesional: montoProfesionalTransfer,
        },
      })
    );

    restanteBase = Number((restanteBase - baseAConsumir).toFixed(2));
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

export interface ResumenPagoHistorial {
  id: string;
  monto: number;
  fecha: Date;
  categoria: string;
  descripcion: string;
}

export interface ResumenPagos {
  estadoCuentaStripe: EstadoCuentaStripe;
  pendiente: number;
  disponible: number;
  moneda: string;
  historial: ResumenPagoHistorial[];
}

function _sumarImporteEur(items: Stripe.Balance['available']): number {
  const partidaEur = items.find((i) => i.currency === 'eur');
  return partidaEur ? partidaEur.amount / 100 : 0;
}

/**
 * Centro de Pagos del profesional. "Pendiente" y "Disponible" se leen
 * directamente del saldo real de Stripe Connect (`stripe.balance.retrieve`
 * en el contexto de la cuenta conectada) — decisión de arquitectura del
 * roadmap económico: Stripe es la fuente de verdad de cuánto dinero hay
 * de verdad y en qué estado, no se recalcula a partir de las filas de
 * `Payment` (esas solo dan el historial de cobros ya liberados).
 *
 * Deliberadamente NO incluye "Próximo pago": los payouts de HogarSOS son
 * bajo demanda, no hay una fecha de pago recurrente que mostrar (decisión
 * de producto ya tomada, ver roadmap económico).
 *
 * Preparado para un futuro botón "Cobrar ahora" (Stripe Instant Payout):
 * cuando se implemente, la función iría aquí al lado (p.ej.
 * `crearInstantPayout(userId)`), usando `stripe.payouts.create({...},
 * { stripeAccount })` sobre el mismo saldo "disponible" que ya calcula
 * esta función — no hace falta tocar nada de lo de arriba.
 */
export async function obtenerResumenPagos(userId: string): Promise<ResumenPagos> {
  const profesional = await prisma.professional.findUnique({ where: { userId } });
  if (!profesional) throw new Error('PROFESSIONAL_NOT_FOUND');

  const estadoCuentaStripe = derivarEstadoCuentaStripe(profesional);

  let pendiente = 0;
  let disponible = 0;

  // Sin cuenta Stripe todavía (ni siquiera empezó el onboarding) no hay
  // nada que consultar — 0/0 es el estado correcto, no un error.
  if (profesional.stripeAccountId) {
    const balance = await stripe.balance.retrieve({ stripeAccount: profesional.stripeAccountId });
    pendiente = _sumarImporteEur(balance.pending);
    disponible = _sumarImporteEur(balance.available);
  }

  const pagosLiberados = await prisma.payment.findMany({
    where: { estado: 'liberado', serviceRequest: { profesionalId: userId } },
    orderBy: { liberadoAt: 'desc' },
    take: 50,
    include: { serviceRequest: { include: { categoria: true } } },
  });

  const historial: ResumenPagoHistorial[] = pagosLiberados.map((p) => ({
    id: p.id,
    monto: Number(p.montoProfesional),
    fecha: p.liberadoAt!,
    categoria: p.serviceRequest.categoria.nombre,
    descripcion: p.serviceRequest.descripcion,
  }));

  return { estadoCuentaStripe, pendiente, disponible, moneda: 'eur', historial };
}
