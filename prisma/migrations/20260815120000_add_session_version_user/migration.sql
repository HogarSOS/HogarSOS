-- P2 #4 (auditoría 2026-08-14): logout no revocaba el refresh token en
-- el backend. Contador de revocación todo-o-nada: se incrementa en cada
-- logout, y /api/auth/refresh compara la versión embebida en el token
-- contra este valor. Aditiva y no destructiva: default 0 para todas las
-- filas existentes, ningún refresh token en circulación se invalida al
-- desplegar (verifyRefreshToken trata la ausencia del campo como 0).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
