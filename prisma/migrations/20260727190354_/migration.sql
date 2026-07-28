/*
  Warnings:

  - You are about to drop the column `ubicacionActual` on the `professionals` table. All the data in the column will be lost.
  - You are about to drop the column `zonaTrabajo` on the `professionals` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "professionals" DROP COLUMN "ubicacionActual",
DROP COLUMN "zonaTrabajo";

-- CreateIndex
CREATE INDEX "idx_service_requests_ubicacion" ON "service_requests" USING GIST ("ubicacion");
