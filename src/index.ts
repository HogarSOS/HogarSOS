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
import { servirArchivo } from './controllers/archivo.controller';
import { authMiddleware } from './middlewares/auth.middleware';
import { prisma } from './config/prisma';
import { TAREAS, iniciarScheduler, detenerScheduler } from './jobs';
import { validarConfiguracionOAbortar } from './config/validateEnv';
import { iniciarPoolWarmer, detenerPoolWarmer } from './config/poolWarmer';
import { verificarRlsAlArrancar } from './config/verificarRls';
import { sanitizarUrlParaLog } from './utils/sanitizarUrlParaLog';

dotenv.config();

// Antes de nada: si la configuración es inconsistente, mejor no arrancar
// (auditoría B1). Va aquí, antes de abrir el puerto, para que un
// despliegue mal configurado falle en Render y mantenga en pie la
// versión anterior en vez de servir una versión que finge cobrar.
validarConfiguracionOAbortar();

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
const esProduccion = process.env.NODE_ENV === 'production';

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

// CORS — la app móvil (Dio) no está sujeta a CORS en absoluto: es un
// navegador quien lo aplica, no un cliente HTTP nativo. Lo único que
// esto protege es que una página web de OTRO dominio pueda leer
// respuestas de esta API con las credenciales del usuario. Las únicas
// páginas propias que sirve este mismo backend (legal, reset-password,
// retorno de Stripe) son same-origin y no necesitan CORS.
//
// En producción se restringe a los dominios reales (auditoría de
// cierre, 2026-08-13); fuera de producción se mantiene abierto para no
// bloquear pruebas locales con orígenes variables (emulador, distintos
// puertos, etc.).
const ORIGENES_PERMITIDOS_PRODUCCION = ['https://hogarsos.es', 'https://www.hogarsos.es'];

app.use(
  cors({
    origin: esProduccion ? ORIGENES_PERMITIDOS_PRODUCCION : true,
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
    console.log(`[req] ${req.method} ${sanitizarUrlParaLog(req.originalUrl)} -> ${res.statusCode} (${Date.now() - inicio}ms)`);
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

// Archivos subidos (auditoría B4). ANTES esto era
// `express.static(path.join(process.cwd(), 'uploads'))`, es decir:
// cualquiera con la URL leía el fichero sin sesión — y por esta MISMA
// ruta pasan los documentos de identidad y los seguros de RC de los
// profesionales, no solo fotos de cocinas.
//
// La ruta se mantiene idéntica a propósito, para no tener que reescribir
// ninguna de las URLs ya guardadas en la base de datos (que es la parte
// que sí podría romper datos históricos). Lo único que cambia es que
// ahora exige sesión y comprueba permisos según el tipo de archivo — ver
// services/archivo.service.ts.
app.get('/uploads/:archivo', authMiddleware(), asyncHandler(servirArchivo));

// Favicon + imagen de vista previa (og-image) de la página web pública.
// Este SÍ sigue siendo estático y público a propósito: son recursos de
// la web pública (hogarsos.es), no contenido subido por usuarios.
// process.cwd() y no __dirname, porque tsc no copia public/ a dist/ y en
// producción el proceso arranca desde la raíz del repo.
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
// desapercibido). El email que trae hasta aquí lo manda el propio
// backend (ver /api/auth/forgot-password), no Firebase.
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
//
// Este manejador es el último recurso: todos los errores de negocio
// esperados (solicitud no encontrada, estado inválido...) ya se
// capturan y responden dentro de cada controlador con su propio
// {status, error, code} — ver p.ej. admin.controller.ts o
// serviceRequest.controller.ts. Solo llega aquí una excepción
// verdaderamente inesperada (un error crudo de Prisma, de Stripe, un
// bug). Por eso en producción NO se reenvía `err.message` tal cual: ese
// texto puede contener detalles internos (una query, una URL de
// conexión, un stack de una librería) que no deberían salir del
// servidor. Se sigue registrando completo en el log (auditoría de
// cierre, 2026-08-13).
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(`[${new Date().toISOString()}] Error en ${req.method} ${req.path}:`, err);

    const mensaje = esProduccion
      ? 'Error interno del servidor'
      : err?.message || 'Error interno del servidor';

    res.status(err.status || 500).json({
      success: false,
      error: mensaje,
      code: 'INTERNAL_ERROR',
      message: mensaje,
    });
  }
);

// Escuchar en todas las interfaces
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log(`🚀 hogarSOS API iniciada`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🌐 http://0.0.0.0:${PORT}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log('========================================');

  // Tareas programadas (reintento de pagos atascados, autorizaciones a
  // punto de caducar — ver src/jobs/). Van dentro del propio servicio
  // web, no en un Render Cron aparte, con lock en BD para que sea seguro
  // aunque algún día haya más de una instancia (ver jobs/scheduler.ts).
  //
  // SCHEDULER_ENABLED=false permite arrancar el backend sin ellas: útil
  // en local para no tocar Stripe sin querer mientras se desarrolla otra
  // cosa.
  if (process.env.SCHEDULER_ENABLED !== 'false') {
    iniciarScheduler(TAREAS);
  } else {
    console.log('[scheduler] Desactivado por SCHEDULER_ENABLED=false');
  }

  void verificarRlsAlArrancar();

  // Mantiene las conexiones del pool de Prisma abiertas contra Supabase
  // — sin esto, la primera ráfaga de usuarios tras ~5 min de calma paga
  // la reapertura de conexiones (~3× de latencia medidos, ver
  // config/poolWarmer.ts).
  iniciarPoolWarmer();
});

/**
 * Cierre ordenado. Render manda SIGTERM en cada despliegue y en cada
 * reinicio; sin esto, las peticiones en vuelo se cortaban en seco — y
 * una petición de pago cortada a medias es justo el escenario que deja
 * dinero a medio liberar (auditoría B2).
 *
 * El orden importa: primero se para el scheduler (para no EMPEZAR
 * trabajo nuevo), después se deja de aceptar conexiones nuevas y se
 * espera a que terminen las que ya estaban, y solo al final se suelta la
 * conexión a la base de datos.
 */
let cerrando = false;

async function cerrarOrdenadamente(senal: string) {
  if (cerrando) return;
  cerrando = true;
  console.log(`[shutdown] ${senal} recibido — cerrando ordenadamente...`);

  detenerScheduler();
  detenerPoolWarmer();

  // Tope duro: si algo se queda colgado, Render mataría el proceso de
  // todas formas a los ~30s. Mejor salir nosotros antes, de forma
  // controlada y dejando constancia en el log.
  const plazo = setTimeout(() => {
    console.error('[shutdown] Las peticiones en vuelo no terminaron a tiempo. Saliendo igualmente.');
    process.exit(1);
  }, 15000);
  plazo.unref();

  server.close(async () => {
    await prisma.$disconnect().catch((e) => console.error('[shutdown] Error al desconectar Prisma:', e));
    console.log('[shutdown] Cierre completado.');
    clearTimeout(plazo);
    process.exit(0);
  });
}

process.on('SIGTERM', () => void cerrarOrdenadamente('SIGTERM'));
process.on('SIGINT', () => void cerrarOrdenadamente('SIGINT'));
