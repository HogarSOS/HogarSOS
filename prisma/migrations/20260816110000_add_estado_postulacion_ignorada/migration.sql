-- Nuevo estado 'ignorada' en EstadoPostulacion: un profesional puede
-- ignorar una solicitud cercana desde "Solicitudes cerca de ti" sin que
-- eso sea nunca una candidatura real. Se reutiliza la tabla
-- `postulaciones` (en vez de crear una tabla nueva) porque
-- @@unique([serviceRequestId, profesionalId]) ya es exactamente la
-- garantía "una fila por profesional y solicitud" que hace falta, y
-- listNearbyRequests ya hace el JOIN necesario para leerlo. Migración
-- puramente aditiva: no cambia ni elimina ninguna fila existente.
ALTER TYPE "EstadoPostulacion" ADD VALUE IF NOT EXISTS 'ignorada';
