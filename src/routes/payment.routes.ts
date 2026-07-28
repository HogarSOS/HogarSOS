import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { createPaymentIntent } from '../controllers/payment.controller';

const router = Router();

// Nota: la ruta del webhook de Stripe (/api/payments/webhook) se monta
// directamente en index.ts con un body parser distinto (raw, no JSON),
// necesario para verificar la firma de Stripe. No se define aquí.
router.post('/intent', authMiddleware(['cliente']), asyncHandler(createPaymentIntent));

export default router;
