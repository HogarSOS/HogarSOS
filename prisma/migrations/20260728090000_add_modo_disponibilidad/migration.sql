-- CreateEnum
CREATE TYPE "ModoDisponibilidad" AS ENUM ('horario_laboral', 'veinticuatro_horas');

-- AlterTable
ALTER TABLE "professionals" ADD COLUMN "modo_disponibilidad" "ModoDisponibilidad" NOT NULL DEFAULT 'horario_laboral';
