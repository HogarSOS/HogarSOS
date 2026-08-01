-- Registro por teléfono como alternativa al email (no lo sustituye):
-- una cuenta puede tener email, teléfono, o ambos, pero necesita al
-- menos uno (esa regla se valida en auth.controller.ts, no aquí).

-- Normaliza cadenas vacías a NULL antes de poner la restricción única
-- de más abajo — si no, "" chocaría consigo misma (a diferencia de
-- NULL, que Postgres siempre trata como distinto de cualquier otro NULL).
UPDATE "users" SET "telefono" = NULL WHERE "telefono" = '';

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_telefono_key" UNIQUE ("telefono");
