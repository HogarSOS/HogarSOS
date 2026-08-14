-- admin_actions se creó (20260808150000_add_admin_actions_bloque4) DESPUÉS
-- de la migración que activó RLS en las otras 15 tablas de public
-- (20260805103000_enable_row_level_security) y se quedó fuera. Mismo
-- razonamiento que aquella migración: el rol "postgres" (con el que se
-- conecta el backend) es dueño de esta tabla y atraviesa RLS por
-- defecto, así que esto no cambia nada para el backend real — solo
-- cierra la misma puerta de la API pública de Supabase (REST/PostgREST
-- con la anon key) que ya se cerró para el resto de tablas.
ALTER TABLE "admin_actions" ENABLE ROW LEVEL SECURITY;
