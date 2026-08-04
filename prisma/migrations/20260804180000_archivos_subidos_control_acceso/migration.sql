-- Control de acceso y ciclo de vida de archivos subidos (auditoría B4).
--
-- Hasta ahora /uploads se servía con express.static SIN autenticación, y
-- por ese mismo endpoint pasaban tanto las fotos de una solicitud como
-- los DOCUMENTOS DE IDENTIDAD y los seguros de responsabilidad civil de
-- los profesionales. Cualquiera con la URL leía un DNI escaneado, para
-- siempre y sin sesión. Además, al eliminar una cuenta se ponía la URL a
-- NULL pero el fichero seguía en disco (incumpliendo el RGPD Art. 17).
--
-- La causa raíz era que el sistema no registraba QUÉ era cada archivo.
-- Esta tabla lo registra, y con eso se puede autorizar cada lectura y
-- borrar de verdad.
--
-- IMPORTANTE: esta migración NO reescribe ninguna URL almacenada. La
-- ruta sigue siendo /uploads/<uuid>.jpg — lo que cambia es que ahora
-- exige autenticación. Así ningún dato histórico se toca.

-- CreateEnum
CREATE TYPE "TipoArchivo" AS ENUM (
  'foto_perfil',
  'foto_solicitud',
  'foto_disputa',
  'documento_identidad',
  'certificado',
  'seguro_rc'
);

-- CreateTable
CREATE TABLE "archivos_subidos" (
    "id"                 TEXT NOT NULL,
    "nombre_archivo"     TEXT NOT NULL,
    "tipo"               "TipoArchivo" NOT NULL,
    "propietario_id"     TEXT NOT NULL,
    "service_request_id" TEXT,
    "bytes"              INTEGER NOT NULL DEFAULT 0,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eliminado_at"       TIMESTAMP(3),

    CONSTRAINT "archivos_subidos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "archivos_subidos_nombre_archivo_key" ON "archivos_subidos"("nombre_archivo");
CREATE INDEX "archivos_subidos_propietario_id_idx" ON "archivos_subidos"("propietario_id");
CREATE INDEX "archivos_subidos_service_request_id_idx" ON "archivos_subidos"("service_request_id");
CREATE INDEX "archivos_subidos_eliminado_at_idx" ON "archivos_subidos"("eliminado_at");

-- AddForeignKey
ALTER TABLE "archivos_subidos" ADD CONSTRAINT "archivos_subidos_propietario_id_fkey"
  FOREIGN KEY ("propietario_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- BACKFILL de los archivos que ya existen
-- ---------------------------------------------------------------------
--
-- Clave del backfill: LA COLUMNA DE LA QUE VIENE UN ARCHIVO DICE
-- EXACTAMENTE QUÉ ES. `documento_identidad_url` solo puede contener un
-- documento de identidad, `fotos_urls` de una solicitud solo fotos de
-- esa solicitud, etc. No hay que adivinar nada.
--
-- `regexp_replace(url, '^.*/', '')` se queda con el nombre del fichero
-- descartando el dominio, para que funcione igual con URLs guardadas
-- cuando APP_BASE_URL era otra (localhost, una IP de red local...).
--
-- ON CONFLICT DO NOTHING porque un mismo fichero podría estar
-- referenciado desde dos sitios; la primera clasificación gana.

-- Documentos de identidad (los más sensibles).
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace("documento_identidad_url", '^.*/', ''), 'documento_identidad', "user_id", CURRENT_TIMESTAMP
FROM "professionals"
WHERE "documento_identidad_url" IS NOT NULL AND "documento_identidad_url" <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- Seguro de responsabilidad civil.
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace("seguro_rc_url", '^.*/', ''), 'seguro_rc', "user_id", CURRENT_TIMESTAMP
FROM "professionals"
WHERE "seguro_rc_url" IS NOT NULL AND "seguro_rc_url" <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- Certificados (columna de tipo array).
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace(cert, '^.*/', ''), 'certificado', p."user_id", CURRENT_TIMESTAMP
FROM "professionals" p, unnest(p."certificados_url") AS cert
WHERE cert IS NOT NULL AND cert <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- Fotos de perfil (viven en dos tablas distintas).
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace("foto_perfil_url", '^.*/', ''), 'foto_perfil', "id", CURRENT_TIMESTAMP
FROM "users"
WHERE "foto_perfil_url" IS NOT NULL AND "foto_perfil_url" <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace("foto_perfil_url", '^.*/', ''), 'foto_perfil', "user_id", CURRENT_TIMESTAMP
FROM "professionals"
WHERE "foto_perfil_url" IS NOT NULL AND "foto_perfil_url" <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- Fotos de solicitudes: se rellena también service_request_id, que es lo
-- que permite después comprobar "¿eres participante de esta solicitud?"
-- con una consulta indexada exacta.
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "service_request_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace(foto, '^.*/', ''), 'foto_solicitud', sr."cliente_id", sr."id", sr."created_at"
FROM "service_requests" sr, unnest(sr."fotos_urls") AS foto
WHERE foto IS NOT NULL AND foto <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- Columna antigua de foto única, anterior a fotos_urls.
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "service_request_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace(sr."foto_url", '^.*/', ''), 'foto_solicitud', sr."cliente_id", sr."id", sr."created_at"
FROM "service_requests" sr
WHERE sr."foto_url" IS NOT NULL AND sr."foto_url" <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- Capturas adjuntas a una reclamación.
INSERT INTO "archivos_subidos" ("id", "nombre_archivo", "tipo", "propietario_id", "service_request_id", "created_at")
SELECT gen_random_uuid()::text, regexp_replace(foto, '^.*/', ''), 'foto_disputa', d."creado_por", d."service_request_id", d."created_at"
FROM "disputes" d, unnest(d."fotos_urls") AS foto
WHERE foto IS NOT NULL AND foto <> ''
ON CONFLICT ("nombre_archivo") DO NOTHING;

-- NOTA sobre los archivos que queden en disco SIN fila aquí: son subidas
-- abandonadas (alguien subió el fichero pero nunca envió el formulario).
-- No se pueden clasificar, así que a partir de ahora el endpoint
-- responde 404 para ellos — que es justo lo que se quiere para un DNI
-- huérfano. La tarea programada `limpiar-archivos-huerfanos` los borra
-- del disco después, no esta migración: así queda una ventana por si
-- hubiera que recuperar alguno.
