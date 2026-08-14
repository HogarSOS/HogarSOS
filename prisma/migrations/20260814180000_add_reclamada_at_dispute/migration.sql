-- P2 (auditoría 2026-08-14, revisión de concurrencia crítica): TTL +
-- fencing token del claim de resolveDispute. Sin esta columna, una
-- disputa que queda en 'en_resolucion' porque el proceso que la reclamó
-- murió o se colgó a mitad de la resolución no puede volver a
-- reclamarse nunca (misma "disputa inmortal" ya corregida una vez para
-- el caso de fallo de Stripe con el proceso vivo). Se limpia a NULL al
-- finalizar con éxito o al revertir por fallo.

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN "reclamada_at" TIMESTAMP(3);
