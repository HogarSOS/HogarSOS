import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createServiceRequest,
  getServiceRequestById,
  listNearbyRequests,
  completeServiceRequest,
  cancelServiceRequest,
  deleteServiceRequest,
  listMyServiceRequests,
  listMyAssignedRequests,
  syncChat,
  notifyChatMessage,
  markChatRead,
} from '../controllers/serviceRequest.controller';
import { createDispute } from '../controllers/dispute.controller';
import { createPostulacion, listPostulaciones, selectPostulacion } from '../controllers/postulacion.controller';
import { createPresupuesto, responderPresupuesto } from '../controllers/presupuesto.controller';

const router = Router();

router.post('/', authMiddleware(['cliente']), asyncHandler(createServiceRequest));
// IMPORTANTE: '/mine' debe ir ANTES de '/:id' — si no, Express
// interpretaría "mine" como un id de solicitud (mismo motivo que
// '/search' en professional.routes.ts).
router.get('/mine', authMiddleware(['cliente']), asyncHandler(listMyServiceRequests));
router.get('/:id', authMiddleware(), asyncHandler(getServiceRequestById));
router.get('/nearby/list', authMiddleware(['profesional']), asyncHandler(listNearbyRequests));
router.get('/assigned/mine', authMiddleware(['profesional']), asyncHandler(listMyAssignedRequests));
router.patch('/:id/complete', authMiddleware(['profesional']), asyncHandler(completeServiceRequest));
router.patch('/:id/cancel', authMiddleware(['cliente']), asyncHandler(cancelServiceRequest));
router.delete('/:id', authMiddleware(['cliente']), asyncHandler(deleteServiceRequest));
router.post('/:id/sync-chat', authMiddleware(), asyncHandler(syncChat));
router.post('/:id/notify-chat', authMiddleware(), asyncHandler(notifyChatMessage));
router.post('/:id/mark-chat-read', authMiddleware(), asyncHandler(markChatRead));
router.post('/:id/disputes', authMiddleware(['cliente', 'profesional']), asyncHandler(createDispute));
router.post('/:id/postulaciones', authMiddleware(['profesional']), asyncHandler(createPostulacion));
router.get('/:id/postulaciones', authMiddleware(['cliente']), asyncHandler(listPostulaciones));
router.post('/:id/postulaciones/:postulacionId/seleccionar', authMiddleware(['cliente']), asyncHandler(selectPostulacion));
router.post('/:id/presupuesto', authMiddleware(['profesional']), asyncHandler(createPresupuesto));
router.post('/:id/presupuesto/:presupuestoId/responder', authMiddleware(['cliente']), asyncHandler(responderPresupuesto));

export default router;
