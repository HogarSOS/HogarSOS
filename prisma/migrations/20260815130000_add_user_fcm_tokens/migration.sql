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
--
-- CORRECCIÓN (intento original falló en producción, P3018/23505):
-- el primer intento de este backfill copiaba TODOS los fcm_token sin
-- comprobar unicidad, y violó UNIQUE(token) — en producción hay 8
-- valores de fcm_token compartidos por 2 (o hasta 4) usuarios distintos
-- a la vez, todos con activo=true y firebaseUid distinto: el bug real
-- que esta migración existe para cerrar (un mismo dispositivo físico,
-- reutilizado entre cuentas sin reinstalar la app, porque el código
-- viejo escribía users.fcm_token sin ceder el token de nadie y sin
-- borrarlo al hacer logout) ya estaba presente en los datos.
--
-- No hay ninguna señal fiable en `users` para decidir cuál de los N
-- usuarios de un token compartido era el dueño real más reciente del
-- dispositivo (updated_at se toca por cualquier cambio en la fila, no
-- solo por el token) — elegir un "ganador" arbitrario no reduce el
-- riesgo de fuga de notificaciones, solo lo hace invisible. Por eso
-- los tokens ambiguos NO se migran aquí: cada usuario implicado
-- reclama su fila de forma segura y determinista la próxima vez que su
-- propio dispositivo llame a PATCH /auth/me/fcm-token (updateFcmToken
-- ya cede el token de cualquier otro par (userId, installationId)
-- antes de reclamarlo — ver auth.controller.ts). users.fcm_token no se
-- toca en ningún caso, sigue siendo la red de rollback documentada.
--
-- Verificado contra producción en el momento de escribir esta
-- corrección: 33 usuarios con fcm_token, 23 valores distintos, 8
-- valores duplicados entre 18 usuarios — el backfill de abajo debe
-- producir exactamente 15 filas (33 - 18). Comprobar con
-- `SELECT COUNT(*) FROM user_fcm_tokens` tras el despliegue.
INSERT INTO "user_fcm_tokens" ("id", "user_id", "installation_id", "token", "created_at", "updated_at")
SELECT gen_random_uuid()::text, "id", 'legacy', "fcm_token", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users"
WHERE "fcm_token" IS NOT NULL
  AND "fcm_token" NOT IN (
    SELECT "fcm_token" FROM "users"
    WHERE "fcm_token" IS NOT NULL
    GROUP BY "fcm_token"
    HAVING COUNT(*) > 1
  );
