import { stripe } from '../config/stripe';
import { prisma } from '../config/prisma';
import { Professional } from '@prisma/client';

export type EstadoCuentaStripe = 'configurada' | 'pendiente' | 'requiere_actualizacion';

/**
 * Deriva el estado visible al usuario a partir de los 3 flags que
 * Stripe reporta para una cuenta Connect. `stripeAccountId` nulo (nunca
 * empezó el onboarding) también cuenta como 'pendiente'.
 *
 * - pendiente: no ha terminado el onboarding todavía.
 * - requiere_actualizacion: terminó el onboarding pero Stripe no puede
 *   cobrar/pagarle todavía (verificación de identidad pendiente, pidió
 *   más documentación, etc.) — el profesional tiene que volver a Stripe.
 * - configurada: puede cobrar y recibir transferencias.
 */
export function derivarEstadoCuentaStripe(profesional: Pick<Professional, 'stripeAccountId' | 'stripeDetailsSubmitted' | 'stripeChargesEnabled' | 'stripePayoutsEnabled'>): EstadoCuentaStripe {
  if (!profesional.stripeAccountId || !profesional.stripeDetailsSubmitted) return 'pendiente';
  if (!profesional.stripeChargesEnabled || !profesional.stripePayoutsEnabled) return 'requiere_actualizacion';
  return 'configurada';
}

/**
 * Aprobación semiautomática (roadmap económico, punto 8): si el
 * profesional sigue "pendiente" y ya cumple todo lo que HogarSOS
 * comprueba automáticamente, se aprueba sin esperar a un admin. Si algo
 * falta, no hace nada — se queda "pendiente" y sigue apareciendo en la
 * cola de revisión manual (`GET /admin/professionals/pending`) tal cual
 * ya funcionaba, sin ningún cambio ahí.
 *
 * Los 5 puntos del roadmap se comprueban así:
 * - "Perfil completo" + "Foto de perfil" + "Categoría seleccionada" →
 *   `fotoPerfilUrl` + al menos una fila en `professional_categories`.
 * - "Cuenta Stripe correctamente configurada" + "Identidad validada por
 *   Stripe" → un único check, `derivarEstadoCuentaStripe === 'configurada'`:
 *   con el modelo de onboarding Express que usa este proyecto, Stripe no
 *   habilita charges/payouts hasta haber validado la identidad, así que
 *   no hay una señal separada de "identidad" que consultar aparte.
 *
 * `tipoProfesional` no es uno de los 5 puntos listados en el roadmap,
 * pero solo se rellena al enviar la verificación (`submitVerificationDocs`)
 * — comprobarlo es la forma de exigir que el profesional haya completado
 * ese paso al menos una vez, no solo que casualmente tenga foto+categoría.
 *
 * HogarSOS no verifica aquí la situación fiscal del profesional (ver
 * comentario del enum `TipoProfesional`) — eso es responsabilidad suya,
 * no una condición de aprobación.
 */
export async function intentarAprobacionAutomatica(profesional: Professional): Promise<Professional> {
  if (profesional.estadoVerificacion !== 'pendiente') return profesional;
  if (!profesional.tipoProfesional || !profesional.fotoPerfilUrl) return profesional;
  if (derivarEstadoCuentaStripe(profesional) !== 'configurada') return profesional;

  const tieneCategoria = await prisma.professionalCategory.count({ where: { professionalId: profesional.userId } });
  if (tieneCategoria === 0) return profesional;

  return prisma.professional.update({
    where: { userId: profesional.userId },
    data: {
      estadoVerificacion: 'aprobado',
      // Distinguible de un userId de admin real (que sí puede aprobar
      // manualmente los casos con incidencia) — útil para medir cuántas
      // aprobaciones son automáticas vs manuales (objetivo de diseño: ~95% automáticas).
      verificadoPor: 'sistema:auto-aprobacion',
      verificadoAt: new Date(),
    },
  });
}

/**
 * Consulta el estado real de una cuenta Connect en Stripe y lo persiste.
 * Se llama tanto desde el webhook (`account.updated`) como desde el
 * propio endpoint de perfil, para no depender solo de que el webhook
 * llegue (p.ej. si STRIPE_WEBHOOK_SECRET no está configurado todavía).
 *
 * También es el único punto donde se intenta la aprobación automática
 * por el lado de "Stripe acaba de terminar" — cualquier llamador que ya
 * exista (webhook, getProfile, releasePayments, updateAvailability)
 * dispara la comprobación sin tener que tocarlos uno a uno.
 */
export async function sincronizarEstadoCuentaStripe(userId: string, accountId: string) {
  const account = await stripe.accounts.retrieve(accountId);

  const actualizado = await prisma.professional.update({
    where: { userId },
    data: {
      stripeDetailsSubmitted: Boolean(account.details_submitted),
      stripeChargesEnabled: Boolean(account.charges_enabled),
      stripePayoutsEnabled: Boolean(account.payouts_enabled),
    },
  });

  return intentarAprobacionAutomatica(actualizado);
}
