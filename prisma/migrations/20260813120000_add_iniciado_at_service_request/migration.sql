-- El profesional puede marcar "Iniciar trabajo" (aceptada -> en_progreso)
-- para proteger su cobro frente a una cancelación instantánea del
-- cliente una vez el trabajo ya ha empezado de verdad. Reversible con
-- "Deshacer inicio" (en_progreso -> aceptada), que pone esta columna a
-- NULL de nuevo sin tocar Stripe.

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN "iniciado_at" TIMESTAMP(3);
