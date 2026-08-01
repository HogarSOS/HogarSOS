import { Request, Response } from 'express';
import { z } from 'zod';
import { firebaseAuth } from '../config/firebase';
import { prisma } from '../config/prisma';
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
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const { firebaseIdToken, nombre, telefono, role } = parsed.data;

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(firebaseIdToken);
  } catch (e) {
    console.error('[auth.register] Token de Firebase inválido:', e);
    return res.status(401).json({ error: 'Token de Firebase inválido' });
  }

  if (!decoded.email) {
    return res.status(400).json({ error: 'El token de Firebase no contiene un email' });
  }

  // ÚNICO punto de todo el backend que decide "ya existe": busca por
  // email en la tabla `users` de Postgres. Si esto devuelve un 409,
  // es porque hay una fila real con ese email en tu base de datos en
  // este momento — no hay otra ruta de código que pueda producir este
  // mensaje. Log explícito para que quede constancia en el servidor.
  const existente = await prisma.user.findUnique({ where: { email: decoded.email } });
  if (existente) {
    console.log(
      `[auth.register] 409: ya existe fila en Postgres para email=${decoded.email} ` +
      `(id=${existente.id}, creado=${existente.createdAt.toISOString()}, firebaseUid=${existente.firebaseUid})`
    );
    return res.status(409).json({
      error: 'Ya existe un usuario en la base de datos de hogarSOS con este email',
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
          email: decoded.email as string,
          nombre,
          telefono,
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
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(parsed.data.firebaseIdToken);
  } catch (e) {
    console.error('[auth.login] Token de Firebase inválido:', e);
    return res.status(401).json({ error: 'Token de Firebase inválido' });
  }

  const usuario = await prisma.user.findUnique({ where: { firebaseUid: decoded.uid } });

  if (!usuario) {
    console.log(`[auth.login] No existe fila en Postgres para firebaseUid=${decoded.uid} (email=${decoded.email})`);
    return res.status(404).json({ error: 'No existe una cuenta asociada. Regístrate primero.' });
  }

  if (!usuario.activo) {
    return res.status(403).json({ error: 'Esta cuenta ha sido desactivada' });
  }

  const payload = { userId: usuario.id, role: usuario.role };

  return res.json({
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
    usuario: { id: usuario.id, nombre: usuario.nombre, role: usuario.role },
  });
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
    return res.status(400).json({ error: 'Falta fcmToken' });
  }

  await prisma.user.update({ where: { id: userId }, data: { fcmToken: parsed.data.fcmToken } });
  return res.json({ success: true });
}

export async function refreshToken(req: Request, res: Response) {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta el refreshToken' });
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken);

    // Se revalida que el usuario siga existiendo y activo antes de
    // emitir un nuevo access token (por si fue desactivado entretanto).
    const usuario = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!usuario || !usuario.activo) {
      return res.status(403).json({ error: 'Usuario no válido' });
    }

    return res.json({
      accessToken: generateAccessToken({ userId: usuario.id, role: usuario.role }),
    });
  } catch (e) {
    console.error('[auth.refreshToken] Refresh token inválido o expirado:', e);
    return res.status(401).json({ error: 'Refresh token inválido o expirado' });
  }
}
