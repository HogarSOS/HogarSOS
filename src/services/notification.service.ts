import admin from 'firebase-admin';
import { prisma } from '../config/prisma';

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
export async function enviarNotificacion(
  userId: string,
  notification: { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  try {
    const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { fcmToken: true } });
    if (!usuario?.fcmToken) return;

    await admin.messaging().send({
      token: usuario.fcmToken,
      notification,
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
 * Notifica a varios usuarios en paralelo (ej. todos los profesionales
 * cercanos a una solicitud nueva). Cada envío falla de forma aislada —
 * un token inválido no cancela el resto.
 */
export async function enviarNotificacionMasiva(
  userIds: string[],
  notification: { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  await Promise.all(userIds.map((id) => enviarNotificacion(id, notification, data)));
}
