-- DropColumn (precio_estimado nunca se usó de verdad desde el wizard de creación — siempre null en producción)
ALTER TABLE "service_requests" DROP COLUMN "precio_estimado";

-- CreateEnum
CREATE TYPE "TipoPresupuesto" AS ENUM ('cerrado', 'por_horas');

-- CreateEnum
CREATE TYPE "EstadoPresupuesto" AS ENUM ('pendiente', 'aceptado', 'rechazado');

-- CreateTable
CREATE TABLE "presupuestos" (
    "id" TEXT NOT NULL,
    "service_request_id" TEXT NOT NULL,
    "profesional_id" TEXT NOT NULL,
    "tipo" "TipoPresupuesto" NOT NULL,
    "monto" DECIMAL(65,30),
    "tarifa_hora" DECIMAL(65,30),
    "horas_estimadas" DECIMAL(65,30),
    "mensaje" TEXT,
    "estado" "EstadoPresupuesto" NOT NULL DEFAULT 'pendiente',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMP(3),

    CONSTRAINT "presupuestos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "presupuestos_service_request_id_estado_idx" ON "presupuestos"("service_request_id", "estado");

-- AddForeignKey
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_profesional_id_fkey" FOREIGN KEY ("profesional_id") REFERENCES "professionals"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
