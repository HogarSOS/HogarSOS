import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';

import authRoutes from './routes/auth.routes';
import serviceRequestRoutes from './routes/serviceRequest.routes';
import professionalRoutes from './routes/professional.routes';
import paymentRoutes from './routes/payment.routes';
import adminRoutes from './routes/admin.routes';
import categoryRoutes from './routes/category.routes';
import reviewRoutes from './routes/review.routes';
import uploadRoutes from './routes/upload.routes';
import { stripeWebhook } from './controllers/payment.controller';
import { asyncHandler } from './utils/asyncHandler';

dotenv.config();

// Sin esto, un error async no capturado en cualquier controlador mata
// el proceso de Node completo (Node 15+, incluido tu Node 22 lo hace
// por defecto). Log en vez de crash silencioso.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Seguridad
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

// CORS
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Stripe Webhook (debe ir antes de express.json())
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  asyncHandler(stripeWebhook)
);

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Log de peticiones — antes no existía ninguno, lo que hacía imposible
// distinguir "el móvil no llega al backend" de "llega pero responde con
// error", ambos indistinguibles desde la app. Solo consola, sin
// dependencia nueva.
app.use((req, res, next) => {
  const inicio = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio}ms)`);
  });
  next();
});

// Rate limit
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
  })
);

// Ruta principal
app.get('/', (_req, res) => {
  res.status(200).send('hogarSOS API funcionando');
});

// Health Check
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    server: 'hogarSOS',
    timestamp: new Date().toISOString(),
  });
});

// Fotos subidas por los clientes (ver upload.controller.ts) — servidas
// como archivos estáticos directamente.
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// API
app.use('/api/auth', authRoutes);
app.use('/api/service-categories', categoryRoutes);
app.use('/api/service-requests', serviceRequestRoutes);
app.use('/api/professionals', professionalRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/uploads', uploadRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada',
    message: 'Ruta no encontrada',
  });
});

// Error global — antes solo devolvía `message`, pero todos los
// controladores (register/login/etc.) devuelven `error`. El frontend
// (Dio) lee específicamente el campo `error`. Ahora se devuelven
// ambos para que ningún error caído aquí se muestre como "undefined"
// en la app.
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(`[${new Date().toISOString()}] Error en ${req.method} ${req.path}:`, err);

    const mensaje = err?.message || 'Error interno del servidor';

    res.status(err.status || 500).json({
      success: false,
      error: mensaje,
      message: mensaje,
    });
  }
);

// Escuchar en todas las interfaces
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log(`🚀 hogarSOS API iniciada`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🌐 http://0.0.0.0:${PORT}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log('========================================');
});
