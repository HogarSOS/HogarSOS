import Stripe from 'stripe';
import { Payment, Prisma } from '@prisma/client';
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
 *
 * ---------------------------------------------------------------
 * LIBERACIÓN EN DOS FASES, IDEMPOTENTE Y REANUDABLE
 * ---------------------------------------------------------------
 *
 * `releasePayments` hace por cada autorización tres efectos que NO
 * pueden ser atómicos entre sí:
 *
 *   ① stripe.paymentIntents.capture()  (sale el dinero del cliente)
 *   ② stripe.transfers.create()        (entra el dinero al profesional)
 *   ③ prisma.payment.update()          (lo registramos aquí)
 *
 * Antes, morir entre ① y ③ dejaba el dinero capturado al cliente, sin
 * transferir al profesional y sin ninguna forma automática de salir de
 * ahí: el pre-chequeo exigía que TODAS las autorizaciones estuvieran en
 * `requires_capture`, y una ya capturada está en `succeeded`, así que
 * cualquier reintento moría con PAGO_NO_AUTORIZADO_TODAVIA para siempre.
 *
 * La solución NO es un try/catch más fino: es que la base de datos
 * registre la intención ANTES de cada efecto y el resultado DESPUÉS
 * (write-ahead), de modo que siempre se pueda saber en cuál de los tres
 * pasos se murió y seguir hacia adelante.
 *
 * Piezas:
 *
 * - Estado `capturado` (① hecho, ② no): antes existía en la realidad
 *   pero era invisible aquí. Ahora es consultable y reanudable.
 * - `capturadoBase/Total/Profesional`: el PLAN congelado antes de tocar
 *   Stripe. Independiente a propósito de `montoBase/Total/Profesional`,
 *   que siguen guardando lo AUTORIZADO — si se sobrescribieran al
 *   empezar (como hacía la versión anterior), un reintento ya no
 *   tendría con qué re-planificar. Solo se sobrescriben al final, al
 *   pasar a `liberado`, para que todo lo que ya leía esas columnas
 *   (historial del Centro de Pagos) siga funcionando igual.
 * - Claves de idempotencia deterministas (`cap_<id>`, `trf_<id>`,
 *   `cnl_<id>`): un reintento dentro de 24 h devuelve la respuesta
 *   original en lugar de ejecutar la operación otra vez.
 * - Doble red por si la clave de idempotencia ya caducó (>24 h):
 *   la captura se detecta releyendo el PaymentIntent (`succeeded`), y
 *   la transferencia buscando por `transfer_group` antes de crearla.
 * - Lease con expiración (`liberacionEnCursoAt`) para que dos
 *   ejecuciones simultáneas no se pisen, sin bloquear el pool de
 *   conexiones con una transacción larga y sin quedarse bloqueado para
 *   siempre si Render reinicia en pleno vuelo.
 */

/** Milisegundos que un lease de liberación se considera vivo antes de darlo por abandonado (ej. reinicio de Render en pleno vuelo). */
const LEASE_LIBERACION_MS = 5 * 60 * 1000;

/** Estados de los que una liberación todavía puede (y debe) avanzar. */
const ESTADOS_LIBERABLES = ['retenido', 'capturado'] as const;

/** Redondeo a céntimos en el dominio decimal, para no arrastrar el error binario de coma flotante entre pasos. */
function redondear2(n: number): number {
  return Number(n.toFixed(2));
}

function aCentimos(euros: number): number {
  return Math.round(euros * 100);
}

function extraerChargeId(intent: Stripe.PaymentIntent): string | undefined {
  return typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
}

export function calcularDesglose(montoBase: number) {
  const montoTotalCliente = Number((montoBase * (1 + COMISION_CLIENTE_PORCENTAJE / 100)).toFixed(2));
  const montoProfesional = Number((montoBase * (1 - COMISION_PROFESIONAL_PORCENTAJE / 100)).toFixed(2));
  const comisionPlataforma = Number((montoTotalCliente - montoProfesional).toFixed(2));
  return { montoBase, montoTotalCliente, montoProfesional, comisionPlataforma };
}

/**
 * Un stripeCustomerId guardado deja de existir si se creó contra una
 * cuenta/modo de Stripe distinto al actual — el caso real fue el cambio de
 * test a live: los Customer de test no existen en live (son espacios
 * completamente separados), así que todo usuario que ya hubiera pagado
 * antes del cambio se quedaba con un id que Stripe rechaza con
 * resource_missing en CADA intento de pago futuro.
 */
async function stripeCustomerExiste(customerId: string): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !customer.deleted;
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing') return false;
    throw err;
  }
}

/**
 * Devuelve el Customer de Stripe del cliente, creándolo la primera vez
 * (perezoso: no se crea al registrarse, solo en su primer pago real).
 * Necesario para que Payment Sheet pueda ofrecer "recordar esta tarjeta"
 * (`setup_future_usage`) y mostrarla en pagos futuros.
 */
export async function obtenerOCrearStripeCustomerId(userId: string): Promise<string> {
  const usuario = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (usuario.stripeCustomerId && (await stripeCustomerExiste(usuario.stripeCustomerId))) {
    return usuario.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    name: usuario.nombre,
    email: usuario.email ?? undefined,
    phone: usuario.telefono ?? undefined,
    metadata: { userId },
  });

  await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/** Ephemeral Key de un solo uso para que Payment Sheet lea los métodos de pago guardados de este Customer. */
export async function crearEphemeralKey(customerId: string): Promise<string> {
  const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customerId }, { apiVersion: '2024-04-10' });
  return ephemeralKey.secret!;
}

export async function createEscrowPaymentIntent(params: {
  serviceRequestId: string;
  presupuestoId: string;
  ampliacionId?: string;
  montoBase: number;
  clienteStripeCustomerId: string;
}) {
  const { serviceRequestId, presupuestoId, ampliacionId, montoBase, clienteStripeCustomerId } = params;
  const { montoTotalCliente, montoProfesional, comisionPlataforma } = calcularDesglose(montoBase);

  const ephemeralKeySecret = await crearEphemeralKey(clienteStripeCustomerId);

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
    // Guarda la tarjeta en el Customer tras la autorización para que
    // Payment Sheet la ofrezca en el próximo pago (presupuesto,
    // ampliación o un trabajo distinto). No afecta al modelo de captura
    // manual/escrow: solo decide qué pasa con el método de pago
    // DESPUÉS de que este PaymentIntent se autorice.
    setup_future_usage: 'off_session',
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

  return {
    pago,
    clientSecret: paymentIntent.client_secret,
    customerId: clienteStripeCustomerId,
    ephemeralKeySecret,
  };
}

/**
 * Toma el lease de liberación de una solicitud. Atómico: el `updateMany`
 * condicional es la única sección crítica: si dos peticiones entran a la
 * vez (doble clic del admin, webhook + cierre manual...), solo una ve
 * `count > 0`. El lease caduca solo a los LEASE_LIBERACION_MS, así que un
 * reinicio de Render con el lease tomado no bloquea el pago para siempre.
 *
 * Incrementa `intentosLiberacion` en el mismo movimiento: a partir del
 * segundo intento se activa la búsqueda por `transfer_group` (red de
 * seguridad para cuando la clave de idempotencia de Stripe ya caducó).
 */
async function adquirirLeaseLiberacion(serviceRequestId: string): Promise<boolean> {
  const limite = new Date(Date.now() - LEASE_LIBERACION_MS);

  const { count } = await prisma.payment.updateMany({
    where: {
      serviceRequestId,
      estado: { in: [...ESTADOS_LIBERABLES] },
      OR: [{ liberacionEnCursoAt: null }, { liberacionEnCursoAt: { lt: limite } }],
    },
    data: {
      liberacionEnCursoAt: new Date(),
      // A diferencia de liberacionEnCursoAt, este NO se limpia al soltar
      // el lease: es el que usa el backoff exponencial de la tarea
      // programada de reintento (ver jobs/reintentarPagosAtascados.job.ts)
      // para saber cuánto hace del último intento.
      ultimoIntentoLiberacionAt: new Date(),
      intentosLiberacion: { increment: 1 },
    },
  });

  return count > 0;
}

async function liberarLeaseLiberacion(serviceRequestId: string): Promise<void> {
  await prisma.payment.updateMany({
    where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
    data: { liberacionEnCursoAt: null },
  });
}

/**
 * Registra por qué falló el último intento, para que el endpoint de
 * admin (`GET /api/admin/payments/stuck`) pueda mostrarlo sin obligar a
 * bucear en los logs de Render.
 */
async function registrarFalloLiberacion(serviceRequestId: string, error: unknown): Promise<void> {
  const mensaje = error instanceof Error ? error.message : String(error);
  await prisma.payment
    .updateMany({
      where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
      data: { ultimoErrorLiberacion: mensaje.slice(0, 500) },
    })
    .catch((e) => console.error(`[releasePayments] No se pudo registrar el fallo de ${serviceRequestId}:`, e));
}

/**
 * Vista de una autorización durante la liberación. Deliberadamente más
 * laxa que el `Payment` de Prisma en los importes: mientras se ejecuta
 * se fusionan en memoria valores recién confirmados por Stripe, que son
 * `number` y no `Decimal`. Todo consumidor los pasa por `Number(...)`,
 * así que la distinción no aporta nada aquí y fingir que son `Decimal`
 * obligaría a castear en cada punto de fusión.
 */
type ImporteFila = Prisma.Decimal | number | null;

type PagoEnLiberacion = Omit<
  Payment,
  'capturadoBase' | 'capturadoTotal' | 'capturadoProfesional' | 'stripeChargeId'
> & {
  capturadoBase: ImporteFila;
  capturadoTotal: ImporteFila;
  capturadoProfesional: ImporteFila;
  stripeChargeId: string | null;
};

/** Una entrada del plan de liberación: qué hacer con una autorización concreta y con qué importes. */
interface PasoLiberacion {
  pago: PagoEnLiberacion;
  accion: 'capturar' | 'transferir' | 'cancelar';
  capturaParcial: boolean;
  baseAConsumir: number;
  capturadoTotal: number;
  capturadoProfesional: number;
  chargeId?: string;
}

/**
 * Captura ya ocurrida en Stripe que nunca llegó a registrarse aquí
 * (el proceso murió entre ① y su escritura). No es un error: es
 * exactamente el escenario que dejaba el dinero atrapado. Se adopta el
 * resultado real de Stripe como si lo hubiéramos capturado nosotros.
 *
 * `amount_received` es lo REALMENTE capturado en céntimos, que puede
 * ser menor que `montoTotal` si aquella ejecución hizo captura parcial —
 * se reconstruye la base y la parte del profesional con la misma
 * proporción que se usó entonces, nunca recalculando con los
 * porcentajes de comisión vigentes ahora.
 */
async function adoptarCapturaHuerfana(
  pago: PagoEnLiberacion,
  intent: Stripe.PaymentIntent
): Promise<PagoEnLiberacion> {
  const capturadoTotal = redondear2((intent.amount_received ?? 0) / 100);
  const fraccion = Number(pago.montoTotal) > 0 ? capturadoTotal / Number(pago.montoTotal) : 1;

  const datos = {
    estado: 'capturado' as const,
    capturadoAt: pago.capturadoAt ?? new Date(),
    stripeChargeId: extraerChargeId(intent) ?? pago.stripeChargeId ?? null,
    capturadoTotal,
    capturadoBase: redondear2(Number(pago.montoBase) * fraccion),
    capturadoProfesional: redondear2(Number(pago.montoProfesional) * fraccion),
  };

  await prisma.payment.update({ where: { id: pago.id }, data: datos });

  // Se fusiona sobre la fila que ya tenemos en memoria en lugar de
  // adoptar lo que devuelva el update: el resto de campos (id,
  // serviceRequestId, intentosLiberacion...) los necesita el paso
  // siguiente, y no deben depender de qué columnas decida devolver el
  // driver.
  return { ...pago, ...datos };
}

/**
 * Ejecuta ① (captura) de forma idempotente. La clave determinista hace
 * que un reintento dentro de 24 h devuelva la respuesta original en vez
 * de capturar otra vez. Pasadas las 24 h la clave caduca y Stripe
 * responde `payment_intent_unexpected_state` sobre un PaymentIntent ya
 * capturado — que no es un fallo, sino la captura anterior: se relee y
 * se adopta.
 */
async function capturarConIdempotencia(
  paso: PasoLiberacion
): Promise<{ pago: PagoEnLiberacion; chargeId?: string }> {
  const { pago } = paso;
  const paymentIntentId = pago.stripePaymentIntentId!;

  let intentCapturado: Stripe.PaymentIntent;
  try {
    intentCapturado = await stripe.paymentIntents.capture(
      paymentIntentId,
      // Capturar menos del importe autorizado libera automáticamente el
      // resto de esa autorización en Stripe — no hace falta cancelarla aparte.
      paso.capturaParcial ? { amount_to_capture: aCentimos(paso.capturadoTotal) } : undefined,
      { idempotencyKey: `cap_${pago.id}` }
    );
  } catch (e) {
    const codigo = (e as { code?: string })?.code;
    if (codigo !== 'payment_intent_unexpected_state') throw e;

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') throw e;
    console.warn(`[releasePayments] Captura previa adoptada para el pago ${pago.id} (clave de idempotencia caducada).`);
    intentCapturado = intent;
  }

  const chargeId = extraerChargeId(intentCapturado);

  const datos = { estado: 'capturado' as const, capturadoAt: new Date(), stripeChargeId: chargeId ?? null };

  // Persistir es para la SIGUIENTE ejecución (si la hay); el paso
  // siguiente de ESTA usa lo que Stripe acaba de confirmar, fusionado
  // sobre la fila en memoria — no lo que devuelva el update, que sería
  // depender de qué columnas decida devolver el driver.
  await prisma.payment.update({ where: { id: pago.id }, data: datos });

  return { pago: { ...pago, ...datos }, chargeId };
}

/**
 * Ejecuta ② (transferencia a la cuenta Connect) de forma idempotente,
 * con TRES barreras independientes contra pagar dos veces al
 * profesional: el `stripeTransferId` ya guardado, la clave de
 * idempotencia de Stripe (24 h), y la búsqueda por `transfer_group`
 * para cuando esa clave ya caducó.
 */
async function transferirConIdempotencia(
  paso: PasoLiberacion,
  stripeAccountId: string
): Promise<Payment> {
  const { pago } = paso;

  let transferId = pago.stripeTransferId ?? undefined;

  // Un intento anterior pudo crear la transferencia y morir antes de
  // guardarla. Solo se consulta a partir del segundo intento: en el
  // camino feliz no añade ninguna llamada extra a Stripe.
  if (!transferId && pago.intentosLiberacion > 1) {
    const previas = await stripe.transfers.list({ transfer_group: pago.id, limit: 1 });
    if (previas.data.length > 0) {
      transferId = previas.data[0].id;
      console.warn(`[releasePayments] Transferencia previa adoptada para el pago ${pago.id} (${transferId}).`);
    }
  }

  if (!transferId) {
    const transfer = await stripe.transfers.create(
      {
        amount: aCentimos(paso.capturadoProfesional),
        currency: 'eur',
        destination: stripeAccountId,
        source_transaction: paso.chargeId,
        // Lo que hace localizable la transferencia en un reintento
        // posterior sin depender de la clave de idempotencia.
        transfer_group: pago.id,
        metadata: { paymentId: pago.id, serviceRequestId: pago.serviceRequestId },
      },
      { idempotencyKey: `trf_${pago.id}` }
    );
    transferId = transfer.id;
  }

  return prisma.payment.update({
    where: { id: pago.id },
    data: {
      estado: 'liberado',
      liberadoAt: new Date(),
      stripeTransferId: transferId,
      // Se ajustan a lo REALMENTE capturado (puede ser menos que lo
      // autorizado) para que la suma de las filas "liberado" refleje el
      // dinero que de verdad se movió. Se hace SOLO aquí, al final: los
      // importes autorizados se conservan intactos durante todo el
      // proceso para poder re-planificar si hace falta reintentar.
      montoBase: paso.baseAConsumir,
      montoTotal: paso.capturadoTotal,
      comisionPlataforma: redondear2(paso.capturadoTotal - paso.capturadoProfesional),
      montoProfesional: paso.capturadoProfesional,
      liberacionEnCursoAt: null,
      ultimoErrorLiberacion: null,
    },
  });
}

/**
 * Captura lo necesario de las autorizaciones pendientes de una solicitud
 * hasta cubrir `baseFinal`, y cancela (sin cobrar) el resto. Se llama al
 * cerrar el trabajo — para "cerrado" el importe final es siempre el total
 * autorizado (una sola autorización, se captura entera); para "por_horas"
 * puede ser menor que lo autorizado (varias autorizaciones si hubo
 * ampliaciones, la última se captura solo en parte y el resto queda
 * liberado en la tarjeta del cliente).
 *
 * IDEMPOTENTE Y REANUDABLE: llamarla dos veces no mueve dinero dos veces,
 * y si una ejecución anterior se quedó a medias, esta continúa desde el
 * punto exacto en que se quedó (ver cabecera del archivo). Esto es lo que
 * hace seguro el endpoint de reintento del panel de admin.
 */
export async function releasePayments(serviceRequestId: string, baseFinal: number) {
  if (!(await adquirirLeaseLiberacion(serviceRequestId))) {
    // O no hay nada que liberar, o hay otra ejecución dentro ahora mismo.
    // Se distingue para que el llamador pueda dar un mensaje honesto.
    const pendientes = await prisma.payment.count({
      where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
    });
    throw new Error(pendientes === 0 ? 'PAGO_NO_ENCONTRADO' : 'LIBERACION_YA_EN_CURSO');
  }

  try {
    const resultados = await ejecutarLiberacion(serviceRequestId, baseFinal);
    return resultados;
  } catch (e) {
    await registrarFalloLiberacion(serviceRequestId, e);
    throw e;
  } finally {
    await liberarLeaseLiberacion(serviceRequestId).catch((e) =>
      console.error(`[releasePayments] No se pudo liberar el lease de ${serviceRequestId}:`, e)
    );
  }
}

async function ejecutarLiberacion(serviceRequestId: string, baseFinal: number) {
  const pagos = await prisma.payment.findMany({
    where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
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

  // ---------- FASE 1: PLANIFICAR (sin mover ni un céntimo) ----------
  //
  // Se decide TODO antes de ejecutar nada, igual que hacía el
  // pre-chequeo de la versión anterior: si alguna autorización no está
  // en condiciones, se sale sin haber tocado las demás.
  const plan: PasoLiberacion[] = [];
  let restanteBase = baseFinal;

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) throw new Error('SIN_PAYMENT_INTENT');

    // Ya capturado en una ejecución anterior: su plan está CONGELADO,
    // no se re-planifica (los porcentajes de comisión pueden haber
    // cambiado entre medias, y el cliente ya pagó bajo el acuerdo
    // anterior). Solo consume de restanteBase lo que consumió entonces.
    if (pago.estado === 'capturado') {
      const baseYaConsumida = Number(pago.capturadoBase ?? 0);
      plan.push({
        pago,
        accion: 'transferir',
        capturaParcial: false,
        baseAConsumir: baseYaConsumida,
        capturadoTotal: Number(pago.capturadoTotal ?? 0),
        capturadoProfesional: Number(pago.capturadoProfesional ?? 0),
        chargeId: pago.stripeChargeId ?? undefined,
      });
      restanteBase = redondear2(restanteBase - baseYaConsumida);
      continue;
    }

    const intent = await stripe.paymentIntents.retrieve(pago.stripePaymentIntentId);

    // La captura ya ocurrió en Stripe pero nunca se registró aquí
    // (murió entre ① y su escritura). Se adopta y se pasa a transferir.
    if (intent.status === 'succeeded') {
      const adoptado = await adoptarCapturaHuerfana(pago, intent);
      plan.push({
        pago: adoptado,
        accion: 'transferir',
        capturaParcial: false,
        baseAConsumir: Number(adoptado.capturadoBase ?? 0),
        capturadoTotal: Number(adoptado.capturadoTotal ?? 0),
        capturadoProfesional: Number(adoptado.capturadoProfesional ?? 0),
        chargeId: adoptado.stripeChargeId ?? undefined,
      });
      restanteBase = redondear2(restanteBase - Number(adoptado.capturadoBase ?? 0));
      continue;
    }

    // `createEscrowPaymentIntent` marca la fila como 'retenido' en el
    // mismo momento en que se crea el PaymentIntent en Stripe, ANTES de
    // que el cliente llegue a confirmar el Payment Sheet (ver comentario
    // en payment.controller.ts). Si el cliente abandona esa confirmación,
    // la fila se queda 'retenido' aunque Stripe nunca haya autorizado
    // nada de verdad — y eso no se arregla reintentando, hace falta que
    // el cliente vuelva a confirmar el pago.
    if (intent.status !== 'requires_capture') {
      throw new Error('PAGO_NO_AUTORIZADO_TODAVIA');
    }

    if (restanteBase <= 0) {
      // Nada que cobrar de esta autorización — se cancela entera, el
      // cliente nunca llega a pagarla.
      plan.push({
        pago,
        accion: 'cancelar',
        capturaParcial: false,
        baseAConsumir: 0,
        capturadoTotal: 0,
        capturadoProfesional: 0,
      });
      continue;
    }

    const montoBaseAutorizado = Number(pago.montoBase);
    const baseAConsumir = redondear2(Math.min(restanteBase, montoBaseAutorizado));
    const capturaParcial = baseAConsumir < montoBaseAutorizado;
    const fraccion = baseAConsumir / montoBaseAutorizado;

    // Escalamos lo YA FIJADO en esta autorización — nunca recalculamos
    // el desglose con los porcentajes vigentes ahora mismo (ver nota en
    // la cabecera del archivo). Con consumo completo usamos el valor
    // exacto guardado, para no arrastrar el redondeo de la fracción.
    plan.push({
      pago,
      accion: 'capturar',
      capturaParcial,
      baseAConsumir,
      capturadoTotal: capturaParcial ? redondear2(Number(pago.montoTotal) * fraccion) : Number(pago.montoTotal),
      capturadoProfesional: capturaParcial
        ? redondear2(Number(pago.montoProfesional) * fraccion)
        : Number(pago.montoProfesional),
    });

    restanteBase = redondear2(restanteBase - baseAConsumir);
  }

  // ---------- FASE 1b: CONGELAR EL PLAN EN BD ANTES DE TOCAR STRIPE ----------
  //
  // Write-ahead: si el proceso muere justo después de capturar, el
  // reintento encuentra aquí con qué importes se hizo esa captura en
  // lugar de tener que adivinarlos.
  for (const paso of plan) {
    if (paso.accion !== 'capturar') continue;
    await prisma.payment.update({
      where: { id: paso.pago.id },
      data: {
        capturadoBase: paso.baseAConsumir,
        capturadoTotal: paso.capturadoTotal,
        capturadoProfesional: paso.capturadoProfesional,
      },
    });
  }

  // ---------- FASE 2: EJECUTAR ----------
  const resultados = [];

  for (const paso of plan) {
    if (paso.accion === 'cancelar') {
      await stripe.paymentIntents.cancel(paso.pago.stripePaymentIntentId!, undefined, {
        idempotencyKey: `cnl_${paso.pago.id}`,
      });
      resultados.push(
        await prisma.payment.update({
          where: { id: paso.pago.id },
          data: { estado: 'reembolsado', liberacionEnCursoAt: null },
        })
      );
      continue;
    }

    // El charge lo produce la captura de esta misma ejecución; en una
    // reanudación viene del que quedó guardado en la anterior (ya
    // resuelto en el plan).
    let pasoAEjecutar = paso;
    if (paso.accion === 'capturar') {
      const { pago, chargeId } = await capturarConIdempotencia(paso);
      pasoAEjecutar = { ...paso, pago, chargeId };
    }

    resultados.push(
      await transferirConIdempotencia(pasoAEjecutar, solicitud.profesional.stripeAccountId)
    );
  }

  return resultados;
}

/**
 * Deshace todas las autorizaciones pendientes de una solicitud — se
 * llama al cancelarse antes de completarse, y al resolver una disputa a
 * favor del cliente.
 *
 * Distingue los dos casos posibles, porque no se deshacen igual:
 *
 * - 'retenido': el dinero nunca salió de la tarjeta. Basta con cancelar
 *   la autorización.
 * - 'capturado': el dinero YA salió (una liberación anterior capturó
 *   pero no llegó a transferir). Una autorización capturada no se puede
 *   cancelar — hay que reembolsar el cargo. Antes este caso ni se
 *   contemplaba: `refundPayment` solo miraba 'retenido', así que una
 *   disputa a favor del cliente sobre un pago a medio liberar lanzaba
 *   PAGO_NO_ENCONTRADO y la disputa no se podía cerrar nunca.
 *
 * Ambas operaciones llevan clave de idempotencia determinista, así que
 * reintentar tras un timeout no cancela ni reembolsa dos veces.
 */
export async function refundPayment(serviceRequestId: string) {
  const pagos = await prisma.payment.findMany({
    where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
  });
  if (pagos.length === 0) throw new Error('PAGO_NO_ENCONTRADO');

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) continue;

    if (pago.estado === 'capturado') {
      await stripe.refunds.create(
        {
          payment_intent: pago.stripePaymentIntentId,
          metadata: { paymentId: pago.id, serviceRequestId },
        },
        { idempotencyKey: `ref_${pago.id}` }
      );
    } else {
      await stripe.paymentIntents.cancel(pago.stripePaymentIntentId, undefined, {
        idempotencyKey: `cnl_${pago.id}`,
      });
    }

    await prisma.payment.update({
      where: { id: pago.id },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
  }
}

export interface PagoAtascado {
  paymentId: string;
  serviceRequestId: string;
  estado: string;
  estadoSolicitud: string;
  montoProfesional: number;
  capturadoAt: Date | null;
  createdAt: Date;
  intentosLiberacion: number;
  ultimoError: string | null;
  /** El dinero ya salió de la tarjeta del cliente pero no ha llegado al profesional — máxima prioridad. */
  dineroRetenidoEnPlataforma: boolean;
}

/**
 * Cola de pagos que necesitan atención (auditoría B2). Dos categorías,
 * ambas invisibles antes de esto:
 *
 * - estado 'capturado': el dinero salió del cliente y NO ha llegado al
 *   profesional. Es dinero real parado en la cuenta de la plataforma.
 * - estado 'retenido' con la solicitud ya 'completada': el trabajo se
 *   dio por terminado pero la liberación nunca se completó.
 *
 * Ordenados por antigüedad: lo que más tiempo lleva atascado primero.
 */
export async function listarPagosAtascados(): Promise<PagoAtascado[]> {
  const pagos = await prisma.payment.findMany({
    where: {
      OR: [
        { estado: 'capturado' },
        { estado: 'retenido', serviceRequest: { estado: 'completada' } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    include: { serviceRequest: { select: { estado: true } } },
    take: 100,
  });

  return pagos.map((p) => ({
    paymentId: p.id,
    serviceRequestId: p.serviceRequestId,
    estado: p.estado,
    estadoSolicitud: p.serviceRequest.estado,
    montoProfesional: Number(p.capturadoProfesional ?? p.montoProfesional),
    capturadoAt: p.capturadoAt,
    createdAt: p.createdAt,
    intentosLiberacion: p.intentosLiberacion,
    ultimoError: p.ultimoErrorLiberacion,
    dineroRetenidoEnPlataforma: p.estado === 'capturado',
  }));
}

/**
 * Reintenta la liberación de una solicitud concreta desde el panel de
 * admin. No reimplementa nada: llama al MISMO `releasePayments` del
 * flujo normal, que ya es idempotente y reanudable — cualquier lógica
 * de reparación separada acabaría divergiendo del camino real.
 *
 * La base final se toma de `precioFinal` (lo que se fijó al completar
 * el trabajo). Si no está fijado — caso de una disputa resuelta a favor
 * del profesional, que no lo escribe — se recompone sumando las bases
 * autorizadas pendientes, exactamente como hace `resolveDispute`. Las
 * autorizaciones ya capturadas llevan su plan congelado, así que este
 * importe solo afecta a las que aún no se han tocado.
 */
export async function reintentarLiberacion(serviceRequestId: string) {
  const solicitud = await prisma.serviceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { precioFinal: true },
  });
  if (!solicitud) throw new Error('SOLICITUD_NO_ENCONTRADA');

  let baseFinal = solicitud.precioFinal ? Number(solicitud.precioFinal) : null;

  if (baseFinal === null) {
    const pendientes = await prisma.payment.findMany({
      where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
    });
    baseFinal = pendientes.reduce(
      (acc, p) => acc + Number(p.capturadoBase ?? p.montoBase),
      0
    );
  }

  return releasePayments(serviceRequestId, baseFinal);
}

export interface ResumenPagoHistorial {
  id: string;
  monto: number;
  fecha: Date;
  categoria: string;
  descripcion: string;
  nombreCliente: string;
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
    include: { serviceRequest: { include: { categoria: true, cliente: true } } },
  });

  // BUG 005 (QA, 2026-08-03): el historial solo mostraba la categoría
  // ("Electricista") — con varios cobros de la misma categoría no había
  // forma de distinguir uno de otro de un vistazo. El nombre del cliente
  // (ya disponible vía la relación `cliente` de ServiceRequest, no hacía
  // falta ningún dato nuevo) es mucho más identificable que repetir la
  // categoría en cada fila.
  const historial: ResumenPagoHistorial[] = pagosLiberados.map((p) => ({
    id: p.id,
    monto: Number(p.montoProfesional),
    fecha: p.liberadoAt!,
    categoria: p.serviceRequest.categoria.nombre,
    descripcion: p.serviceRequest.descripcion,
    nombreCliente: p.serviceRequest.cliente.nombre,
  }));

  return { estadoCuentaStripe, pendiente, disponible, moneda: 'eur', historial };
}
