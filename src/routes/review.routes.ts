import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { createReview } from '../controllers/review.controller';

const router = Router();

router.post('/', authMiddleware(['cliente']), asyncHandler(createReview));

export default router;
