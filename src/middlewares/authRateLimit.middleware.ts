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
