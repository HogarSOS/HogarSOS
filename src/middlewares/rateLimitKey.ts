import jwt from 'jsonwebtoken';

/**
 * Clave del rate limiter global (endurecimiento pre-lanzamiento nacional,
 * 2026-08-18): cupo POR USUARIO cuando la petición lleva un access token
 * válido, y por IP solo para el tráfico anónimo.
 *
 * El problema real: los operadores móviles españoles usan CGNAT — cientos
 * de usuarios comparten una misma IP pública. Con el cupo por IP (2000/15min
 * ≈ 2,2 req/s para TODOS los que comparten IP), bastan unas decenas de
 * usuarios activos tras el mismo NAT (cada pantalla de seguimiento sondea
 * cada 5s) para que usuarios legítimos empiecen a recibir 429 sin haber
 * hecho nada raro.
 *
 * El token se VERIFICA (firma HS256), no solo se decodifica: si bastara
 * un JWT decorativo, un atacante fabricaría userIds aleatorios y cada
 * petición estrenaría su propio cupo, anulando el limiter. Con la firma
 * verificada, fabricar cupos exige registrar cuentas reales (Firebase +
 * BD), que ya tiene su propio límite. Un HMAC extra por petición cuesta
 * microsegundos; el authMiddleware repite la verificación después para
 * las rutas protegidas, y esa redundancia es aceptable a cambio de no
 * acoplar el limiter al orden de los middlewares.
 *
 * Token inválido o caducado NO es un error aquí — cae al cupo por IP,
 * que es exactamente donde debe contar ese tráfico (el 401 se lo dará
 * authMiddleware después).
 */
export function claveRateLimit(authorization: string | undefined, ip: string | undefined): string {
  if (authorization?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authorization.slice(7), process.env.JWT_SECRET as string, {
        algorithms: ['HS256'],
      }) as { userId?: string };
      if (payload.userId) return `u:${payload.userId}`;
    } catch {
      // firma inválida o caducado: tráfico anónimo a efectos de cupo
    }
  }
  return claveIp(ip);
}

/**
 * IPv6 se agrupa por /64: un mismo equipo puede rotar direcciones dentro
 * de su /64 (privacy extensions), y darle un cupo nuevo por cada
 * dirección dejaría el limiter inservible contra IPv6. IPv4 va tal cual.
 */
export function claveIp(ip: string | undefined): string {
  if (!ip) return 'ip:desconocida';
  if (ip.includes(':')) return `ip6:${ip.split(':').slice(0, 4).join(':')}`;
  return `ip:${ip}`;
}
