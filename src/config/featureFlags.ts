/**
 * Cuando está en `false`, ningún profesional queda bloqueado por su
 * `estadoVerificacion` (disponibilidad, aceptar solicitudes, aparecer en
 * búsquedas o en el perfil público). La arquitectura de verificación
 * (envío de documentos, cola de revisión y aprobación/rechazo por un
 * admin) sigue intacta y operativa — este flag solo controla si su
 * resultado se exige como requisito de acceso.
 */
export const REQUIRE_PROFESSIONAL_VERIFICATION =
  process.env.REQUIRE_PROFESSIONAL_VERIFICATION !== 'false';
