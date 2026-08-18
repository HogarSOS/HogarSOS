import { Router } from 'express';
import { login, register, refreshToken, logout, updateFcmToken, updateIdioma, forgotPassword, passwordResetCompleted } from '../controllers/auth.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { authRateLimit, refreshRateLimit } from '../middlewares/authRateLimit.middleware';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.post('/register', authRateLimit, asyncHandler(register));
router.post('/login', authRateLimit, asyncHandler(login));
router.post('/refresh', refreshRateLimit, asyncHandler(refreshToken));
// allowExpired: el logout debe poder limpiar el UserFcmToken de este
// dispositivo y revocar la sesión aunque el access token ya haya caducado
// (si no, el aparato deslogueado seguía recibiendo push). La firma se sigue
// verificando — ver authMiddleware.
router.post('/logout', authMiddleware(undefined, { allowExpired: true }), asyncHandler(logout));
router.post('/forgot-password', authRateLimit, asyncHandler(forgotPassword));
router.post('/password-reset-completed', authRateLimit, asyncHandler(passwordResetCompleted));
router.patch('/me/fcm-token', authMiddleware(), asyncHandler(updateFcmToken));
router.patch('/me/idioma', authMiddleware(), asyncHandler(updateIdioma));

export default router;
