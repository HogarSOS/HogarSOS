-- P2 #7 (auditoría 2026-08-14, punto 7): un contracargo de Stripe sobre
-- un pago ya liberado quedaba invisible para siempre — charge.dispute.created
-- solo escribía un texto en ultimo_error_liberacion, que releasePayments
-- borra al liberar con éxito, y que la cola de admin solo muestra para
-- pagos 'capturado'/'retenido'. Columnas independientes, no tocadas por
-- el camino de éxito de la liberación, para que la disputa siga visible
-- y siga bloqueando movimientos de dinero pase lo que pase con `estado`.
-- Aditiva y no destructiva: 5 columnas nullable, sin backfill (0 de los
-- 61 Payment actuales tiene una disputa registrada).
--
-- stripe_dispute_ultimo_evento_id (revisión adversarial final): event.created
-- de Stripe solo tiene precisión de segundo — dos eventos DISTINTOS
-- pueden compartir el mismo segundo. Sin este desempate por event.id, el
-- segundo se descartaba como si fuera un duplicado del primero.

-- AlterTable
ALTER TABLE "payments"
  ADD COLUMN "stripe_dispute_id" TEXT,
  ADD COLUMN "stripe_dispute_status" TEXT,
  ADD COLUMN "stripe_dispute_monto" DECIMAL(65,30),
  ADD COLUMN "stripe_dispute_ultimo_evento_en" TIMESTAMP(3),
  ADD COLUMN "stripe_dispute_ultimo_evento_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_dispute_id_key" ON "payments"("stripe_dispute_id");
