import { Router } from 'express';
import { login, register, refreshToken, updateFcmToken } from '../controllers/auth.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.post('/register', asyncHandler(register));
router.post('/login', asyncHandler(login));
router.post('/refresh', asyncHandler(refreshToken));
router.patch('/me/fcm-token', authMiddleware(), asyncHandler(updateFcmToken));

export default router;
