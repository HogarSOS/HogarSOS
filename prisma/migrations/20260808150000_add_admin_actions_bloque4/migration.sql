-- Auditoría centralizada del panel admin (Bloque 4).
--
-- Hasta ahora bloquear/activar un usuario, aprobar/rechazar un
-- profesional o resolver una disputa cambiaban el estado sin dejar
-- rastro de quién lo hizo ni cuándo -- solo quedaba el estado final. Esta
-- tabla registra cada acción por separado, escrita DESPUÉS de que el
-- cambio de estado real ya se aplicó (nunca en la misma transacción: un
-- fallo al auditar no debe impedir ni deshacer la acción).

-- CreateTable
CREATE TABLE "admin_actions" (
    "id"              TEXT NOT NULL,
    "admin_id"        TEXT NOT NULL,
    "accion"          TEXT NOT NULL,
    "entidad_tipo"    TEXT NOT NULL,
    "entidad_id"      TEXT NOT NULL,
    "estado_anterior" TEXT,
    "estado_nuevo"    TEXT,
    "detalle"         TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_actions_admin_id_created_at_idx" ON "admin_actions"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_actions_entidad_tipo_entidad_id_idx" ON "admin_actions"("entidad_tipo", "entidad_id");
