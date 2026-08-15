import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { uploadMiddleware } from '../config/upload';
import { uploadPhoto } from '../controllers/upload.controller';
import { uploadRateLimit } from '../middlewares/authRateLimit.middleware';

const router = Router();

router.post('/photo', authMiddleware(), uploadRateLimit, uploadMiddleware.single('foto'), asyncHandler(uploadPhoto));

export default router;
