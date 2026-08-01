ALTER TABLE "payments" ADD COLUMN "monto_base" DECIMAL(65,30) NOT NULL DEFAULT 0;
UPDATE "payments" SET "monto_base" = "monto_total";
ALTER TABLE "payments" ALTER COLUMN "monto_base" DROP DEFAULT;
