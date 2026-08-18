import Stripe from 'stripe';
import { Payment, Prisma, EstadoPago } from '@prisma/client';
import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import {
  sincronizarEstadoCuentaStripe,
  derivarEstadoCuentaStripe,
  invalidarCuentaStripeSiEsDeOtroModo,
  EstadoCuentaStripe,
} from './professional.service';

export const COMISION_CLIENTE_PORCENTAJE = Number(process.env.PLATFORM_COMMISSION_CLIENT_PERCENT ?? 10);
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

/**
 * Milisegundos que un lease de liberación se considera vivo antes de
 * darlo por abandonado (ej. reinicio de Render en pleno vuelo). Exportada
 * porque `resolveDispute` (admin.controller.ts) reutiliza el mismo TTL
 * para el claim de Dispute — mismo tipo de operación (unas pocas
 * llamadas a Stripe + un par de escrituras), no hay motivo para un
 * número distinto, y una sola constante evita que las dos guardas se
 * desincronicen si algún día se ajusta el valor.
 */
export const LEASE_LIBERACION_MS = 5 * 60 * 1000;

/** Estados de los que una liberación todavía puede (y debe) avanzar. */
const ESTADOS_LIBERABLES = ['retenido', 'capturado'] as const;

/**
 * Estados de los que `refundPayment` todavía puede deshacer algo
 * (auditoría, hallazgo #4). Superconjunto de ESTADOS_LIBERABLES: incluye
 * 'liberado' porque una disputa puede resolverse a favor del cliente
 * DESPUÉS de que el trabajo ya se completara y el pago ya se transfiriera
 * al profesional — antes ese caso quedaba fuera por completo y
 * `resolveDispute` no tenía ninguna forma de cerrar la disputa.
 */
const ESTADOS_REEMBOLSABLES = ['retenido', 'capturado', 'liberado'] as const;

/**
 * Vocabulario nativo de `Dispute.Status` del SDK de Stripe instalado
 * (node_modules/stripe/types/Disputes.d.ts) — sin enum propio, P2 #7.
 * Bloquean cualquier movimiento de dinero (captura, transferencia,
 * cancelación, refund) todos los estados abiertos MÁS 'lost': una
 * disputa perdida significa que el dinero ya se perdió de forma
 * permanente, no que sea seguro reanudar movimientos — solo 'won' y
 * 'warning_closed' liberan el guard (ver heartbeat()).
 *
 * Exportada para que reintentarPagosAtascados.job.ts filtre los mismos
 * candidatos sin duplicar la lista — heartbeat() sigue siendo la
 * protección real (ver más abajo), esto es solo una exclusión temprana
 * para no gastar una llamada a Stripe en un pago que ya sabemos bloqueado.
 */
export const ESTADOS_DISPUTA_BLOQUEANTE = [
  'needs_response',
  'under_review',
  'warning_needs_response',
  'warning_under_review',
  'lost',
] as const;

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

  // Clave de idempotencia determinista (auditoría, hallazgo #3): dos
  // peticiones casi simultáneas para la MISMA autorización (doble tap en
  // "Pagar", reintento de red tras un timeout) calculan el mismo
  // presupuestoId/ampliacionId antes de llegar aquí. Sin esto, cada una
  // creaba su propio PaymentIntent — dos retenciones distintas en la
  // tarjeta del cliente por el mismo trabajo. Con la misma clave, Stripe
  // devuelve el MISMO PaymentIntent a ambas peticiones.
  const idempotencyKey = ampliacionId ? `intent_amp_${ampliacionId}` : `intent_pre_${presupuestoId}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
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
    },
    { idempotencyKey }
  );

  // La fila Payment tiene stripePaymentIntentId como @unique. Si dos
  // peticiones concurrentes reutilizaron el mismo PaymentIntent (arriba),
  // solo una de las dos consigue insertar aquí — la otra choca contra ese
  // unique (P2002), no porque haya un error real, sino porque la primera
  // ya dejó constancia de la misma autorización. Se adopta esa fila en
  // vez de propagar el error, para que ambas peticiones devuelvan la
  // misma respuesta al cliente.
  let pago;
  try {
    pago = await prisma.payment.create({
      data: {
        serviceRequestId,
        presupuestoId,
        ampliacionId,
        montoBase,
        montoTotal: montoTotalCliente,
        comisionPlataforma,
        montoProfesional,
        // 'pendiente', no 'retenido': todavía no sabemos si el cliente
        // va a confirmar el Payment Sheet. Ver comentario del enum
        // EstadoPago en el schema — el webhook amount_capturable_updated
        // es quien lo sube a 'retenido' cuando Stripe confirma de verdad.
        estado: 'pendiente',
        stripePaymentIntentId: paymentIntent.id,
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') {
      pago = await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: paymentIntent.id } });
    } else {
      throw e;
    }
  }

  return {
    pago,
    clientSecret: paymentIntent.client_secret,
    customerId: clienteStripeCustomerId,
    ephemeralKeySecret,
  };
}

/**
 * B5: una autorización con capture_method: 'manual' caduca sola en
 * Stripe a los ~7 días si nadie la captura (ver autorizacionesPorCaducar.job.ts,
 * que ya detecta esto y marca la fila como 'reembolsado'). Reintentar el
 * pago con el client_secret del PaymentIntent caducado no funciona nunca:
 * 'canceled' es un estado terminal en Stripe, no se puede reconfirmar.
 *
 * Esta función crea un PaymentIntent NUEVO en Stripe pero reutiliza la
 * MISMA fila Payment (UPDATE, no INSERT) — Payment no tiene restricción
 * única sobre (presupuestoId, ampliacionId), así que insertar una fila
 * nueva dejaría dos filas para la misma autorización y rompería la
 * asunción de "una fila por presupuesto/ampliación" que usan
 * releasePayments, refundPayment, listarPagosAtascados y el panel admin.
 *
 * Idempotencia: la clave `intent_retry_<pago.id>_<intento>` se deriva del
 * id de la fila (estable entre clics) y de un contador que solo avanza
 * al reautorizar — dos clics simultáneos sobre la misma fila calculan la
 * MISMA clave y Stripe devuelve el mismo PaymentIntent a ambos, igual
 * que ya protege createEscrowPaymentIntent la autorización original.
 */
export async function reautorizarPaymentIntent(
  pago: Payment,
  clienteStripeCustomerId: string
) {
  const ephemeralKeySecret = await crearEphemeralKey(clienteStripeCustomerId);
  const numeroIntento = pago.intentosAutorizacion + 1;
  const idempotencyKey = `intent_retry_${pago.id}_${numeroIntento}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
      // Importe ya fijado en la fila desde la autorización original —
      // nunca se recalcula desde el presupuesto ni se acepta del cliente.
      amount: Math.round(Number(pago.montoTotal) * 100),
      currency: 'eur',
      capture_method: 'manual',
      payment_method_types: ['card'],
      customer: clienteStripeCustomerId,
      setup_future_usage: 'off_session',
      metadata: {
        serviceRequestId: pago.serviceRequestId,
        presupuestoId: pago.presupuestoId,
        ...(pago.ampliacionId ? { ampliacionId: pago.ampliacionId } : {}),
        // Trazabilidad sin columna nueva: el PaymentIntent caducado sigue
        // existiendo en Stripe para siempre, buscable por esta metadata
        // desde el dashboard si hace falta reconstruir la cadena.
        paymentIntentIdAnterior: pago.stripePaymentIntentId ?? '',
      },
    },
    { idempotencyKey }
  );

  // Condicionado al stripePaymentIntentId que el llamador ya comprobó
  // como 'canceled' en Stripe — NO a estado: 'reembolsado', porque
  // autorizacionesPorCaducar.job.ts corre cada 6h y puede no haber
  // marcado la fila todavía aunque Stripe ya haya cancelado la
  // autorización de verdad. Si una petición concurrente con la misma
  // idempotency key ya aplicó este mismo cambio, count sale en 0 — no es
  // un error, Stripe ya devolvió el mismo PaymentIntent a ambas y el
  // findUniqueOrThrow de abajo recoge esa fila ya actualizada.
  await prisma.payment.updateMany({
    where: { id: pago.id, stripePaymentIntentId: pago.stripePaymentIntentId },
    data: {
      stripePaymentIntentId: paymentIntent.id,
      estado: 'pendiente',
      avisoCaducidadEnviadoAt: null,
      intentosAutorizacion: numeroIntento,
    },
  });

  const pagoActualizado = await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });

  return {
    pago: pagoActualizado,
    clientSecret: paymentIntent.client_secret,
    customerId: clienteStripeCustomerId,
    ephemeralKeySecret,
  };
}

/**
 * Una fila reclamada: su id y el fencing token con el que ESTA ejecución
 * la reclamó (ver `reclamarFilas`).
 */
interface FilaReclamada {
  id: string;
  intentosLiberacion: number;
}

/**
 * Reclama TODAS las filas de una solicitud que coincidan con `estados` y
 * cuyo lease esté libre o caducado — en una única sentencia atómica
 * `UPDATE ... RETURNING`, no `updateMany` (que solo devuelve `count`).
 *
 * P2 (auditoría 2026-08-14, revisión de concurrencia crítica): antes se
 * usaba `updateMany` + un `findMany` posterior filtrado solo por
 * `estado` — eso significaba que, si `releasePayments` y `refundPayment`
 * usan listas de estados distintas (ESTADOS_LIBERABLES es subconjunto de
 * ESTADOS_REEMBOLSABLES), una de las dos podía "conseguir el lease"
 * (`count > 0` sobre AL MENOS una fila) y luego procesar, sin saberlo,
 * OTRAS filas de la misma solicitud que en realidad tenía tomadas la
 * otra ejecución — un split-brain real con solicitudes de estados
 * mixtos (el caso exacto que motivó `refundPayment` en el hallazgo #4).
 * `RETURNING id` elimina la ambigüedad: los IDs reclamados son
 * EXACTAMENTE los que esta sentencia consiguió bloquear, ni uno más.
 *
 * `estado::text IN (...)` castea el enum `EstadoPago` a texto porque el
 * SQL crudo no pasa por el mapeo de tipos de Prisma.
 */
async function reclamarFilas(
  serviceRequestId: string,
  estados: readonly EstadoPago[]
): Promise<FilaReclamada[]> {
  const limite = new Date(Date.now() - LEASE_LIBERACION_MS);

  return prisma.$queryRaw<FilaReclamada[]>`
    UPDATE payments
    SET liberacion_en_curso_at = now(),
        ultimo_intento_liberacion_at = now(),
        intentos_liberacion = intentos_liberacion + 1
    WHERE service_request_id = ${serviceRequestId}
      AND estado::text IN (${Prisma.join(estados)})
      AND (liberacion_en_curso_at IS NULL OR liberacion_en_curso_at < ${limite})
    RETURNING id, intentos_liberacion AS "intentosLiberacion"
  `;
}

/**
 * Reclama TODO lo relevante o aborta entero — nunca un subconjunto. Si
 * `reclamarFilas` consigue menos filas de las que existen para ese
 * `serviceRequestId`+`estados` (alguna ya está tomada por la otra
 * operación), procesar solo lo reclamado dejaría la planificación de
 * `ejecutarLiberacion`/`ejecutarReembolso` incompleta o, peor, tocando
 * Stripe sobre una fila que la otra ejecución tiene en curso. Todo o
 * nada es lo único que garantiza que release y refund nunca se crucen.
 */
async function reclamarTodoOAbortar(
  serviceRequestId: string,
  estados: readonly EstadoPago[]
): Promise<FilaReclamada[]> {
  const reclamadas = await reclamarFilas(serviceRequestId, estados);
  const totalRelevantes = await prisma.payment.count({
    where: { serviceRequestId, estado: { in: [...estados] } },
  });

  if (reclamadas.length === 0) {
    throw new Error(totalRelevantes === 0 ? 'PAGO_NO_ENCONTRADO' : 'LIBERACION_YA_EN_CURSO');
  }
  if (reclamadas.length < totalRelevantes) {
    await liberarFilas(reclamadas);
    throw new Error('LIBERACION_YA_EN_CURSO');
  }
  return reclamadas;
}

/**
 * Escribe `data` en cada fila reclamada, pero SOLO si `intentosLiberacion`
 * sigue siendo exactamente el token con el que esta ejecución la
 * reclamó — el fencing token viaja en memoria desde `reclamarFilas` hasta
 * aquí sin recalcularse nunca.
 *
 * Revisión de concurrencia crítica (ABA): un `UPDATE ... WHERE id IN
 * (...)` sin esta condición podía, si ESTA ejecución se quedaba colgada
 * (no muerta) más de LEASE_LIBERACION_MS, escribir sobre una fila que
 * mientras tanto otra ejecución ya había reclamado de nuevo tras la
 * caducidad — soltando o contaminando el lease del nuevo propietario
 * legítimo sin que él lo supiera. `intentosLiberacion` (ya existente,
 * se incrementa atómicamente en cada reclamo) es un fencing token
 * entero: a diferencia de un DateTime, su igualdad no depende de
 * ninguna precisión de reloj — o es exactamente el mismo número, o no.
 * Se hace una llamada por fila porque cada una puede llevar un token
 * distinto (intentos previos distintos), así que no se puede comparar
 * con un único valor escalar en un `updateMany` conjunto.
 */
async function actualizarSiPropietario(
  filas: FilaReclamada[],
  data: Prisma.PaymentUpdateManyMutationInput
): Promise<void> {
  await Promise.all(
    filas.map((f) =>
      prisma.payment.updateMany({
        where: { id: f.id, intentosLiberacion: f.intentosLiberacion },
        data,
      })
    )
  );
}

async function liberarFilas(filas: FilaReclamada[]): Promise<void> {
  if (filas.length === 0) return;
  await actualizarSiPropietario(filas, { liberacionEnCursoAt: null });
}

/**
 * Heartbeat: comprueba Y renueva el lease en una única sentencia atómica,
 * justo antes de cada llamada MUTANTE a Stripe (capture/transfer/cancel/
 * refund) dentro de una operación que ya lleva un rato en marcha.
 *
 * Revisión de concurrencia crítica (release↔refund): un fencing token
 * comprobado solo al principio (en el claim) no protege nada de lo que
 * pasa DESPUÉS si la ejecución se queda colgada más de LEASE_LIBERACION_MS
 * a mitad de camino — el lease ya caducó y otra ejecución puede haberlo
 * reclamado antes de que esta llegue a la siguiente llamada a Stripe.
 * Releer aquí, justo antes de esa llamada, con el MISMO token capturado
 * originalmente (nunca uno recalculado), reduce esa ventana de "toda la
 * duración de la operación" a "la duración de una sola llamada HTTP a
 * Stripe" — no la elimina matemáticamente (un fencing de BD no puede
 * cancelar una llamada a Stripe ya en vuelo), pero si el heartbeat
 * devuelve false, la llamada a Stripe correspondiente NUNCA se hace.
 *
 * Al renovar `liberacionEnCursoAt` en cada heartbeat, una operación
 * LEGÍTIMA que tarda más de 5 minutos en conjunto (varias filas, cada
 * captura/transferencia tarda su tiempo) pero sigue avanzando y llamando
 * a este heartbeat en cada paso NUNCA pierde el lease de verdad — solo
 * lo pierde una ejecución que de verdad dejó de avanzar.
 *
 * P2 #7: el mismo UPDATE exige además que no haya una disputa de Stripe
 * bloqueante — es el único punto de todo el archivo por el que pasan
 * las cuatro llamadas mutantes (captura, transferencia, cancelación,
 * refund), así que extenderlo aquí protege a las cuatro sin duplicar
 * la comprobación en cada una. Si el UPDATE afecta 0 filas puede ser
 * por dos motivos distintos — lease perdido, o disputa activa — y el
 * llamador necesita distinguirlos para lanzar el error correcto; una
 * única lectura adicional, solo en el camino de fallo, decide cuál fue.
 */
type ResultadoHeartbeat = 'ok' | 'lease_perdido' | 'disputa_activa';

async function heartbeat(paymentId: string, token: number): Promise<ResultadoHeartbeat> {
  const { count } = await prisma.payment.updateMany({
    where: {
      id: paymentId,
      intentosLiberacion: token,
      OR: [
        { stripeDisputeStatus: null },
        { stripeDisputeStatus: { notIn: [...ESTADOS_DISPUTA_BLOQUEANTE] } },
      ],
    },
    data: { liberacionEnCursoAt: new Date() },
  });
  if (count > 0) return 'ok';

  const actual = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { stripeDisputeStatus: true },
  });
  if (actual?.stripeDisputeStatus && (ESTADOS_DISPUTA_BLOQUEANTE as readonly string[]).includes(actual.stripeDisputeStatus)) {
    return 'disputa_activa';
  }
  return 'lease_perdido';
}

/**
 * Punto único para los cuatro llamadores de heartbeat() (captura,
 * transferencia, cancelación, refund) — así ninguno repite el if/else
 * que traduce el resultado al error correcto (P2 #7).
 */
async function exigirHeartbeat(paymentId: string, token: number): Promise<void> {
  const resultado = await heartbeat(paymentId, token);
  if (resultado === 'disputa_activa') throw new Error('PAGO_EN_DISPUTA');
  if (resultado === 'lease_perdido') throw new Error('LIBERACION_YA_EN_CURSO');
}

/**
 * Escribe el resultado de una llamada a Stripe que YA tuvo éxito, pero
 * SOLO si esta ejecución sigue siendo la propietaria (mismo token). No
 * podemos deshacer retroactivamente una llamada a Stripe que ya terminó
 * — si el UPDATE afecta 0 filas, Stripe ya movió dinero de verdad (o
 * confirmó una autorización/cancelación) pero el dueño en BD cambió
 * mientras la llamada estaba en vuelo. Eso NO se trata como éxito local
 * ni se sobrescribe al nuevo propietario: se registra explícitamente
 * como resultado de Stripe confirmado con ownership perdido — un
 * "huérfano" — para que se pueda investigar a mano. Reutiliza el mismo
 * `console.error` con prefijo ya usado en todo este archivo para los
 * logs de Render, en vez de inventar un mecanismo de observabilidad
 * nuevo. Solo se registran IDs de objetos de Stripe (nunca datos de
 * tarjeta, cliente ni ningún secreto — esos IDs no lo son).
 */
async function escribirResultadoStripe(
  paymentId: string,
  token: number,
  data: Prisma.PaymentUpdateManyMutationInput,
  contexto: { operacion: string; stripeResultadoId: string | undefined }
): Promise<void> {
  const { count } = await prisma.payment.updateMany({
    where: { id: paymentId, intentosLiberacion: token },
    data,
  });
  if (count === 0) {
    console.error(
      `[STRIPE_HUERFANO] paymentId=${paymentId} operacion=${contexto.operacion} tokenPerdido=${token} ` +
        `stripeResultadoId=${contexto.stripeResultadoId ?? 'desconocido'} — Stripe confirmó esta operación con ` +
        `éxito pero el UPDATE condicionado al fencing token afectó 0 filas: otra ejecución ya es la propietaria ` +
        `de este Payment. Este movimiento de Stripe existe de verdad y no quedó reflejado en BD; requiere revisión manual.`
    );
    throw new Error('LIBERACION_YA_EN_CURSO');
  }
}

/**
 * Registra por qué falló el último intento, para que el endpoint de
 * admin (`GET /api/admin/payments/stuck`) pueda mostrarlo sin obligar a
 * bucear en los logs de Render. Condicionado al mismo fencing token que
 * `liberarFilas` — mismo motivo: si esta ejecución se quedó colgada y
 * otra ya reclamó las mismas filas, no debe escribir nada sobre ellas.
 */
async function registrarFalloLiberacion(filas: FilaReclamada[], error: unknown): Promise<void> {
  const mensaje = error instanceof Error ? error.message : String(error);
  await actualizarSiPropietario(filas, { ultimoErrorLiberacion: mensaje.slice(0, 500) }).catch((e) =>
    console.error(`[releasePayments] No se pudo registrar el fallo de la fila:`, e)
  );
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

  // Fenced (ver escribirResultadoStripe): la captura que se adopta aquí
  // ya ocurrió de verdad en Stripe en una ejecución anterior — si esta
  // ejecución ya no es la propietaria (perdió el lease mientras
  // reconciliaba), no se sobrescribe al nuevo dueño.
  await escribirResultadoStripe(pago.id, pago.intentosLiberacion, datos, {
    operacion: 'adoptarCapturaHuerfana',
    stripeResultadoId: datos.stripeChargeId ?? undefined,
  });

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
  // Token capturado al reclamar (viaja en pago.intentosLiberacion desde
  // ejecutarLiberacion, nunca se relee) — es el mismo para el heartbeat
  // de abajo y para la escritura fenced del final.
  const token = pago.intentosLiberacion;

  // Heartbeat: comprueba Y renueva el lease (y la ausencia de disputa
  // bloqueante, P2 #7) justo antes de la llamada mutante a Stripe. Si
  // esta ejecución ya no es la propietaria, o hay una disputa activa,
  // aborta AQUÍ — nunca llega a llamar a capture().
  await exigirHeartbeat(pago.id, token);

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

  // Fenced: si el heartbeat de arriba pasó pero la llamada a Stripe
  // tardó lo bastante como para que OTRA ejecución reclamara el lease
  // mientras tanto (la llamada ya estaba en vuelo — un fencing de BD no
  // puede cancelarla), esta escritura no sobrescribe al nuevo
  // propietario y el resultado de Stripe se registra como huérfano.
  await escribirResultadoStripe(pago.id, token, datos, {
    operacion: 'capturarConIdempotencia',
    stripeResultadoId: chargeId,
  });

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
  const token = pago.intentosLiberacion;

  let transferId = pago.stripeTransferId ?? undefined;

  // Un intento anterior pudo crear la transferencia y morir antes de
  // guardarla. Solo se consulta a partir del segundo intento: en el
  // camino feliz no añade ninguna llamada extra a Stripe. Es una
  // lectura, no una mutación — no necesita heartbeat propio.
  if (!transferId && pago.intentosLiberacion > 1) {
    const previas = await stripe.transfers.list({ transfer_group: pago.id, limit: 1 });
    if (previas.data.length > 0) {
      transferId = previas.data[0].id;
      console.warn(`[releasePayments] Transferencia previa adoptada para el pago ${pago.id} (${transferId}).`);
    }
  }

  if (!transferId) {
    // Heartbeat: comprueba Y renueva el lease y la ausencia de disputa
    // bloqueante justo antes de la llamada mutante a Stripe — ver
    // capturarConIdempotencia para el porqué.
    await exigirHeartbeat(pago.id, token);

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

  const datos = {
    estado: 'liberado' as const,
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
  };

  // Fenced: si el heartbeat de arriba pasó pero transfers.create() tardó
  // lo bastante como para que OTRA ejecución reclamara el lease mientras
  // la llamada seguía en vuelo, esta escritura no sobrescribe al nuevo
  // propietario y el resultado (dinero YA transferido al profesional) se
  // registra como huérfano en vez de perderse en silencio.
  await escribirResultadoStripe(pago.id, token, datos, {
    operacion: 'transferirConIdempotencia',
    stripeResultadoId: transferId,
  });

  return { ...pago, ...datos } as unknown as Payment;
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
  const reclamadas = await reclamarTodoOAbortar(serviceRequestId, ESTADOS_LIBERABLES);

  try {
    const resultados = await ejecutarLiberacion(
      reclamadas.map((f) => f.id),
      serviceRequestId,
      baseFinal
    );
    return resultados;
  } catch (e) {
    await registrarFalloLiberacion(reclamadas, e);
    throw e;
  } finally {
    await liberarFilas(reclamadas).catch((e) =>
      console.error(`[releasePayments] No se pudo liberar el lease de ${serviceRequestId}:`, e)
    );
  }
}

async function ejecutarLiberacion(ids: string[], serviceRequestId: string, baseFinal: number) {
  const pagos = await prisma.payment.findMany({
    where: { id: { in: ids } },
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

  // A2 (auditoría Fable 2026-08-15): si tras recorrer TODAS las
  // autorizaciones sigue quedando base por cubrir, antes esto se
  // ignoraba en silencio — se capturaba lo que había y el profesional
  // cobraba menos de lo que precioFinal dice, sin log ni registro. Dos
  // vías reales: por_horas sin tope superior (horasReales >
  // horasEstimadas + ampliaciones autorizadas) y "cerrado" con una
  // ampliación aceptada cuya autorización nunca se confirmó (esto
  // último ya se bloquea antes de llegar aquí en completeServiceRequest,
  // pero el log queda como red de seguridad para cualquier otro camino
  // que llegue a esta función). No se aborta la liberación — el dinero
  // que SÍ hay que capturar/transferir de las autorizaciones existentes
  // sigue siendo correcto y no puede quedar retenido esperando una
  // autorización que quizá no llegue nunca.
  const deficitBase = restanteBase > 0.01 ? restanteBase : 0;
  if (deficitBase > 0) {
    console.error(
      `[ejecutarLiberacion] LIBERACION_INCOMPLETA_FALTA_AUTORIZACION serviceRequestId=${serviceRequestId} baseFinal=${baseFinal} baseSinCubrir=${deficitBase} — el profesional cobrará menos de lo que refleja precioFinal, no hay autorización suficiente para cubrir la diferencia`
    );
  }

  // ---------- FASE 1b: CONGELAR EL PLAN EN BD ANTES DE TOCAR STRIPE ----------
  //
  // Write-ahead: si el proceso muere justo después de capturar, el
  // reintento encuentra aquí con qué importes se hizo esa captura en
  // lugar de tener que adivinarlos.
  for (const paso of plan) {
    if (paso.accion !== 'capturar') continue;
    // Fenced (sin llamada a Stripe todavía en este punto — es la
    // planificación, no un resultado de Stripe, así que no hay nada que
    // registrar como huérfano si falla: simplemente esta ejecución ya no
    // es la propietaria y debe abortar ANTES de tocar Stripe).
    const { count } = await prisma.payment.updateMany({
      where: { id: paso.pago.id, intentosLiberacion: paso.pago.intentosLiberacion },
      data: {
        capturadoBase: paso.baseAConsumir,
        capturadoTotal: paso.capturadoTotal,
        capturadoProfesional: paso.capturadoProfesional,
      },
    });
    if (count === 0) throw new Error('LIBERACION_YA_EN_CURSO');
  }

  // ---------- FASE 2: EJECUTAR ----------
  const resultados = [];

  for (const paso of plan) {
    if (paso.accion === 'cancelar') {
      const tokenCancelar = paso.pago.intentosLiberacion;
      // Heartbeat antes de la llamada mutante a Stripe — ver
      // capturarConIdempotencia para el porqué.
      await exigirHeartbeat(paso.pago.id, tokenCancelar);

      const cancelado = await stripe.paymentIntents.cancel(paso.pago.stripePaymentIntentId!, undefined, {
        idempotencyKey: `cnl_${paso.pago.id}`,
      });

      const datosCancelacion = { estado: 'reembolsado' as const, liberacionEnCursoAt: null };
      // Fenced + huérfano si esta ejecución perdió la propiedad mientras
      // la llamada a Stripe estaba en vuelo.
      await escribirResultadoStripe(paso.pago.id, tokenCancelar, datosCancelacion, {
        operacion: 'ejecutarLiberacion:cancelar',
        stripeResultadoId: cancelado.id,
      });
      resultados.push({ ...paso.pago, ...datosCancelacion } as unknown as Payment);
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
 * P1 (auditoría 2026-08-14): `PAGO_NO_AUTORIZADO_TODAVIA` (ver
 * `ejecutarLiberacion` arriba) se lanza tanto si el cliente nunca llegó
 * a confirmar el Payment Sheet como si SÍ lo confirmó y esa autorización
 * ya caducó — dos situaciones distintas con el mismo mensaje genérico.
 * Esta función NO mueve nada de dinero ni decide ninguna acción: solo
 * relee el estado real en Stripe (misma llamada de solo lectura que ya
 * hace `ejecutarLiberacion`) para que el llamador pueda dar un aviso
 * correcto. 'canceled' es la señal: es el único estado terminal que
 * alcanza un PaymentIntent de captura manual que SÍ llegó a autorizarse
 * — la misma señal que ya usa `intentarRetomarPago` (payment.controller)
 * para decidir si reautorizar en vez de reanudar.
 */
export async function diagnosticarPagoSinConfirmar(
  serviceRequestId: string
): Promise<'nunca_autorizado' | 'autorizacion_caducada'> {
  const pagos = await prisma.payment.findMany({
    where: { serviceRequestId, estado: { in: [...ESTADOS_LIBERABLES] } },
  });

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) continue;
    const intent = await stripe.paymentIntents.retrieve(pago.stripePaymentIntentId);
    if (intent.status === 'canceled') return 'autorizacion_caducada';
  }

  return 'nunca_autorizado';
}

/**
 * Deshace todas las autorizaciones pendientes de una solicitud — se
 * llama al cancelarse antes de completarse, y al resolver una disputa a
 * favor del cliente.
 *
 * Distingue tres casos, porque no se deshacen igual:
 *
 * - 'retenido': el dinero nunca salió de la tarjeta. Basta con cancelar
 *   la autorización.
 * - 'capturado': el dinero YA salió (una liberación anterior capturó
 *   pero no llegó a transferir). Una autorización capturada no se puede
 *   cancelar — hay que reembolsar el cargo.
 * - 'liberado' (auditoría, hallazgo #4): el dinero salió de la tarjeta
 *   Y ya se transfirió a la cuenta Connect del profesional. Antes este
 *   caso ni se contemplaba: `refundPayment` solo miraba 'retenido'/
 *   'capturado', así que una disputa a favor del cliente sobre un
 *   trabajo YA completado y liberado lanzaba PAGO_NO_ENCONTRADO y la
 *   disputa no se podía cerrar nunca — sin ninguna vía en la app para
 *   devolver ese dinero. `reverse_transfer: true` le pide a Stripe que
 *   recupere el importe del saldo del profesional ANTES de reembolsar
 *   al cliente, en la misma llamada. Si el profesional ya no tiene
 *   saldo suficiente (lo retiró, por ejemplo), Stripe rechaza la
 *   operación — límite real de Stripe, no de este código; ese caso llega
 *   al admin como fallo explícito (ver resolveDispute) en vez de fingir
 *   que se resolvió.
 *
 * Todas las operaciones llevan clave de idempotencia determinista, así
 * que reintentar tras un timeout no cancela ni reembolsa dos veces.
 *
 * P2 (auditoría 2026-08-14): comparte el mismo lease que `releasePayments`
 * (ver `reclamarTodoOAbortar`, con ESTADOS_REEMBOLSABLES en vez de
 * ESTADOS_LIBERABLES) — antes esta función no lo respetaba en absoluto,
 * así que un reembolso y una liberación podían correr a la vez sobre la
 * misma solicitud (p. ej. `resolveDispute` a favor del cliente mientras
 * el profesional completa el trabajo, o `cancelServiceRequest` mientras
 * un job de reintento libera). Sin el lease, no había forma de saber si
 * la otra operación ya estaba tocando las mismas filas — con él, el
 * perdedor de la carrera falla ANTES de llamar a Stripe, nunca a mitad.
 * Además, "todo o nada" (ver `reclamarTodoOAbortar`) impide que
 * `refundPayment` procese solo un subconjunto de filas mientras
 * `releasePayments` tiene el resto — el bug real que dejaba el diseño
 * anterior (basado en `count` agregado, sin IDs exactos) sin cerrar.
 */
export async function refundPayment(serviceRequestId: string) {
  const reclamadas = await reclamarTodoOAbortar(serviceRequestId, ESTADOS_REEMBOLSABLES);

  try {
    await ejecutarReembolso(
      reclamadas.map((f) => f.id),
      serviceRequestId
    );
  } finally {
    await liberarFilas(reclamadas).catch((e) =>
      console.error(`[refundPayment] No se pudo liberar el lease de ${serviceRequestId}:`, e)
    );
  }
}

async function ejecutarReembolso(ids: string[], serviceRequestId: string): Promise<void> {
  const pagos = await prisma.payment.findMany({
    where: { id: { in: ids } },
  });
  if (pagos.length === 0) throw new Error('PAGO_NO_ENCONTRADO');

  for (const pago of pagos) {
    if (!pago.stripePaymentIntentId) continue;
    // Token capturado al reclamar (viaja en pago.intentosLiberacion
    // desde el findMany de arriba, nunca se relee).
    const token = pago.intentosLiberacion;

    // Heartbeat: comprueba Y renueva el lease y la ausencia de disputa
    // bloqueante justo antes de la llamada mutante a Stripe — ver
    // capturarConIdempotencia para el porqué. Una disputa activa
    // bloquea también el refund (P2 #7): Stripe ya retiró el importe
    // disputado del balance de la plataforma al abrir la disputa, así
    // que un refund manual sobre el mismo cargo mientras sigue abierta
    // arriesga reclamar/perder el mismo dinero dos veces.
    await exigirHeartbeat(pago.id, token);

    let stripeResultadoId: string | undefined;
    if (pago.estado === 'capturado' || pago.estado === 'liberado') {
      const refund = await stripe.refunds.create(
        {
          payment_intent: pago.stripePaymentIntentId,
          ...(pago.estado === 'liberado' ? { reverse_transfer: true } : {}),
          metadata: { paymentId: pago.id, serviceRequestId },
        },
        { idempotencyKey: `ref_${pago.id}` }
      );
      stripeResultadoId = refund.id;
    } else {
      const cancelado = await stripe.paymentIntents.cancel(pago.stripePaymentIntentId, undefined, {
        idempotencyKey: `cnl_${pago.id}`,
      });
      stripeResultadoId = cancelado.id;
    }

    // Fenced: si el heartbeat de arriba pasó pero la llamada a Stripe
    // tardó lo bastante como para que OTRA ejecución reclamara el lease
    // mientras tanto, esta escritura no sobrescribe al nuevo propietario
    // y el resultado (reembolso/cancelación YA confirmado en Stripe) se
    // registra como huérfano en vez de perderse en silencio.
    await escribirResultadoStripe(
      pago.id,
      token,
      { estado: 'reembolsado', liberacionEnCursoAt: null },
      { operacion: 'ejecutarReembolso', stripeResultadoId }
    );
  }
}

export interface PagoAtascado {
  paymentId: string;
  serviceRequestId: string;
  estado: string;
  estadoSolicitud: string;
  categoria: string;
  clienteNombre: string;
  // Nullable: en teoría todo Payment cuelga de una solicitud ya aceptada
  // por un profesional, pero no hay ninguna garantía en el schema de que
  // profesionalId siga presente — más seguro no asumirlo.
  profesionalNombre: string | null;
  montoProfesional: number;
  capturadoAt: Date | null;
  createdAt: Date;
  intentosLiberacion: number;
  ultimoError: string | null;
  /** El dinero ya salió de la tarjeta del cliente pero no ha llegado al profesional — máxima prioridad. */
  dineroRetenidoEnPlataforma: boolean;
  /** P2 #7: hay una disputa de Stripe bloqueante (abierta o `lost`) sobre este pago, sin importar `estado`. */
  enDisputa: boolean;
  /** Vocabulario nativo de Stripe (`needs_response`, `under_review`, `lost`...) — null si no hay disputa. */
  disputaEstado: string | null;
  disputaMonto: number | null;
  /** Para el enlace "ver en Stripe" del admin — nunca se resuelve nada desde aquí, solo dashboard.stripe.com/disputes/{id}. */
  disputaId: string | null;
}

/**
 * Cola de pagos que necesitan atención (auditoría B2, ampliada en P2 #7).
 * Tres categorías, todas invisibles antes de esto:
 *
 * - estado 'capturado': el dinero salió del cliente y NO ha llegado al
 *   profesional. Es dinero real parado en la cuenta de la plataforma.
 * - estado 'retenido' con la solicitud ya 'completada': el trabajo se
 *   dio por terminado pero la liberación nunca se completó.
 * - disputa de Stripe bloqueante (P2 #7): sin importar `estado` — un
 *   contracargo sobre un pago YA liberado es exactamente el caso que
 *   antes quedaba invisible para siempre, porque `estado` por sí solo
 *   nunca lo delataba. 'won'/'warning_closed' quedan fuera a propósito
 *   (ya resueltos, sin nada pendiente); 'lost' se queda dentro para
 *   siempre — no hay recuperación automática de esa pérdida.
 *
 * Ordenados por antigüedad: lo que más tiempo lleva atascado primero.
 */
export async function listarPagosAtascados(): Promise<PagoAtascado[]> {
  const pagos = await prisma.payment.findMany({
    where: {
      OR: [
        { estado: 'capturado' },
        { estado: 'retenido', serviceRequest: { estado: 'completada' } },
        { stripeDisputeStatus: { in: [...ESTADOS_DISPUTA_BLOQUEANTE] } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    include: {
      // Solo para identificar el pago de un vistazo en el panel de
      // admin (auditoría B2 original solo devolvía IDs) — no cambia
      // nada de la lógica de captura/liberación de abajo.
      serviceRequest: {
        select: {
          estado: true,
          categoria: { select: { nombre: true } },
          cliente: { select: { nombre: true } },
          profesional: { select: { user: { select: { nombre: true } } } },
        },
      },
    },
    take: 100,
  });

  return pagos.map((p) => ({
    paymentId: p.id,
    serviceRequestId: p.serviceRequestId,
    estado: p.estado,
    estadoSolicitud: p.serviceRequest.estado,
    categoria: p.serviceRequest.categoria.nombre,
    clienteNombre: p.serviceRequest.cliente.nombre,
    profesionalNombre: p.serviceRequest.profesional?.user.nombre ?? null,
    montoProfesional: Number(p.capturadoProfesional ?? p.montoProfesional),
    capturadoAt: p.capturadoAt,
    createdAt: p.createdAt,
    intentosLiberacion: p.intentosLiberacion,
    ultimoError: p.ultimoErrorLiberacion,
    dineroRetenidoEnPlataforma: p.estado === 'capturado',
    enDisputa: p.stripeDisputeStatus != null && (ESTADOS_DISPUTA_BLOQUEANTE as readonly string[]).includes(p.stripeDisputeStatus),
    disputaEstado: p.stripeDisputeStatus,
    disputaMonto: p.stripeDisputeMonto != null ? Number(p.stripeDisputeMonto) : null,
    disputaId: p.stripeDisputeId,
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
  // Date por el camino histórico; string ISO (con sufijo Z, generado por
  // to_char en SQL) desde la fusión de obtenerResumenPagos — res.json
  // emite exactamente los mismos bytes con ambos.
  fecha: Date | string;
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
  // Una sola consulta en vez de las 5 idas y vueltas originales
  // (professional.findUnique + payment.findMany con 3 includes to-one) —
  // mismo diagnóstico y mismo patrón LATERAL+json_agg que professionals/me
  // y assigned/mine: cada ida y vuelta a Supabase cuesta ~100ms de red, y
  // este endpoint era el más lento de todo el burst de apertura (P50 6,8s
  // bajo ráfaga de 100 usuarios, medido 2026-08-17). Los joins del
  // historial son todos to-one (payment→solicitud→categoría/cliente): sin
  // riesgo de multiplicación de filas. Numéricos dentro de JSON como
  // ::text y fechas con to_char(...Z) — las dos reglas de la revisión v3.
  const filas = await prisma.$queryRaw<
    {
      stripeAccountId: string | null;
      stripeDetailsSubmitted: boolean;
      stripeChargesEnabled: boolean;
      stripePayoutsEnabled: boolean;
      historial: { id: string; monto: string; fecha: string; categoria: string; descripcion: string; nombreCliente: string }[];
    }[]
  >`
    SELECT
      p.stripe_account_id        AS "stripeAccountId",
      p.stripe_details_submitted AS "stripeDetailsSubmitted",
      p.stripe_charges_enabled   AS "stripeChargesEnabled",
      p.stripe_payouts_enabled   AS "stripePayoutsEnabled",
      h.lista                    AS "historial"
    FROM professionals p
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object(
        'id', x.id,
        'monto', x.monto,
        'fecha', x.fecha,
        'categoria', x.categoria,
        'descripcion', x.descripcion,
        'nombreCliente', x."nombreCliente"
      ) ORDER BY x.orden DESC, x.id), '[]'::json) AS lista
      FROM (
        SELECT pay.id,
               pay.monto_profesional::text AS monto,
               to_char(pay.liberado_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fecha,
               pay.liberado_at AS orden,
               sc.nombre AS categoria,
               sr.descripcion,
               u.nombre AS "nombreCliente"
        FROM payments pay
        JOIN service_requests sr ON sr.id = pay.service_request_id
        JOIN service_categories sc ON sc.id = sr.category_id
        JOIN users u ON u.id = sr.cliente_id
        WHERE pay.estado = 'liberado' AND sr.profesional_id = p.user_id
        ORDER BY pay.liberado_at DESC, pay.id
        LIMIT 50
      ) x
    ) h ON TRUE
    WHERE p.user_id = ${userId}
  `;

  const profesional = filas[0];
  if (!profesional) throw new Error('PROFESSIONAL_NOT_FOUND');

  let estadoCuentaStripe = derivarEstadoCuentaStripe(profesional);

  let pendiente = 0;
  let disponible = 0;

  // Sin cuenta Stripe todavía (ni siquiera empezó el onboarding) no hay
  // nada que consultar — 0/0 es el estado correcto, no un error.
  if (profesional.stripeAccountId) {
    try {
      const balance = await stripe.balance.retrieve({ stripeAccount: profesional.stripeAccountId });
      pendiente = _sumarImporteEur(balance.pending);
      disponible = _sumarImporteEur(balance.available);
    } catch (err) {
      // Cuenta Connect de un modo (test/live) distinto al de la clave
      // actual — no es un fallo de Stripe, es un dato inválido en BD.
      // Se limpia y se responde 0/0 + 'pendiente' en vez de un 500, así
      // el profesional ve el botón para rehacer el onboarding.
      if (!(await invalidarCuentaStripeSiEsDeOtroModo(userId, err))) throw err;
      estadoCuentaStripe = 'pendiente';
    }
  }

  // BUG 005 (QA, 2026-08-03): el historial solo mostraba la categoría
  // ("Electricista") — con varios cobros de la misma categoría no había
  // forma de distinguir uno de otro de un vistazo. El nombre del cliente
  // (ya disponible vía la relación `cliente` de ServiceRequest, no hacía
  // falta ningún dato nuevo) es mucho más identificable que repetir la
  // categoría en cada fila.
  const historial: ResumenPagoHistorial[] = profesional.historial.map((p) => ({
    id: p.id,
    monto: Number(p.monto),
    fecha: p.fecha,
    categoria: p.categoria,
    descripcion: p.descripcion,
    nombreCliente: p.nombreCliente,
  }));

  return { estadoCuentaStripe, pendiente, disponible, moneda: 'eur', historial };
}
