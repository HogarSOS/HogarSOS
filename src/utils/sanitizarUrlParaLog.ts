/**
 * Auditoría P1 (2026-08-14): el logger global de peticiones (index.ts)
 * registra req.originalUrl completo, incluida la query string — para
 * la mayoría de rutas eso es justo lo útil de depurar (filtros,
 * paginación), pero /auth/reset-password recibe el oobCode de Firebase
 * en la query, y ese valor por sí solo permite fijar una contraseña
 * nueva sin conocer ni el email ni la contraseña anterior. Redacta SOLO
 * los parámetros de esta lista, no toda la query — recortar a
 * req.path habría perdido información útil de depuración en el resto
 * de rutas por un problema que solo afecta a un parámetro concreto.
 */
const PARAMETROS_SENSIBLES = ['oobCode'];

export function sanitizarUrlParaLog(url: string): string {
  const indice = url.indexOf('?');
  if (indice === -1) return url;

  const path = url.slice(0, indice);
  const query = url.slice(indice + 1);
  const params = new URLSearchParams(query);

  for (const nombre of PARAMETROS_SENSIBLES) {
    if (params.has(nombre)) {
      params.set(nombre, '[REDACTED]');
    }
  }

  return `${path}?${params.toString()}`;
}
