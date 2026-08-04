-- Infraestructura única de tareas programadas (auditoría B5), compartida
-- por el reintento automático de pagos atascados (B2) y la gestión de
-- autorizaciones de Stripe a punto de caducar (B5).
--
-- Migración aditiva: crea una tabla nueva y añade dos columnas nullable
-- a payments. No toca nada existente.

-- CreateTable
CREATE TABLE "tareas_programadas" (
    "nombre"               TEXT NOT NULL,
    "bloqueado_hasta"      TIMESTAMP(3),
    "ultima_ejecucion_at"  TIMESTAMP(3),
    "ultimo_resultado"     TEXT,
    "ultimo_error"         TEXT,
    "ejecuciones"          INTEGER NOT NULL DEFAULT 0,
    "fallos_consecutivos"  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tareas_programadas_pkey" PRIMARY KEY ("nombre")
);

-- AlterTable
ALTER TABLE "payments"
  ADD COLUMN "ultimo_intento_liberacion_at" TIMESTAMP(3),
  ADD COLUMN "aviso_caducidad_enviado_at"   TIMESTAMP(3);
