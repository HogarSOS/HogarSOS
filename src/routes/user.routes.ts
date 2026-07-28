import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { getMe, updateMe } from '../controllers/user.controller';

const router = Router();

router.get('/me', authMiddleware(), asyncHandler(getMe));
router.patch('/me', authMiddleware(), asyncHandler(updateMe));

export default router;
