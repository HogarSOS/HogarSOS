import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import {
  listPendingVerifications,
  approveProfessional,
  listDisputes,
  resolveDispute,
  listStuckPayments,
  retryPaymentRelease,
  listJobs,
  runJob,
  getUserForAdmin,
  toggleUserActive,
} from '../controllers/admin.controller';

const router = Router();

router.get('/verifications/pending', authMiddleware(['admin']), asyncHandler(listPendingVerifications));
router.patch('/verifications/:professionalId/approve', authMiddleware(['admin']), asyncHandler(approveProfessional));
router.get('/disputes', authMiddleware(['admin']), asyncHandler(listDisputes));
router.patch('/disputes/:id/resolve', authMiddleware(['admin']), asyncHandler(resolveDispute));

// Cola de reintento de pagos (auditoría B2). Antes no existía ninguna
// vía en producto para recuperar un pago atascado entre la captura y la
// transferencia — solo el dashboard de Stripe a mano.
router.get('/payments/stuck', authMiddleware(['admin']), asyncHandler(listStuckPayments));
router.post('/payments/:serviceRequestId/retry', authMiddleware(['admin']), asyncHandler(retryPaymentRelease));

// Tareas programadas (ver src/jobs/). El listado sirve para comprobar que
// el reintento automático corre de verdad; el POST fuerza una pasada sin
// esperar al siguiente ciclo.
router.get('/jobs', authMiddleware(['admin']), asyncHandler(listJobs));
router.post('/jobs/:nombre/run', authMiddleware(['admin']), asyncHandler(runJob));

// Bloquear/activar usuarios (Bloque 3 del panel admin). No es un listado
// general (no existe todavía) — solo localizar por ID y cambiar su
// estado, ambos protegidos exclusivamente para admin.
router.get('/users/:id', authMiddleware(['admin']), asyncHandler(getUserForAdmin));
router.patch('/users/:id/toggle-active', authMiddleware(['admin']), asyncHandler(toggleUserActive));

export default router;
