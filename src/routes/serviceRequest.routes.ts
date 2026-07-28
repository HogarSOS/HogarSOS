import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createServiceRequest,
  getServiceRequestById,
  listNearbyRequests,
  acceptServiceRequest,
  completeServiceRequest,
  listMyServiceRequests,
} from '../controllers/serviceRequest.controller';

const router = Router();

router.post('/', authMiddleware(['cliente']), asyncHandler(createServiceRequest));
// IMPORTANTE: '/mine' debe ir ANTES de '/:id' — si no, Express
// interpretaría "mine" como un id de solicitud (mismo motivo que
// '/search' en professional.routes.ts).
router.get('/mine', authMiddleware(['cliente']), asyncHandler(listMyServiceRequests));
router.get('/:id', authMiddleware(), asyncHandler(getServiceRequestById));
router.get('/nearby/list', authMiddleware(['profesional']), asyncHandler(listNearbyRequests));
router.patch('/:id/accept', authMiddleware(['profesional']), asyncHandler(acceptServiceRequest));
router.patch('/:id/complete', authMiddleware(['profesional']), asyncHandler(completeServiceRequest));

export default router;
