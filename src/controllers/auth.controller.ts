import { Request, Response } from 'express';
import { z } from 'zod';
import { firebaseAuth } from '../config/firebase';
import { prisma } from '../config/prisma';
import { enviarEmail } from '../services/email.service';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from '../services/token.service';

/**
 * Flujo de autenticación de hogarSOS:
 * 1. El cliente (app Flutter) se autentica directamente contra Firebase
 *    Auth (Google, Apple, email/password) y obtiene un "ID token".
 * 2. Ese ID token se envía aquí en /register o /login.
 * 3. El backend lo verifica con Firebase Admin, y emite SU PROPIO
 *    par de tokens (access + refresh) para autorizar el resto de la API.
 *    Esto mantiene la lógica de roles y permisos fuera de Firebase.
 */

const registerSchema = z.object({
  firebaseIdToken: z.string().min(1),
  nombre: z.string().min(2).max(150),
  telefono: z.string().optional(),
  role: z.enum(['cliente', 'profesional']), // el rol admin nunca se auto-registra
});

const loginSchema = z.object({
  firebaseIdToken: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function register(req: Request, res: Response) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const { firebaseIdToken, nombre, telefono, role } = parsed.data;

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(firebaseIdToken);
  } catch (e) {
    console.error('[auth.register] Token de Firebase inválido:', e);
    return res.status(401).json({ error: 'Token de Firebase inválido', code: 'AUTH_FIREBASE_TOKEN_INVALID' });
  }

  // El token de Firebase trae email (registro con email/contraseña) O
  // phone_number (registro con teléfono/SMS) — nunca ninguno de los dos
  // a la vez, según cómo se autenticó en el cliente. `telefono` del
  // body es el campo de contacto opcional del formulario de email; si
  // el registro fue por SMS, el número YA verificado por Firebase
  // manda sobre cualquier cosa que viniera en el body.
  const email = decoded.email ?? null;
  const telefonoVerificado = decoded.phone_number ?? telefono ?? null;

  if (!email && !telefonoVerificado) {
    return res.status(400).json({ error: 'El token de Firebase no contiene ni email ni número de teléfono', code: 'AUTH_FIREBASE_TOKEN_NO_CONTACT' });
  }

  // ÚNICO punto de todo el backend que decide "ya existe": busca por
  // firebaseUid (el mismo usuario de Firebase intentando registrarse
  // dos veces), por email o por teléfono ya usados por OTRA cuenta. Si
  // esto devuelve un 409, hay una fila real en tu base de datos ahora
  // mismo que choca — no hay otra ruta de código que produzca este
  // mensaje. Log explícito para que quede constancia en el servidor.
  const condicionesExistente: Array<{ firebaseUid: string } | { email: string } | { telefono: string }> = [
    { firebaseUid: decoded.uid },
  ];
  if (email) condicionesExistente.push({ email });
  if (telefonoVerificado) condicionesExistente.push({ telefono: telefonoVerificado });

  const existente = await prisma.user.findFirst({ where: { OR: condicionesExistente } });
  if (existente) {
    console.log(
      `[auth.register] 409: ya existe fila en Postgres para email=${email} telefono=${telefonoVerificado} ` +
      `(id=${existente.id}, creado=${existente.createdAt.toISOString()}, firebaseUid=${existente.firebaseUid})`
    );
    return res.status(409).json({
      error: 'Ya existe un usuario en la base de datos de Hogar SOS con este email o teléfono', code: 'AUTH_USER_ALREADY_EXISTS',
    });
  }

  // user.create + professional.create en una única transacción: si el
  // segundo insert falla, el primero también se revierte. Antes eran
  // dos llamadas independientes — un fallo en la creación del
  // profesional dejaba una fila huérfana en `users`, y esa fila
  // huérfana SÍ haría que un reintento posterior con el mismo email
  // devolviera este mismo 409, aunque el registro nunca se hubiera
  // completado realmente desde el punto de vista del usuario.
  let nuevoUsuario;
  try {
    nuevoUsuario = await prisma.$transaction(async (tx) => {
      const usuario = await tx.user.create({
        data: {
          email,
          nombre,
          telefono: telefonoVerificado,
          role,
          firebaseUid: decoded.uid,
        },
      });

      if (role === 'profesional') {
        await tx.professional.create({
          data: {
            userId: usuario.id,
            documentoIdentidadUrl: null, // opcional — se puede aportar en el flujo de verificación posterior
            tarifaBase: 0,
          },
        });
      }

      return usuario;
    });
  } catch (e) {
    console.error('[auth.register] Fallo al crear usuario/profesional en la transacción:', e);
    throw e; // lo captura asyncHandler → errorHandler global, no queda colgado
  }

  console.log(`[auth.register] Usuario creado correctamente: id=${nuevoUsuario.id}, email=${nuevoUsuario.email}, role=${nuevoUsuario.role}`);

  const payload = { userId: nuevoUsuario.id, role: nuevoUsuario.role };

  return res.status(201).json({
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
    usuario: { id: nuevoUsuario.id, nombre: nuevoUsuario.nombre, role: nuevoUsuario.role },
  });
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(parsed.data.firebaseIdToken);
  } catch (e) {
    console.error('[auth.login] Token de Firebase inválido:', e);
    return res.status(401).json({ error: 'Token de Firebase inválido', code: 'AUTH_FIREBASE_TOKEN_INVALID' });
  }

  const usuario = await prisma.user.findUnique({ where: { firebaseUid: decoded.uid } });

  if (!usuario) {
    console.log(`[auth.login] No existe fila en Postgres para firebaseUid=${decoded.uid} (email=${decoded.email})`);
    return res.status(404).json({ error: 'No existe una cuenta asociada. Regístrate primero.', code: 'AUTH_NO_ACCOUNT' });
  }

  if (!usuario.activo) {
    return res.status(403).json({ error: 'Esta cuenta ha sido desactivada', code: 'AUTH_ACCOUNT_DISABLED' });
  }

  const payload = { userId: usuario.id, role: usuario.role };

  return res.json({
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
    usuario: { id: usuario.id, nombre: usuario.nombre, role: usuario.role },
  });
}

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

/**
 * BUG 001 (QA, 2026-08-03): "el email llega, la contraseña se cambia
 * correctamente, pero después no permite iniciar sesión con la nueva
 * contraseña". La causa real era la página de Firebase (un solo campo,
 * sin "confirmar contraseña" — ver passwordReset.routes.ts). La
 * solución iba a ser configurar la "URL de acción personalizada" en
 * Firebase Console para que el email de Firebase apuntara a nuestra
 * propia página, pero la consola devuelve un error interno al guardar
 * ese ajuste (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, HTTP 400 en
 * identitytoolkit.clients6.google.com — reproducido varias veces,
 * ajeno a este código). Por eso este endpoint evita ese ajuste por
 * completo: generamos el enlace con el Admin SDK, nos quedamos solo
 * con el oobCode (lo único que de verdad valida Identity Toolkit — el
 * dominio que lo aloja es irrelevante) y enviamos NOSOTROS el email
 * con nuestra propia página como destino, por el SMTP de IONOS ya
 * configurado (soporte@hogarsos.es).
 */
export async function forgotPassword(req: Request, res: Response) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Introduce un email válido', code: 'VALIDATION_INVALID' });
  }

  const { email } = parsed.data;

  // AUDITORÍA (Bloque 4, 2026-08-03): la respuesta es SIEMPRE la misma
  // — {success:true} — exista o no una cuenta con este email, y tanto
  // si el envío del correo triunfa como si falla. Antes devolvía un
  // código distinto (ej. 'user-not-found') según el caso, lo que
  // permitía a cualquiera enumerar qué emails tienen cuenta en
  // hogarSOS probando este endpoint sin autenticación. El detalle real
  // solo se registra en el log del servidor, nunca en la respuesta.
  try {
    const link = await firebaseAuth.generatePasswordResetLink(email);
    const oobCode = new URL(link).searchParams.get('oobCode');
    if (!oobCode) {
      throw new Error('Enlace de Firebase sin oobCode');
    }

    const enlacePropio = `https://hogarsos.es/auth/reset-password?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`;

    await enviarEmail(
      email,
      'Restablece tu contraseña de Hogar SOS',
      `<p>Hola,</p>
       <p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de Hogar SOS.</p>
       <p><a href="${enlacePropio}">Restablecer mi contraseña</a></p>
       <p>Si no has pedido este cambio, puedes ignorar este correo.</p>
       <p>Equipo de Hogar SOS</p>`
    );
  } catch (e) {
    const codigoFirebase = (e as { code?: string })?.code?.replace('auth/', '');
    // 'user-not-found' no es un error de verdad aquí — es el caso
    // esperado de que el email no tiene cuenta, y no se distingue del
    // éxito real en la respuesta. Cualquier otro fallo si se registra
    // como tal, para poder detectarlo en los logs.
    if (codigoFirebase !== 'user-not-found') {
      console.error(`[auth.forgotPassword] Fallo al procesar la recuperación para ${email}:`, e);
    }
  }

  return res.json({ success: true });
}

const fcmTokenSchema = z.object({
  fcmToken: z.string().min(1),
});

/**
 * Guarda (o reemplaza) el token FCM del dispositivo actual. Se llama
 * cada vez que la app arranca con sesión activa — no solo al hacer
 * login — porque Firebase puede rotar el token del dispositivo en
 * cualquier momento, y un token viejo sin actualizar es indistinguible
 * de "no llegan notificaciones" para quien usa la app.
 */
export async function updateFcmToken(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = fcmTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta fcmToken', code: 'AUTH_FCM_TOKEN_MISSING' });
  }

  await prisma.user.update({ where: { id: userId }, data: { fcmToken: parsed.data.fcmToken } });
  return res.json({ success: true });
}

const idiomaSchema = z.object({
  idioma: z.enum(['es', 'en']),
});

/**
 * Guarda el idioma preferido del dispositivo actual, para poder enviar
 * las notificaciones push en ese idioma (ver
 * `services/notification.service.ts` e `i18n/notifications.ts`). Se
 * llama en el mismo momento que updateFcmToken de arriba — tras
 * login/registro y al restaurar sesión al arrancar — a partir del
 * locale del sistema que ya resuelve MaterialApp en el frontend, no de
 * una preferencia manual (la app no tiene selector de idioma propio).
 */
export async function updateIdioma(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = idiomaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta idioma válido (es/en)', code: 'AUTH_IDIOMA_INVALID' });
  }

  await prisma.user.update({ where: { id: userId }, data: { idioma: parsed.data.idioma } });
  return res.json({ success: true });
}

export async function refreshToken(req: Request, res: Response) {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta el refreshToken', code: 'AUTH_REFRESH_TOKEN_MISSING' });
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken);

    // Se revalida que el usuario siga existiendo y activo antes de
    // emitir un nuevo access token (por si fue desactivado entretanto).
    const usuario = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!usuario || !usuario.activo) {
      return res.status(403).json({ error: 'Usuario no válido', code: 'AUTH_USER_INVALID' });
    }

    return res.json({
      accessToken: generateAccessToken({ userId: usuario.id, role: usuario.role }),
    });
  } catch (e) {
    console.error('[auth.refreshToken] Refresh token inválido o expirado:', e);
    return res.status(401).json({ error: 'Refresh token inválido o expirado', code: 'AUTH_REFRESH_TOKEN_INVALID' });
  }
}
