-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_ampliacion_id_fkey";

-- CreateIndex
CREATE INDEX "cierres_horas_service_request_id_idx" ON "cierres_horas"("service_request_id");

-- CreateIndex
CREATE INDEX "disputes_service_request_id_idx" ON "disputes"("service_request_id");

-- CreateIndex
CREATE INDEX "payments_service_request_id_idx" ON "payments"("service_request_id");

-- CreateIndex
CREATE INDEX "professional_categories_category_id_idx" ON "professional_categories"("category_id");

-- CreateIndex
CREATE INDEX "professionals_disponible_idx" ON "professionals"("disponible");

-- CreateIndex
CREATE INDEX "professionals_estado_verificacion_idx" ON "professionals"("estado_verificacion");

-- CreateIndex
CREATE INDEX "reviews_destinatario_id_idx" ON "reviews"("destinatario_id");

-- CreateIndex
CREATE INDEX "service_requests_cliente_id_idx" ON "service_requests"("cliente_id");

-- CreateIndex
CREATE INDEX "service_requests_profesional_id_idx" ON "service_requests"("profesional_id");

-- CreateIndex
CREATE INDEX "service_requests_estado_category_id_idx" ON "service_requests"("estado", "category_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_ampliacion_id_fkey" FOREIGN KEY ("ampliacion_id") REFERENCES "ampliaciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

