-- DropIndex (payments deja de ser 1:1 con service_requests — puede
-- haber varias autorizaciones: la inicial + una por cada ampliación
-- de horas aceptada). Tabla vacía en este momento, sin datos que migrar.
DROP INDEX "payments_service_request_id_key";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "presupuesto_id" TEXT NOT NULL,
                        ADD COLUMN "ampliacion_id" TEXT;

-- CreateTable
CREATE TABLE "ampliaciones" (
    "id" TEXT NOT NULL,
    "presupuesto_id" TEXT NOT NULL,
    "horas_adicionales" DECIMAL(65,30) NOT NULL,
    "mensaje" TEXT,
    "estado" "EstadoPresupuesto" NOT NULL DEFAULT 'pendiente',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMP(3),

    CONSTRAINT "ampliaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cierres_horas" (
    "id" TEXT NOT NULL,
    "service_request_id" TEXT NOT NULL,
    "horas_reales" DECIMAL(65,30) NOT NULL,
    "estado" "EstadoPresupuesto" NOT NULL DEFAULT 'pendiente',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMP(3),

    CONSTRAINT "cierres_horas_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_presupuesto_id_fkey" FOREIGN KEY ("presupuesto_id") REFERENCES "presupuestos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_ampliacion_id_fkey" FOREIGN KEY ("ampliacion_id") REFERENCES "ampliaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ampliaciones" ADD CONSTRAINT "ampliaciones_presupuesto_id_fkey" FOREIGN KEY ("presupuesto_id") REFERENCES "presupuestos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cierres_horas" ADD CONSTRAINT "cierres_horas_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
