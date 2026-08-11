import admin from 'firebase-admin';
import { prisma } from '../config/prisma';
import { construirNotificacion, Idioma, NotificationKey, NotificationParams } from '../i18n/notifications';

/**
 * Envío de notificaciones push vía FCM. Aísla el resto del backend de
 * los detalles de firebase-admin — si mañana cambia el proveedor
 * (OneSignal, etc.), solo hay que tocar este archivo.
 *
 * Deliberadamente "fire and forget" con captura de errores: un fallo
 * al enviar una notificación (token caducado, sin conexión del
 * destinatario, etc.) nunca debe tumbar la operación real que la
 * disparó (crear una solicitud, aceptarla...). Si el token resulta
 * inválido, se limpia de la BD para no reintentar contra él en el
 * futuro.
 */
async function despachar(
  userId: string,
  construirMensaje: (idioma: Idioma) => { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  try {
    const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { fcmToken: true, idioma: true } });
    if (!usuario?.fcmToken) return;

    await admin.messaging().send({
      token: usuario.fcmToken,
      notification: construirMensaje(usuario.idioma),
      apns: { payload: { aps: { sound: 'default' } } },
      data,
    });
  } catch (e: any) {
    console.error(`[notification.service] Error al notificar a ${userId}:`, e?.message ?? e);

    const codigosTokenInvalido = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];
    if (codigosTokenInvalido.includes(e?.code)) {
      await prisma.user.update({ where: { id: userId }, data: { fcmToken: null } }).catch(() => {});
    }
  }
}

/**
 * Envía una notificación de catálogo (ver `i18n/notifications.ts`) en
 * el idioma guardado del destinatario (`users.idioma`, actualizado por
 * el propio dispositivo — ver `PATCH /auth/me/idioma`). Este es el
 * único punto por el que debe pasar cualquier notificación con texto
 * traducible: ningún controlador debe construir un title/body a mano,
 * porque eso es justo lo que dejaba las notificaciones siempre en
 * español sin importar el idioma de quien las recibe.
 */
export async function enviarNotificacion(
  userId: string,
  tipo: NotificationKey,
  params: NotificationParams = {},
  data?: Record<string, string>
): Promise<void> {
  return despachar(userId, (idioma) => construirNotificacion(tipo, idioma, params), { tipo, ...data });
}

/**
 * Notifica a varios usuarios en paralelo (ej. todos los profesionales
 * cercanos a una solicitud nueva) — cada uno en su propio idioma. Cada
 * envío falla de forma aislada, un token inválido no cancela el resto.
 */
export async function enviarNotificacionMasiva(
  userIds: string[],
  tipo: NotificationKey,
  params: NotificationParams = {},
  data?: Record<string, string>
): Promise<void> {
  await Promise.all(userIds.map((id) => enviarNotificacion(id, tipo, params, data)));
}

/**
 * Variante "cruda" para el único caso donde title/body no es un
 * mensaje de catálogo traducible: el chat, donde el título es el
 * nombre de quien escribe y el cuerpo es texto libre del usuario — no
 * hay nada que localizar porque no es texto de la app.
 */
export async function enviarNotificacionCruda(
  userId: string,
  notification: { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  return despachar(userId, () => notification, data);
}
