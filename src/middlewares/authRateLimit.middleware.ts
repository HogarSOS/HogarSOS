import rateLimit from 'express-rate-limit';

/**
 * Límite específico para login/register/forgot-password (auditoría de
 * cierre, 2026-08-13). El límite global de `index.ts` (2000/15min) está
 * calibrado para uso normal de la app entera, no como protección
 * anti-fuerza-bruta: con ese margen, un atacante podía probar cientos
 * de contraseñas contra una cuenta conocida sin acercarse al límite.
 *
 * 20/15min por IP deja margen de sobra para un usuario real que se
 * equivoca varias veces de contraseña o reenvía el email de
 * recuperación, sin dejar hueco práctico para fuerza bruta.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.',
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.',
    });
  },
});

/**
 * Límite específico para /auth/refresh (P3, auditoría final 2026-08-14).
 * Deliberadamente NO reutiliza `authRateLimit`: ese limiter comparte
 * cupo entre login/register/forgot-password por IP, y el refresh se
 * dispara automáticamente (cada expiración de access token, 15min, más
 * el arranque en frío de la app) sin que el usuario lo escriba — varios
 * testers detrás de la misma IP (oficina, wifi doméstica) agotarían el
 * cupo de login solo con el tráfico de fondo de refresh.
 *
 * El access token es un JWT firmado (`verifyRefreshToken`), no es
 * fuerza-bruteable con reintentos — este límite es contra abuso de
 * recursos, no contra adivinar el token. 60/15min deja margen de sobra
 * para varios dispositivos activos a la vez con reintentos.
 */
export const refreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.',
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.',
    });
  },
});

/**
 * Límite específico para /api/uploads/photo (P3, auditoría final
 * 2026-08-14). El límite global de `index.ts` (2000/15min) cubre toda
 * la app, no protege específicamente contra abuso de disco/CPU: cada
 * subida pasa por `sharp` (redimensionar/recomprimir) antes de
 * guardarse, así que es más cara que una petición normal. Una sesión
 * real (fotos de perfil, antes/después de un servicio, documentos de
 * identidad/seguro) no necesita más de unas pocas decenas de subidas
 * en 15 minutos.
 */
export const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.',
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.',
    });
  },
});
