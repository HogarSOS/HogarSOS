-- Nuevo estado 'pendiente' en EstadoPago: el PaymentIntent ya se creó en
-- Stripe pero el cliente todavía no ha confirmado el Payment Sheet. Antes,
-- la fila Payment nacía directamente como 'retenido', lo que hacía que la
-- solicitud apareciera como "pagada"/"autorizada" para cliente y
-- profesional aunque Stripe nunca hubiera autorizado nada real (bug real
-- de QA, 2026-08-08). No afecta a ninguna fila existente.
ALTER TYPE "EstadoPago" ADD VALUE 'pendiente' BEFORE 'retenido';
