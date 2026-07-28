import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getProfile,
  updateAvailability,
  updateMyProfile,
  updateMyCategories,
  submitVerificationDocs,
  startStripeOnboarding,
  searchProfessionals,
  getPublicProfile,
} from '../controllers/professional.controller';

const router = Router();

router.get('/me', authMiddleware(['profesional']), asyncHandler(getProfile));
router.patch('/me/availability', authMiddleware(['profesional']), asyncHandler(updateAvailability));
router.patch('/me/profile', authMiddleware(['profesional']), asyncHandler(updateMyProfile));
router.patch('/me/categories', authMiddleware(['profesional']), asyncHandler(updateMyCategories));
router.post('/me/verification', authMiddleware(['profesional']), asyncHandler(submitVerificationDocs));
router.post('/me/stripe-onboarding', authMiddleware(['profesional']), asyncHandler(startStripeOnboarding));

// IMPORTANTE: '/search' debe ir ANTES de '/:id' — si no, Express
// interpretaría "search" como un id de profesional.
router.get('/search', authMiddleware(), asyncHandler(searchProfessionals));
router.get('/:id', authMiddleware(), asyncHandler(getPublicProfile));

export default router;
