import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import {
  listPendingVerifications,
  approveProfessional,
  listDisputes,
  resolveDispute,
} from '../controllers/admin.controller';

const router = Router();

router.get('/verifications/pending', authMiddleware(['admin']), asyncHandler(listPendingVerifications));
router.patch('/verifications/:professionalId/approve', authMiddleware(['admin']), asyncHandler(approveProfessional));
router.get('/disputes', authMiddleware(['admin']), asyncHandler(listDisputes));
router.patch('/disputes/:id/resolve', authMiddleware(['admin']), asyncHandler(resolveDispute));

export default router;
