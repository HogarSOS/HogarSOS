-- AlterTable: rating agregado también para el usuario genérico (cliente)
ALTER TABLE "users" ADD COLUMN "valoracion_media" DECIMAL(65,30) NOT NULL DEFAULT 0.00;
ALTER TABLE "users" ADD COLUMN "total_valoraciones" INTEGER NOT NULL DEFAULT 0;

-- Reviews bidireccionales: antes solo podía existir UNA valoración por
-- solicitud en total; ahora puede haber hasta dos (cliente->profesional
-- y profesional->cliente), una por cada autor.
DROP INDEX "reviews_service_request_id_key";
CREATE UNIQUE INDEX "reviews_service_request_id_autor_id_key" ON "reviews"("service_request_id", "autor_id");
