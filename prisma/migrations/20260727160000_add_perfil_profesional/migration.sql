ALTER TABLE "professionals"
  ADD COLUMN IF NOT EXISTS "descripcion" TEXT,
  ADD COLUMN IF NOT EXISTS "foto_perfil_url" TEXT;
