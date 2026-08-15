-- P2 #5 (auditoría 2026-08-14, punto 5): un único fcm_token por usuario
-- se pisaba silenciosamente entre dispositivos (sin error visible) y
-- podía quedar compartido entre dos cuentas en un dispositivo
-- reutilizado sin reinstalar. Reemplazo: una fila por instalación,
-- identificada por (user_id, installation_id) — el token es mutable
-- dentro de esa fila (rotación = UPDATE en el sitio). UNIQUE(token) es
-- la garantía real de que un token físico no puede quedar vivo bajo
-- dos usuarios a la vez. Aditiva y no destructiva: users.fcm_token NO
-- se toca, se conserva como red de seguridad de rollback.

-- CreateTable
CREATE TABLE "user_fcm_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_fcm_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_fcm_tokens_token_key" ON "user_fcm_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "user_fcm_tokens_user_id_installation_id_key" ON "user_fcm_tokens"("user_id", "installation_id");

-- CreateIndex
CREATE INDEX "user_fcm_tokens_user_id_idx" ON "user_fcm_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "user_fcm_tokens" ADD CONSTRAINT "user_fcm_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: conserva los fcm_token actuales bajo un installation_id
-- sintético 'legacy'. Se autocorrige solo: en cuanto esa instalación
-- real vuelva a abrir la app con el código nuevo, llega con su
-- installationId real y la transacción de updateFcmToken (borra
-- cualquier fila con el mismo token que no sea de ese par exacto)
-- sustituye esta fila legacy por la definitiva.
INSERT INTO "user_fcm_tokens" ("id", "user_id", "installation_id", "token", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "id", 'legacy', "fcm_token", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users"
WHERE "fcm_token" IS NOT NULL;
