-- B5: contador de reautorizaciones de un PaymentIntent caducado sobre la
-- MISMA fila Payment (no se crea una fila nueva por reautorización).
-- Alimenta la idempotency key intent_retry_<id>_<intentosAutorizacion>
-- para que una segunda caducidad de la misma fila no reutilice la clave
-- de la reautorización anterior.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "intentos_autorizacion" INTEGER NOT NULL DEFAULT 0;
