-- AlterTable: Ampliacion pasa a admitir dos modalidades, igual que
-- Presupuesto (horasAdicionales para "por_horas", montoAdicional para
-- "cerrado") — horas_adicionales deja de ser obligatoria.
ALTER TABLE "ampliaciones" ALTER COLUMN "horas_adicionales" DROP NOT NULL;
ALTER TABLE "ampliaciones" ADD COLUMN "monto_adicional" DECIMAL(65,30);
