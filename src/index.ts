import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import serviceRequestRoutes from './routes/serviceRequest.routes';
import professionalRoutes from './routes/professional.routes';
import paymentRoutes from './routes/payment.routes';
import adminRoutes from './routes/admin.routes';
import categoryRoutes from './routes/category.routes';
import reviewRoutes from './routes/review.routes';
import uploadRoutes from './routes/upload.routes';
import legalRoutes, { paginaInicio } from './routes/legal.routes';
import stripeOnboardingRoutes from './routes/stripeOnboarding.routes';
import passwordResetRoutes from './routes/passwordReset.routes';
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

// Detrás del proxy de Render, sin esto Express ve todas las peticiones
// como si vinieran de la IP interna del proxy en vez de la IP real del
// cliente -- express-rate-limit (que usa req.ip) trataría entonces a
// TODOS los usuarios como un único cliente, compartiendo un mismo
// límite de 200 peticiones/15min entre todo el mundo.
app.set('trust proxy', 1);

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

// Comprime toda respuesta JSON (gzip) — antes cada búsqueda de
// profesionales, lista de solicitudes, etc. viajaba sin comprimir.
// Solo afecta al cuerpo de la RESPUESTA, no a cómo se parsea el
// cuerpo de la petición — no interfiere con express.raw() del
// webhook de Stripe, que necesita el body crudo de la petición
// entrante, algo completamente distinto.
app.use(compression());

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

// Health Check — registrado antes del rate limiter a propósito: Render
// hace ping a este endpoint constantemente y, si comparte el límite de
// 200 peticiones/15min con el resto del tráfico, puede recibir 429 y
// Render entiende eso como "backend caído" y reinicia el servicio.
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    server: 'hogarSOS',
    timestamp: new Date().toISOString(),
  });
});

// Rate limit — 200/15min se agotaba solo con el sondeo de
// SeguimientoSolicitudScreen (una petición GET /:id cada 5s = 180 en
// 15 minutos desde una única pantalla abierta), dejando casi ningún
// margen para el resto de la app: cualquier acción real del cliente o
// profesional (postularse, ver candidatos, borrar...) podía recibir
// 429 y parecer "roto" sin ningún error explícito. 2000 deja margen
// de sobra para varios testers/pantallas activas a la vez sin dejar
// de proteger contra abuso.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
  })
);

// Ruta principal — página de inicio pública de hogarsos.es, no solo un
// texto plano (ver paginaInicio en legal.routes.ts).
app.get('/', (_req, res) => {
  res.status(200).send(paginaInicio());
});

// Fotos subidas por los clientes (ver upload.controller.ts) — servidas
// como archivos estáticos directamente.
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Favicon + imagen de vista previa (og-image) de la página web pública
// — mismo patrón que /uploads: process.cwd() y no __dirname, porque
// tsc no copia public/ a dist/ y en producción el proceso arranca
// desde la raíz del repo.
app.use('/public', express.static(path.join(process.cwd(), 'public')));

// Páginas legales públicas — en la raíz (no bajo /api) para que la URL
// final sea hogarsos.es/privacidad, la que se pone en las fichas de
// Google Play / App Store, no algo bajo la ruta de la API.
app.use('/', legalRoutes);

// Retorno del onboarding hospedado de Stripe Connect (accountLinks.create
// en professional.controller.ts) — en la raíz, no bajo /api, porque
// return_url/refresh_url los abre un navegador externo sin sesión de la
// app, igual que las páginas legales de arriba.
app.use('/stripe/onboarding', stripeOnboardingRoutes);

// Página propia de restablecer contraseña — sustituye a la página
// genérica de Firebase (sin campo de "confirmar contraseña", causa
// real del BUG 001 de QA: un simple error de tecleo pasaba
// desapercibido). Configurado como "URL de acción" en Firebase Console
// → Authentication → Plantillas → Restablecer contraseña.
app.use('/auth/reset-password', passwordResetRoutes);

// API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
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
    error: 'Ruta no encontrada', code: 'ROUTE_NOT_FOUND',
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
      code: 'INTERNAL_ERROR',
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
