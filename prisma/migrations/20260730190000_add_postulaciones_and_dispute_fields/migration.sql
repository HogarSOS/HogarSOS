-- CreateEnum
CREATE TYPE "EstadoPostulacion" AS ENUM ('pendiente', 'aceptada', 'rechazada');

-- CreateEnum
CREATE TYPE "MotivoReclamacion" AS ENUM ('profesional_no_presento', 'cliente_ausente', 'trabajo_cancelado', 'problema_pago', 'comportamiento_inapropiado', 'otro');

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "fotos_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "motivo_categoria" "MotivoReclamacion" NOT NULL DEFAULT 'otro';

-- CreateTable
CREATE TABLE "postulaciones" (
    "id" TEXT NOT NULL,
    "service_request_id" TEXT NOT NULL,
    "profesional_id" TEXT NOT NULL,
    "mensaje" TEXT,
    "estado" "EstadoPostulacion" NOT NULL DEFAULT 'pendiente',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMP(3),

    CONSTRAINT "postulaciones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "postulaciones_service_request_id_profesional_id_key" ON "postulaciones"("service_request_id", "profesional_id");

-- AddForeignKey
ALTER TABLE "postulaciones" ADD CONSTRAINT "postulaciones_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postulaciones" ADD CONSTRAINT "postulaciones_profesional_id_fkey" FOREIGN KEY ("profesional_id") REFERENCES "professionals"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

