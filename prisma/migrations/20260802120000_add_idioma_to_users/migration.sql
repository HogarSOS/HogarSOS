-- CreateEnum
CREATE TYPE "Idioma" AS ENUM ('es', 'en');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "idioma" "Idioma" NOT NULL DEFAULT 'es';
