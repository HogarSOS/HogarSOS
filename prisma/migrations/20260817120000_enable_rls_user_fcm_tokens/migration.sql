-- user_fcm_tokens se creó (20260815130000_add_user_fcm_tokens) DESPUÉS
-- de las dos migraciones que activaron RLS (20260805103000 para las 15
-- tablas originales, 20260814120000 para admin_actions) y se quedó
-- fuera, repitiendo por tercera vez el mismo defecto. El rol "postgres"
-- (con el que se conecta el backend) es dueño de esta tabla y atraviesa
-- RLS por defecto, así que esto no cambia nada para el backend real —
-- solo cierra la misma puerta de la API pública de Supabase
-- (REST/PostgREST con la anon key) que ya se cerró para el resto.
ALTER TABLE "user_fcm_tokens" ENABLE ROW LEVEL SECURITY;
