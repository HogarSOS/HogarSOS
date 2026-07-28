ALTER TABLE "professionals"
  ADD COLUMN IF NOT EXISTS "zona_trabajo" geography,
  ADD COLUMN IF NOT EXISTS "ubicacion_actual" geography;

CREATE INDEX IF NOT EXISTS idx_professionals_ubicacion_actual
  ON "professionals" USING GIST ("ubicacion_actual");
