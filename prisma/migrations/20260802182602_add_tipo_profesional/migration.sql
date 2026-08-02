-- CreateEnum
CREATE TYPE "TipoProfesional" AS ENUM ('autonomo', 'empresa', 'persona_fisica');

-- AlterTable
ALTER TABLE "professionals" ADD COLUMN     "tipo_profesional" "TipoProfesional";
