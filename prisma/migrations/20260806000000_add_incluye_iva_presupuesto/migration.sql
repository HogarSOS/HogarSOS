-- El profesional puede declarar si el precio del presupuesto ya
-- incluye IVA. Es puramente informativo para el cliente en el
-- desglose de pago — no afecta a ningún cálculo de comisión.

-- AlterTable
ALTER TABLE "presupuestos" ADD COLUMN "incluye_iva" BOOLEAN NOT NULL DEFAULT false;
