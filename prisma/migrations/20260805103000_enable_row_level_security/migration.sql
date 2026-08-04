-- Activa Row Level Security en todas las tablas de public (alerta del
-- Security Advisor de Supabase). Supabase expone automáticamente por
-- REST/PostgREST (con la anon key) cualquier tabla de public que no
-- tenga RLS activado — este proyecto nunca usa esa API (ni el backend
-- ni el frontend importan el cliente supabase-js/supabase_flutter,
-- verificado por grep), toda la app pasa por el backend Node, que se
-- conecta con el rol "postgres" y es DUEÑO de estas 15 tablas
-- (verificado con pg_tables.tableowner). El dueño de una tabla
-- atraviesa RLS por defecto (sin FORCE), así que activar RLS aquí no
-- cambia nada para el backend real: solo cierra la puerta de la API
-- pública de Supabase, que es justo lo que pedía la alerta.
--
-- Sin políticas para anon/authenticated a propósito: esta app no usa
-- Supabase Auth (usa Firebase + JWT propio), así que no existe un
-- auth.uid() real que comparar en una política — "denegar por
-- defecto" ES la política correcta de "solo usuarios autorizados"
-- cuando el único autorizado de verdad es el backend, que ya bypassea
-- RLS como dueño.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professionals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professional_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "postulaciones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "presupuestos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ampliaciones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cierres_horas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "archivos_subidos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tareas_programadas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- spatial_ref_sys (tabla de sistema de la extensión PostGIS) queda
-- fuera a propósito: es propiedad de "supabase_admin", no de
-- "postgres" (verificado con pg_tables.tableowner), y este rol no
-- tiene permiso para alterarla ni crear políticas sobre ella
-- ("ERROR: must be owner of table spatial_ref_sys" al intentarlo).
-- Se documenta y se gestiona aparte, no en esta migración.
