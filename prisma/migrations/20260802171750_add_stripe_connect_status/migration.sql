-- AlterTable
ALTER TABLE "professionals" ADD COLUMN     "stripe_details_submitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false;
