-- Liberación de pagos idempotente y recuperable (auditoría B2).
--
-- Añade el estado intermedio 'capturado' y el registro write-ahead que
-- permite reanudar una liberación interrumpida entre la captura y la
-- transferencia sin repetir lo ya hecho ni perder el dinero capturado.
--
-- Migración puramente aditiva: no cambia ni elimina ninguna columna
-- existente, así que las filas ya creadas siguen siendo válidas tal
-- cual (todas las columnas nuevas son NULL o tienen DEFAULT).

-- AlterEnum
ALTER TYPE "EstadoPago" ADD VALUE IF NOT EXISTS 'capturado' AFTER 'retenido';

-- AlterTable
ALTER TABLE "payments"
  ADD COLUMN "capturado_base"           DECIMAL(65,30),
  ADD COLUMN "capturado_total"          DECIMAL(65,30),
  ADD COLUMN "capturado_profesional"    DECIMAL(65,30),
  ADD COLUMN "stripe_charge_id"         TEXT,
  ADD COLUMN "capturado_at"             TIMESTAMP(3),
  ADD COLUMN "liberacion_en_curso_at"   TIMESTAMP(3),
  ADD COLUMN "intentos_liberacion"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ultimo_error_liberacion"  TEXT;

-- CreateIndex
CREATE INDEX "payments_estado_idx" ON "payments"("estado");
