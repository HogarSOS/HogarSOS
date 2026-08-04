import { Idioma } from '@prisma/client';

export { Idioma };

export type NotificationKey =
  | 'nueva_postulacion'
  | 'postulacion_aceptada'
  | 'postulacion_rechazada'
  | 'nuevo_presupuesto'
  | 'presupuesto_aceptado'
  | 'presupuesto_rechazado'
  | 'nueva_ampliacion'
  | 'ampliacion_aceptada'
  | 'ampliacion_rechazada'
  | 'nueva_solicitud'
  | 'solicitud_cancelada'
  | 'cierre_horas_pendiente'
  | 'solicitud_completada'
  | 'cierre_horas_rechazado'
  | 'cierre_horas_aceptado'
  | 'reclamacion_abierta'
  | 'pago_autorizado'
  | 'autorizacion_por_caducar'
  | 'autorizacion_caducada'
  | 'valoracion_recibida';

export interface NotificationParams {
  /** nueva_solicitud: nombre canónico (en español) de la categoría del servicio, tal cual viene de la BD — se traduce con `traducirCategoria` antes de interpolarlo. */
  categoria?: string;
  /** nueva_ampliacion: determina si el mensaje habla de horas o de importe adicional. */
  tipoAmpliacion?: 'por_horas' | 'monto';
  /** valoracion_recibida: puntuación de 1 a 5 recibida. */
  puntuacion?: number;
}

type Mensaje = { title: string; body: string };
type Constructor = (params: NotificationParams) => Mensaje;

/**
 * Traducción de nombres de categoría para la notificación
 * `nueva_solicitud` — refleja la misma lista que
 * `frontend/lib/utils/category_display.dart` (`nombreLocalizadoCategoria`).
 * Antes de esto, la notificación en inglés interpolaba el nombre
 * canónico en español tal cual (ej. "Someone needs electricista near
 * you"). Si el backend añade una categoría nueva sin actualizar esta
 * tabla, cae al nombre canónico sin traducir — no rompe el envío, solo
 * pierde precisión en ese caso concreto, igual que hace el frontend.
 */
const CATEGORIAS: Record<string, { es: string; en: string }> = {
  electricista: { es: 'electricista', en: 'an electrician' },
  fontanero: { es: 'fontanero', en: 'a plumber' },
  pintor: { es: 'pintor', en: 'a painter' },
  manitas: { es: 'manitas', en: 'a handyman' },
  limpieza: { es: 'limpieza', en: 'cleaning' },
  'limpieza del hogar': { es: 'limpieza del hogar', en: 'home cleaning' },
  jardinería: { es: 'jardinería', en: 'gardening' },
  jardineria: { es: 'jardinería', en: 'gardening' },
  cerrajería: { es: 'cerrajería', en: 'a locksmith' },
  cerrajeria: { es: 'cerrajería', en: 'a locksmith' },
  cerrajero: { es: 'cerrajería', en: 'a locksmith' },
  reformas: { es: 'reformas', en: 'renovations' },
  'aire acondicionado': { es: 'aire acondicionado', en: 'air conditioning' },
  carpintería: { es: 'carpintería', en: 'carpentry' },
  carpinteria: { es: 'carpintería', en: 'carpentry' },
  albañilería: { es: 'albañilería', en: 'masonry' },
  albanileria: { es: 'albañilería', en: 'masonry' },
  'tejados y cubiertas': { es: 'tejados y cubiertas', en: 'roofing' },
  'instalación de cristales': { es: 'instalación de cristales', en: 'glass installation' },
  'instalacion de cristales': { es: 'instalación de cristales', en: 'glass installation' },
  // Nombre anterior de esta categoría, por si queda algún dato viejo:
  cristalería: { es: 'instalación de cristales', en: 'glass installation' },
  cristaleria: { es: 'instalación de cristales', en: 'glass installation' },
  'carpintería metálica': { es: 'carpintería metálica', en: 'metalwork' },
  'carpinteria metalica': { es: 'carpintería metálica', en: 'metalwork' },
  'antenas y telecomunicaciones': { es: 'antenas y telecomunicaciones', en: 'antenna & telecom services' },
  'sistemas de seguridad': { es: 'sistemas de seguridad', en: 'security systems' },
  mudanzas: { es: 'mudanzas', en: 'moving services' },
  'limpieza de cristales': { es: 'limpieza de cristales', en: 'window cleaning' },
  piscinas: { es: 'piscinas', en: 'pool services' },
  'control de plagas': { es: 'control de plagas', en: 'pest control' },
  'pet sitter': { es: 'pet sitter', en: 'pet sitter' },
  'técnico de telefonía': { es: 'técnico de telefonía', en: 'a phone technician' },
  'tecnico de telefonia': { es: 'técnico de telefonía', en: 'a phone technician' },
  'masajes a domicilio': { es: 'masajes a domicilio', en: 'home massage' },
  'manicura y pedicura': { es: 'manicura y pedicura', en: 'manicure & pedicure' },
};

function traducirCategoria(nombreCanonico: string, idioma: Idioma): string {
  const entrada = CATEGORIAS[nombreCanonico.trim().toLowerCase()];
  if (!entrada) return nombreCanonico.toLowerCase();
  return idioma === 'en' ? entrada.en : entrada.es;
}

/**
 * Catálogo único de textos de notificaciones push, por tipo e idioma.
 * Punto central obligatorio: ningún controlador debe escribir un
 * title/body a mano (eso fue lo que dejó notificaciones siempre en
 * español sin importar el idioma del destinatario). Añadir un idioma
 * nuevo es añadir una clave más en cada entrada de este objeto.
 */
const MENSAJES: Record<NotificationKey, Record<Idioma, Constructor>> = {
  nueva_postulacion: {
    es: () => ({ title: 'Nuevo profesional interesado', body: 'Un profesional se ha postulado a tu solicitud' }),
    en: () => ({ title: 'New professional interested', body: 'A professional has applied to your request' }),
  },
  postulacion_aceptada: {
    es: () => ({ title: '¡Te han elegido!', body: 'El cliente ha seleccionado tu candidatura' }),
    en: () => ({ title: "You've been selected!", body: 'The client has selected your application' }),
  },
  postulacion_rechazada: {
    es: () => ({
      title: 'Selección finalizada',
      body: 'El cliente ha seleccionado a otro profesional. Gracias por tu interés.',
    }),
    en: () => ({
      title: 'Selection completed',
      body: 'The client has selected another professional. Thanks for your interest.',
    }),
  },
  nuevo_presupuesto: {
    es: () => ({ title: 'Presupuesto recibido', body: 'El profesional te ha enviado un presupuesto' }),
    en: () => ({ title: 'Budget received', body: 'The professional has sent you a budget' }),
  },
  presupuesto_aceptado: {
    es: () => ({
      title: '¡Presupuesto aceptado!',
      body: 'El cliente ha aceptado tu presupuesto — ya puede autorizar el pago',
    }),
    en: () => ({
      title: 'Budget accepted!',
      body: 'The client has accepted your budget — they can now authorize payment',
    }),
  },
  presupuesto_rechazado: {
    es: () => ({ title: 'Presupuesto rechazado', body: 'El cliente ha rechazado tu presupuesto. Puedes enviar uno nuevo.' }),
    en: () => ({ title: 'Budget rejected', body: 'The client has rejected your budget. You can send a new one.' }),
  },
  nueva_ampliacion: {
    es: ({ tipoAmpliacion }) =>
      tipoAmpliacion === 'monto'
        ? {
            title: 'El profesional necesita un presupuesto adicional',
            body: 'Ha pedido ampliar el presupuesto del trabajo — revísalo para aceptar o rechazar',
          }
        : {
            title: 'El profesional necesita más tiempo',
            body: 'Ha pedido ampliar las horas del trabajo — revísalo para aceptar o rechazar',
          },
    en: ({ tipoAmpliacion }) =>
      tipoAmpliacion === 'monto'
        ? {
            title: 'The professional needs an additional budget',
            body: "They've requested to extend the job's budget — review it to accept or reject",
          }
        : {
            title: 'The professional needs more time',
            body: "They've requested to extend the job's hours — review it to accept or reject",
          },
  },
  ampliacion_aceptada: {
    es: () => ({
      title: '¡Ampliación aceptada!',
      body: 'El cliente ha aceptado tu petición de ampliación — te avisaremos cuando autorice el pago adicional',
    }),
    en: () => ({
      title: 'Extension accepted!',
      body: "The client has accepted your extension request — we'll let you know once the additional payment is authorized",
    }),
  },
  ampliacion_rechazada: {
    es: () => ({ title: 'Ampliación rechazada', body: 'El cliente ha rechazado tu petición de ampliación' }),
    en: () => ({ title: 'Extension rejected', body: 'The client has rejected your extension request' }),
  },
  nueva_solicitud: {
    es: ({ categoria }) => ({
      title: 'Nueva solicitud cerca de ti',
      body: `Alguien necesita ${traducirCategoria(categoria ?? '', 'es')} cerca de tu ubicación`,
    }),
    en: ({ categoria }) => ({
      title: 'New request near you',
      body: `Someone needs ${traducirCategoria(categoria ?? '', 'en')} near your location`,
    }),
  },
  solicitud_cancelada: {
    es: () => ({ title: 'Solicitud cancelada', body: 'El cliente ha cancelado un trabajo que tenías asignado' }),
    en: () => ({ title: 'Request cancelled', body: 'The client has cancelled a job that was assigned to you' }),
  },
  cierre_horas_pendiente: {
    es: () => ({ title: 'El profesional ha terminado el trabajo', body: 'Confirma las horas trabajadas para liberar el pago' }),
    en: () => ({ title: 'The professional has finished the job', body: 'Confirm the hours worked to release payment' }),
  },
  solicitud_completada: {
    es: () => ({ title: 'Servicio completado', body: '¿Qué tal fue? Cuéntaselo a otros valorando al profesional' }),
    en: () => ({ title: 'Service completed', body: 'How did it go? Let others know by rating the professional' }),
  },
  cierre_horas_rechazado: {
    es: () => ({
      title: 'El cliente no está de acuerdo con las horas',
      body: 'Habladlo por chat, o el cliente puede abrir una reclamación si no llegáis a un acuerdo',
    }),
    en: () => ({
      title: 'The client disagrees with the hours',
      body: "Talk it over in chat, or the client can open a dispute if you can't reach an agreement",
    }),
  },
  cierre_horas_aceptado: {
    es: () => ({ title: 'Horas confirmadas', body: 'El cliente ha confirmado las horas trabajadas — el pago ya se ha liberado' }),
    en: () => ({ title: 'Hours confirmed', body: 'The client has confirmed the hours worked — payment has been released' }),
  },
  reclamacion_abierta: {
    es: () => ({
      title: 'Reclamación abierta',
      body: 'Se ha abierto una reclamación sobre un trabajo — nuestro equipo lo está revisando',
    }),
    en: () => ({
      title: 'Dispute opened',
      body: 'A dispute has been opened on a job — our team is reviewing it',
    }),
  },
  pago_autorizado: {
    es: () => ({
      title: 'Pago autorizado',
      body: 'El cliente ha autorizado el pago — el importe queda retenido hasta completar el trabajo',
    }),
    en: () => ({
      title: 'Payment authorized',
      body: "The client has authorized the payment — the amount is held until the job is completed",
    }),
  },
  // B5: Stripe solo mantiene un cargo autorizado sin capturar unos 7
  // días. Estos dos avisos van a AMBAS partes: el cliente es quien debe
  // volver a autorizar, pero el profesional necesita saberlo porque su
  // cobro depende de ello.
  autorizacion_por_caducar: {
    es: () => ({
      title: 'El pago retenido caduca pronto',
      body: 'La autorización de este servicio caduca en unos días. Si el trabajo ya está hecho, ciérralo; si no, habrá que volver a autorizar el pago.',
    }),
    en: () => ({
      title: 'Held payment expires soon',
      body: 'The authorisation for this service expires in a few days. If the job is done, close it; otherwise the payment will need authorising again.',
    }),
  },
  autorizacion_caducada: {
    es: () => ({
      title: 'La autorización de pago ha caducado',
      body: 'El importe retenido se ha liberado en la tarjeta del cliente. Para continuar con este servicio hay que autorizar el pago de nuevo.',
    }),
    en: () => ({
      title: 'Payment authorisation expired',
      body: "The held amount has been released back to the client's card. To continue with this service, the payment must be authorised again.",
    }),
  },
  valoracion_recibida: {
    es: ({ puntuacion }) => ({ title: 'Nueva valoración', body: `Has recibido una valoración de ${puntuacion ?? '?'} estrellas` }),
    en: ({ puntuacion }) => ({ title: 'New rating', body: `You've received a ${puntuacion ?? '?'}-star rating` }),
  },
};

/**
 * Traduce un tipo de notificación al idioma del destinatario. Si por
 * lo que sea faltara una entrada para ese idioma (no debería, Idioma
 * es un enum cerrado con los dos ya cubiertos arriba), cae a español
 * antes que lanzar — perder la traducción es mucho menos grave que
 * perder la notificación entera.
 */
export function construirNotificacion(tipo: NotificationKey, idioma: Idioma, params: NotificationParams = {}): Mensaje {
  const porIdioma = MENSAJES[tipo];
  const constructor = porIdioma[idioma] ?? porIdioma.es;
  return constructor(params);
}
