import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { getMe, updateMe, getMisValoraciones } from '../controllers/user.controller';

const router = Router();

router.get('/me', authMiddleware(), asyncHandler(getMe));
router.patch('/me', authMiddleware(), asyncHandler(updateMe));
router.get('/me/reviews', authMiddleware(), asyncHandler(getMisValoraciones));

export default router;
