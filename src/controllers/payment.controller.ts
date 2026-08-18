import { Request, Response } from 'express';
import { z } from 'zod';
import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import {
  createEscrowPaymentIntent,
  reautorizarPaymentIntent,
  obtenerResumenPagos,
  obtenerOCrearStripeCustomerId,
  crearEphemeralKey,
  COMISION_CLIENTE_PORCENTAJE,
  COMISION_PROFESIONAL_PORCENTAJE,
} from '../services/payment.service';
import { Payment } from '@prisma/client';
import { enviarNotificacion } from '../services/notification.service';
import { enviarEmail } from '../services/email.service';
import { sincronizarEstadoCuentaStripe } from '../services/professional.service';

const createIntentSchema = z.object({
  serviceRequestId: z.string().uuid(),
});

/**
 * `payment.service.createEscrowPaymentIntent` crea la fila Payment (con
 * estado 'pendiente', no 'retenido' — ver el enum EstadoPago) en el mismo
 * momento en que se crea el PaymentIntent en Stripe — ANTES de que el
 * cliente confirme nada con el Payment Sheet. Si esa confirmación nunca
 * llega a completarse (el SDK de Stripe falla al inicializarse, el
 * usuario cierra la app, se cae la conexión a mitad...) la fila se queda
 * en 'pendiente' (o pasa a 'fallido'/'reembolsado' vía webhook) y no
 * bloquea ningún reintento — pero, antes de tratar un pago existente
 * como bloqueante, igualmente se comprueba su estado real en Stripe: si
 * nunca llegó a confirmarse (o se canceló), se deja reintentar
 * reutilizando el mismo PaymentIntent en vez de crear uno nuevo.
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
 * espera. `canceled` NO está aquí (auditoría B5): es un estado terminal
 * en Stripe, reconfirmar ese mismo PaymentIntent falla siempre — ver
 * `intentarRetomarPago`, que lo trata como reautorización, no como
 * reintento.
 */
const ESTADOS_STRIPE_REANUDABLES = new Set([
  'requires_payment_method',
  'requires_action',
  'requires_confirmation',
]);

/**
 * Decide qué hacer con una autorización existente cuando el cliente
 * vuelve a pulsar "pagar": retomarla tal cual si Stripe la considera
 * reanudable, reautorizarla desde cero (B5) si Stripe ya la canceló por
 * caducidad, o no hacer nada (null) si sigue viva/ya confirmada — en ese
 * caso el llamador sigue su lógica normal (buscar ampliación pendiente o
 * devolver 409).
 */
async function intentarRetomarPago(pago: Payment, clienteStripeCustomerId: string) {
  if (!pago.stripePaymentIntentId) return null;
  const paymentIntent = await stripe.paymentIntents.retrieve(pago.stripePaymentIntentId);

  if (ESTADOS_STRIPE_REANUDABLES.has(paymentIntent.status)) {
    return {
      paymentId: pago.id,
      clientSecret: paymentIntent.client_secret,
      montoBase: Number(pago.montoBase),
      montoTotal: Number(pago.montoTotal),
      comisionPlataforma: Number(pago.comisionPlataforma),
      customerId: clienteStripeCustomerId,
      ephemeralKeySecret: await crearEphemeralKey(clienteStripeCustomerId),
    };
  }

  if (paymentIntent.status === 'canceled') {
    const { pago: pagoReautorizado, clientSecret, customerId, ephemeralKeySecret } =
      await reautorizarPaymentIntent(pago, clienteStripeCustomerId);
    return {
      paymentId: pagoReautorizado.id,
      clientSecret,
      montoBase: Number(pagoReautorizado.montoBase),
      montoTotal: Number(pagoReautorizado.montoTotal),
      comisionPlataforma: Number(pagoReautorizado.comisionPlataforma),
      customerId,
      ephemeralKeySecret,
    };
  }

  return null;
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
    const reintentoInicial = await intentarRetomarPago(pagoInicial, stripeCustomerId);
    if (reintentoInicial) {
      return res.status(201).json(reintentoInicial);
    }

    const ampliacionSinAutorizar = presupuesto.ampliaciones.find(
      (a) => !solicitud.pagos.some((p) => p.ampliacionId === a.id)
    );
    if (!ampliacionSinAutorizar) {
      const ultimoPagoAmpliacion = [...solicitud.pagos].reverse().find((p) => p.ampliacionId);
      const reintentoAmpliacion = ultimoPagoAmpliacion
        ? await intentarRetomarPago(ultimoPagoAmpliacion, stripeCustomerId)
        : null;
      if (reintentoAmpliacion) {
        return res.status(201).json(reintentoAmpliacion);
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

/** Resultado de intentar aplicar un evento charge.dispute.* — ver procesarEventoDisputa. */
type ResultadoEventoDisputa = 'aplicado' | 'duplicado' | 'payment_no_encontrado';

/**
 * Revisión adversarial final (Hallazgo 2): cuando el evento no se puede
 * asociar a ningún Payment, no hay ninguna fila donde guardar "ya se
 * avisó de este evento" — a diferencia del camino 'aplicado', que se
 * apoya en stripeDisputeUltimoEventoId. Sin este Set, cada redelivery
 * de Stripe del mismo webhook (reintento tras timeout, red caída, etc.)
 * duplicaría el correo a soporte. Un Set en memoria (no una tabla) es
 * suficiente: el volumen de contracargos reales es bajísimo, así que no
 * hay riesgo práctico de crecimiento descontrolado, y no sobrevivir a
 * un reinicio del proceso solo implica, en el peor caso, un correo
 * repetido tras un despliegue — no una alerta perdida.
 */
const eventosSinPaymentYaAlertados = new Set<string>();

/**
 * P2 #7: procesa cualquier evento charge.dispute.* (created/updated/closed)
 * — misma función para los tres, la única diferencia entre ellos es qué
 * aviso adicional dispara cada caso del switch. Escritura idempotente y
 * segura ante desorden de entrega: solo se aplica si `event.created` es
 * más reciente que el último evento de disputa ya aplicado a esta fila
 * (o si es el primero).
 *
 * Revisión adversarial final: `event.created` de Stripe solo tiene
 * precisión de SEGUNDO — dos eventos DISTINTOS (ej. `.created` seguido
 * casi al instante de un `.updated`) pueden compartir el mismo segundo.
 * Comparar solo por `event.created` con `<` descartaba el segundo evento
 * como si fuera un duplicado del primero, aunque trajera información
 * nueva. El desempate real es `event.id` (identidad del evento de
 * Stripe, no de la disputa): se aplica si el evento entrante es más
 * reciente, O si comparte segundo con el último aplicado pero es un
 * `event.id` DISTINTO — solo una redelivery EXACTA del mismo evento
 * (mismo segundo + mismo id) se ignora.
 *
 * Devuelve 'aplicado'/'duplicado'/'payment_no_encontrado' en vez de un
 * booleano: un `count:0` puede significar dos cosas muy distintas que
 * un simple `true/false` colapsaba — "ya se aplicó este mismo evento
 * antes" (correcto callar) o "no hay ningún Payment con ese
 * payment_intent" (un fallo de reconciliación real que el llamador
 * debe alertar, no silenciar).
 */
async function procesarEventoDisputa(
  event: { id: string; created: number },
  disputa: { id: string; status: string; amount: number; payment_intent?: string }
): Promise<ResultadoEventoDisputa> {
  if (!disputa.payment_intent) return 'payment_no_encontrado';

  const eventoEn = new Date(event.created * 1000);
  const montoNumerico = Number((disputa.amount / 100).toFixed(2));

  const { count } = await prisma.payment.updateMany({
    where: {
      stripePaymentIntentId: disputa.payment_intent,
      OR: [
        { stripeDisputeUltimoEventoEn: null },
        { stripeDisputeUltimoEventoEn: { lt: eventoEn } },
        {
          stripeDisputeUltimoEventoEn: eventoEn,
          OR: [{ stripeDisputeUltimoEventoId: null }, { stripeDisputeUltimoEventoId: { not: event.id } }],
        },
      ],
    },
    data: {
      stripeDisputeId: disputa.id,
      stripeDisputeStatus: disputa.status,
      stripeDisputeMonto: montoNumerico,
      stripeDisputeUltimoEventoEn: eventoEn,
      stripeDisputeUltimoEventoId: event.id,
    },
  });
  if (count > 0) return 'aplicado';

  // count===0: o es un duplicado genuino de un evento ya aplicado, o no
  // existe ningún Payment con ese payment_intent en absoluto — una
  // lectura de más, solo en el camino de fallo, distingue cuál de los
  // dos fue (mismo patrón que heartbeat() distingue lease_perdido de
  // disputa_activa).
  const existe = await prisma.payment.findFirst({
    where: { stripePaymentIntentId: disputa.payment_intent },
    select: { id: true },
  });
  return existe ? 'duplicado' : 'payment_no_encontrado';
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
      (process.env.STRIPE_WEBHOOK_SECRET as string).trim()
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
      // Solo esta transición representa que Stripe confirmó de verdad la
      // autorización — ver comentario del enum EstadoPago en el schema.
      // Desde 'pendiente' (camino normal) O desde 'fallido': si un
      // intento anterior del MISMO PaymentIntent fue rechazado (el
      // webhook payment_failed marcó 'fallido') y el cliente reintenta
      // en el mismo Payment Sheet con una tarjeta buena, la
      // autorización real llega con la fila en 'fallido' — sin ese
      // estado aquí, la fila quedaba 'fallido' para siempre con el
      // dinero retenido de verdad en Stripe.
      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: intent.id, estado: { in: ['pendiente', 'fallido'] } },
        data: { estado: 'retenido' },
      });
      // La notificación se reclama con su PROPIO marcador, no con el
      // count del cambio de estado de arriba: si el proceso muere entre
      // el UPDATE y el envío, el reintento del webhook de Stripe ve el
      // estado ya cambiado (count 0) pero el marcador todavía vacío, y
      // recupera la notificación perdida. El marcador guarda el id del
      // intent (ver schema): una redelivery del mismo intent no vuelve a
      // notificar, pero la reautorización B5 (intent NUEVO en la misma
      // fila) sí. El updateMany es atómico — con dos procesos backend
      // procesando el mismo evento a la vez, solo uno consigue count 1.
      const claim = await prisma.payment.updateMany({
        where: {
          stripePaymentIntentId: intent.id,
          estado: 'retenido',
          OR: [{ notifAutorizadaPiId: null }, { notifAutorizadaPiId: { not: intent.id } }],
        },
        data: { notifAutorizadaPiId: intent.id },
      });
      if (claim.count > 0) {
        const pago = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: intent.id },
          include: { serviceRequest: { select: { clienteId: true, profesionalId: true } } },
        });
        if (pago) {
          // Ambas partes, cada una con su mensaje: el profesional sabe
          // que puede empezar (pago_autorizado), y el cliente recibe la
          // confirmación de que su dinero quedó retenido de verdad —
          // crítico cuando el 3DS del banco le sacó de la app y el
          // Payment Sheet nunca llegó a devolverle el resultado.
          if (pago.serviceRequest.profesionalId) {
            enviarNotificacion(pago.serviceRequest.profesionalId, 'pago_autorizado', {}, {
              solicitudId: pago.serviceRequestId,
            }).catch((e) => console.error(`[stripeWebhook] Error al notificar pago autorizado de ${pago.id}:`, e));
          }
          enviarNotificacion(pago.serviceRequest.clienteId, 'pago_confirmado', {}, {
            solicitudId: pago.serviceRequestId,
          }).catch((e) => console.error(`[stripeWebhook] Error al notificar pago confirmado de ${pago.id}:`, e));
        }
      }
      break;
    }
    // `estado: { in: ['pendiente', 'retenido'] }` en el `where` de los dos
    // casos de abajo (auditoría, hallazgo #6, ampliado al añadir el
    // estado 'pendiente'): Stripe no garantiza el orden de entrega de los
    // webhooks. Sin esta precondición, un evento antiguo o reintentado
    // que llega DESPUÉS de que releasePayments ya capturó o liberó esta
    // misma autorización podía degradarla a 'fallido' o 'reembolsado' —
    // dejando un pago ya cobrado y transferido marcado como si nunca
    // hubiera ocurrido. 'pendiente' se incluye porque un intento puede
    // fallar o cancelarse ANTES de llegar a confirmarse ('retenido').
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as { id: string };
      // Inmunidad al desorden de entrega: un payment_failed de un
      // intento ANTERIOR puede llegar DESPUÉS del
      // amount_capturable_updated del reintento bueno del mismo
      // PaymentIntent — sin esta releída, degradaba 'retenido' a
      // 'fallido' con la autorización viva en Stripe (dinero retenido
      // invisible: releasePayments nunca capturaría). El estado vivo en
      // Stripe es la única fuente inmune al orden: si el intent ya no
      // está fallado de verdad, este evento es obsoleto y se ignora. Si
      // la releída falla (red), se responde 500 a propósito para que
      // Stripe reintente el webhook más tarde en vez de decidir a ciegas.
      let estadoVivo: string;
      try {
        estadoVivo = (await stripe.paymentIntents.retrieve(intent.id)).status;
      } catch (e) {
        console.error(`[stripeWebhook] No se pudo releer ${intent.id} para payment_failed:`, (e as Error).message);
        return res.status(500).json({ error: 'Reintento requerido' });
      }
      if (estadoVivo === 'requires_capture' || estadoVivo === 'succeeded' || estadoVivo === 'processing') {
        break; // evento obsoleto: la autorización real ganó después
      }
      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: intent.id, estado: { in: ['pendiente', 'retenido'] } },
        data: { estado: 'fallido' },
      });
      // Sin notificación push a propósito: un fallo de pago es casi
      // siempre síncrono (el cliente está mirando el Payment Sheet, que
      // ya le muestra el error del banco) — un push encima sería ruido
      // alarmante durante su propio reintento. El estado queda
      // consistente en BD y la pantalla de la solicitud lo refleja.
      break;
    }
    case 'payment_intent.canceled': {
      const intent = event.data.object as { id: string; cancellation_reason?: string | null };
      const { count } = await prisma.payment.updateMany({
        where: { stripePaymentIntentId: intent.id, estado: { in: ['pendiente', 'retenido'] } },
        data: { estado: 'reembolsado' },
      });
      // Caducidad real de la autorización (cancellation_reason la pone
      // Stripe: 'expired'; 'automatic' por robustez). Antes este evento
      // era SILENCIOSO y el aviso del job autorizacionesPorCaducar casi
      // nunca llegaba a dispararse: el webhook gana la carrera, marca
      // 'reembolsado' y el filtro estado:'retenido' del job excluye la
      // fila — trabajo hecho, autorización perdida y nadie enterado.
      // Nuestras propias cancelaciones (cancelar solicitud, resolver
      // disputa) llegan sin cancellation_reason y siguen en silencio:
      // esos flujos ya avisan por su cuenta con su propio contexto.
      // Idempotente por el count de la transición: la redelivery del
      // mismo evento encuentra la fila ya en 'reembolsado' (count 0).
      const esCaducidad = intent.cancellation_reason === 'expired' || intent.cancellation_reason === 'automatic';
      if (count > 0 && esCaducidad) {
        const pago = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: intent.id },
          include: { serviceRequest: { select: { clienteId: true, profesionalId: true } } },
        });
        if (pago) {
          const destinatarios = [pago.serviceRequest.clienteId, pago.serviceRequest.profesionalId]
            .filter((id): id is string => Boolean(id));
          for (const userId of destinatarios) {
            enviarNotificacion(userId, 'autorizacion_caducada', {}, {
              solicitudId: pago.serviceRequestId,
            }).catch((e) => console.error(`[stripeWebhook] Error al notificar caducidad de ${pago.id} a ${userId}:`, e));
          }
        }
      }
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
     * íntegramente del bolsillo de HogarSOS — y con una comisión del 10%,
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
        status: string;
        reason?: string;
        payment_intent?: string;
        evidence_details?: { due_by?: number };
      };

      const resultado = await procesarEventoDisputa(event, disputa).catch((e) => {
        console.error(`[stripeWebhook] No se pudo registrar la disputa ${disputa.id}:`, e);
        return 'duplicado' as ResultadoEventoDisputa; // fallo inesperado: no reintentar el aviso a ciegas
      });

      // Evento repetido (reintento de Stripe del mismo webhook) o
      // atrasado: ya se aplicó antes, no hay nada nuevo que avisar —
      // evita reenviar el correo a soporte en cada reintento.
      if (resultado === 'duplicado') break;

      // Revisión adversarial final: un contracargo real cuyo
      // payment_intent no coincide con NINGÚN Payment (webhook mal
      // configurado, cuenta de Stripe equivocada, metadata corrupta, o
      // directamente sin payment_intent en el evento) es precisamente
      // el fallo de reconciliación financiera que este endpoint existe
      // para no dejar pasar en silencio — nunca se debe tratar igual
      // que un duplicado.
      if (resultado === 'payment_no_encontrado') {
        // Redelivery exacta del mismo evento (mismo event.id): ya se
        // avisó de este fallo de reconciliación, no hay Payment donde
        // apoyarse para deducirlo — ver comentario de
        // eventosSinPaymentYaAlertados arriba.
        if (eventosSinPaymentYaAlertados.has(event.id)) break;
        eventosSinPaymentYaAlertados.add(event.id);

        console.error(
          `[stripeWebhook] ⚠️ CONTRACARGO ${disputa.id} SIN Payment local asociado ` +
          `(PaymentIntent: ${disputa.payment_intent ?? 'no incluido en el evento'}). ` +
          `Fallo de reconciliación financiera — revisar manualmente en el dashboard de Stripe.`
        );
        const destinatarioSinAsociar = process.env.SMTP_USER;
        if (destinatarioSinAsociar) {
          enviarEmail(
            destinatarioSinAsociar,
            `⚠️ Contracargo de Stripe SIN pago asociado en Hogar SOS`,
            `<p>Se ha abierto un contracargo en Stripe que no se pudo asociar a ningún pago registrado en Hogar SOS.</p>
             <ul>
               <li><strong>Dispute ID:</strong> ${disputa.id}</li>
               <li><strong>PaymentIntent:</strong> ${disputa.payment_intent ?? 'no incluido en el evento'}</li>
             </ul>
             <p>Esto es un fallo de reconciliación, no un contracargo ya gestionado — revisar manualmente
                desde el dashboard de Stripe → Payments → Disputes.</p>`
          ).catch((e) => console.error(`[stripeWebhook] No se pudo avisar por correo del contracargo sin asociar ${disputa.id}:`, e));
        } else {
          console.error('[stripeWebhook] SMTP_USER sin definir: el aviso de contracargo sin asociar solo queda en el log.');
        }
        break;
      }

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
              Si no se responde antes del plazo, la disputa se pierde automáticamente. Mientras la
              disputa siga abierta, HogarSOS no capturará, transferirá ni reembolsará este pago
              automáticamente.</p>
           <p>Responder desde el dashboard de Stripe → Payments → Disputes.</p>`
        ).catch((e) => console.error(`[stripeWebhook] No se pudo avisar por correo del contracargo ${disputa.id}:`, e));
      } else {
        console.error('[stripeWebhook] SMTP_USER sin definir: el aviso de contracargo solo queda en el log.');
      }
      break;
    }

    // Cambios de estado mientras la disputa sigue abierta (evidencia
    // enviada, pasa a revisión, etc.) — solo actualiza el registro, sin
    // aviso propio: no es tan accionable como la apertura o el cierre,
    // y un correo por cada cambio intermedio generaría ruido.
    case 'charge.dispute.updated': {
      const disputa = event.data.object as { id: string; amount: number; status: string; payment_intent?: string };
      // Alcance de esta ronda: solo se corrige el aviso de .created (ver
      // arriba). .updated nunca tuvo aviso propio (cambios intermedios,
      // no accionables) — se mantiene así, solo se adapta al tipo de
      // retorno nuevo.
      await procesarEventoDisputa(event, disputa).catch((e) =>
        console.error(`[stripeWebhook] No se pudo actualizar la disputa ${disputa.id}:`, e)
      );
      break;
    }

    // Resultado final: 'won' (Stripe devuelve el importe retirado,
    // libera el bloqueo de movimientos), 'lost' (el dinero se pierde de
    // forma permanente, sigue bloqueado, requiere revisión manual) o
    // 'warning_closed' (una consulta que nunca llegó a retirar fondos
    // se cerró sin escalar, libera el bloqueo). Ver ESTADOS_DISPUTA_BLOQUEANTE
    // en payment.service.ts para qué estados siguen bloqueando después de esto.
    case 'charge.dispute.closed': {
      const disputa = event.data.object as { id: string; amount: number; currency: string; status: string; payment_intent?: string };

      // Mismo alcance que .updated: esta ronda solo corrige el aviso de
      // .created — aquí solo se adapta al tipo de retorno nuevo, sin
      // añadir el aviso específico de "sin Payment asociado" (fuera de
      // lo pedido para .closed).
      const resultadoCierre = await procesarEventoDisputa(event, disputa).catch((e) => {
        console.error(`[stripeWebhook] No se pudo cerrar la disputa ${disputa.id}:`, e);
        return 'duplicado' as ResultadoEventoDisputa;
      });
      if (resultadoCierre !== 'aplicado') break;

      const importe = (disputa.amount / 100).toFixed(2);
      const resultado = disputa.status === 'won' ? 'GANADA' : disputa.status === 'lost' ? 'PERDIDA' : disputa.status.toUpperCase();
      console.error(`[stripeWebhook] Disputa ${disputa.id} cerrada: ${resultado} (${importe} ${disputa.currency.toUpperCase()}).`);

      const destinatarioCierre = process.env.SMTP_USER;
      if (destinatarioCierre) {
        enviarEmail(
          destinatarioCierre,
          `Disputa ${resultado.toLowerCase()} — ${importe} € en Hogar SOS`,
          `<p>La disputa ${disputa.id} se ha cerrado: <strong>${resultado}</strong>.</p>
           <ul><li><strong>Importe:</strong> ${importe} ${disputa.currency.toUpperCase()}</li></ul>
           ${resultado === 'PERDIDA'
             ? '<p>El importe queda perdido de forma permanente — no hay recuperación automática de fondos. Requiere revisión manual (posible seguimiento con el profesional).</p>'
             : '<p>Sin acción pendiente — Stripe gestiona la devolución del importe retirado automáticamente.</p>'}`
        ).catch((e) => console.error(`[stripeWebhook] No se pudo avisar por correo del cierre de la disputa ${disputa.id}:`, e));
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
