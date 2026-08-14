-- P2 #3 (auditoría 2026-08-14): mismo bug estructural que P2 #2
-- (ver 20260814190000_add_cierre_horas_pendiente_unico), esta vez en
-- createPresupuesto y crearAmpliacion — findFirst(estado='pendiente')
-- seguido de create sin ninguna protección atómica entre medias.
-- Comprobado contra producción (2026-08-14): 0 claves duplicadas en
-- ninguna de las dos tablas, así que ambos índices se aplican limpios.
--
-- Presupuesto: unicidad sobre service_request_id — una solicitud no
-- debe tener más de un presupuesto pendiente a la vez.
CREATE UNIQUE INDEX "presupuestos_pendiente_unico" ON "presupuestos" ("service_request_id") WHERE "estado" = 'pendiente';

-- Ampliacion: unicidad sobre presupuesto_id, NO sobre
-- service_request_id — cada presupuesto (incluido uno antiguo ya
-- rechazado) tiene su propio ciclo de ampliaciones independiente,
-- mismo criterio que ya usa el findFirst existente en
-- ampliacion.controller.ts.
CREATE UNIQUE INDEX "ampliaciones_pendiente_unico" ON "ampliaciones" ("presupuesto_id") WHERE "estado" = 'pendiente';
