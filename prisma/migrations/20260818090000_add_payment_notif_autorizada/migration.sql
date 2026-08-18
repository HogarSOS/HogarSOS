-- Notificación de pago confirmado (2026-08-18): marcador de idempotencia
-- separado del cambio de estado pendiente->retenido. El webhook
-- amount_capturable_updated notificaba usando el count del propio cambio
-- de estado como única guarda — si el proceso moría entre el UPDATE y el
-- envío, el reintento de Stripe veía count 0 y la notificación se perdía
-- para siempre. Este marcador permite reclamarla por separado: guarda el
-- PaymentIntent por el que ya se notificó (no un booleano, porque B5
-- reautoriza la misma fila con un intent nuevo que debe notificarse otra
-- vez). Aditiva y no destructiva: 1 columna nullable.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "notif_autorizada_pi_id" TEXT;

-- Backfill: las filas que ya salieron de 'pendiente' se marcan como ya
-- notificadas por su intent actual — sin esto, una redelivery tardía de
-- un webhook antiguo justo después del despliegue re-notificaría pagos
-- de hace semanas.
UPDATE "payments" SET "notif_autorizada_pi_id" = "stripe_payment_intent_id"
 WHERE "estado" <> 'pendiente' AND "stripe_payment_intent_id" IS NOT NULL;
