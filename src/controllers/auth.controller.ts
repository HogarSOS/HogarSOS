import { Request, Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
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

/**
 * Construye la respuesta de tokens de un registro — usada tanto en el
 * camino de creación normal como en los dos caminos idempotentes de
 * abajo (P2 #6), para no repetir tres veces la misma forma de payload.
 */
function respuestaTokensRegistro(usuario: { id: string; nombre: string; role: UserRole; sessionVersion: number }) {
  const payload = { userId: usuario.id, role: usuario.role };
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken({ ...payload, sessionVersion: usuario.sessionVersion }),
    usuario: { id: usuario.id, nombre: usuario.nombre, role: usuario.role },
  };
}

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
  // dos veces), por email o por teléfono ya usados por OTRA cuenta.
  const condicionesExistente: Array<{ firebaseUid: string } | { email: string } | { telefono: string }> = [
    { firebaseUid: decoded.uid },
  ];
  if (email) condicionesExistente.push({ email });
  if (telefonoVerificado) condicionesExistente.push({ telefono: telefonoVerificado });

  const existente = await prisma.user.findFirst({ where: { OR: condicionesExistente } });
  if (existente) {
    // P2 #6: si coincide por firebaseUid, es la MISMA identidad de
    // Firebase reintentando /register — lo más probable es que un
    // intento anterior ya creó esta fila y la respuesta se perdió (red,
    // cold start de Render, fallo al guardar localmente...) antes de
    // llegar al cliente. Tratarlo como un 409 dejaría al usuario sin
    // cuenta utilizable: Firebase ya existe, Postgres ya existe, pero
    // no tiene forma de entrar. Éxito idempotente: no se crea nada
    // nuevo, se reemiten los mismos tokens que un registro normal.
    if (existente.firebaseUid === decoded.uid) {
      // Mismo control que ya hace login(): una cuenta desactivada no
      // puede recibir tokens nuevos por ninguna vía, ni siquiera la de
      // reintento idempotente — sin esto, un reintento de /register
      // tras la desactivación se saltaría por completo ese control.
      if (!existente.activo) {
        return res.status(403).json({ error: 'Esta cuenta ha sido desactivada', code: 'AUTH_ACCOUNT_DISABLED' });
      }
      console.log(`[auth.register] Reintento idempotente: firebaseUid=${decoded.uid} ya tiene fila (id=${existente.id}) — se reemiten tokens sin crear nada nuevo.`);
      return res.status(200).json(respuestaTokensRegistro(existente));
    }

    // Coincide por email/teléfono pero con OTRO firebaseUid: es una
    // identidad de Firebase distinta intentando usar un contacto ya
    // registrado por otra cuenta — conflicto real, no un reintento.
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
  } catch (e: any) {
    // P2 #6: carrera de dos /register simultáneos con el MISMO
    // firebaseUid — el findFirst de arriba pudo no ver todavía la fila
    // que el otro request está a punto de confirmar. El perdedor choca
    // aquí contra UNIQUE(firebase_uid), la garantía final en BD. Un
    // único intento de relectura: si la fila que ganó la carrera es
    // justo esta misma identidad, se resuelve con el mismo éxito
    // idempotente de arriba. Si no corresponde (ej. chocó por email con
    // OTRA identidad) o no aparece, se propaga el error tal cual — sin
    // más reintentos.
    if (e?.code === 'P2002') {
      const ganador = await prisma.user.findUnique({ where: { firebaseUid: decoded.uid } });
      if (ganador) {
        if (!ganador.activo) {
          return res.status(403).json({ error: 'Esta cuenta ha sido desactivada', code: 'AUTH_ACCOUNT_DISABLED' });
        }
        console.log(`[auth.register] P2002 en create resuelto por relectura: firebaseUid=${decoded.uid} ya existe (id=${ganador.id}).`);
        return res.status(200).json(respuestaTokensRegistro(ganador));
      }
    }
    console.error('[auth.register] Fallo al crear usuario/profesional en la transacción:', e);
    throw e; // lo captura asyncHandler → errorHandler global, no queda colgado
  }

  console.log(`[auth.register] Usuario creado correctamente: id=${nuevoUsuario.id}, email=${nuevoUsuario.email}, role=${nuevoUsuario.role}`);

  return res.status(201).json(respuestaTokensRegistro(nuevoUsuario));
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
    refreshToken: generateRefreshToken({ ...payload, sessionVersion: usuario.sessionVersion }),
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

const passwordResetCompletedSchema = z.object({
  idToken: z.string().min(1),
});

/**
 * A-03 (auditoría adversarial 2026-08-17): el canje del oobCode en
 * `/auth/reset-password` ocurre ÍNTEGRAMENTE en el navegador contra
 * Identity Toolkit — este backend nunca se enteraba de que una
 * contraseña cambió. Efecto: si alguien tenía la sesión abierta con la
 * cuenta comprometida, la conservaba hasta 30 días (la duración del
 * refresh token) DESPUÉS de que la víctima "recuperara" su cuenta,
 * porque nada tocaba `sessionVersion`.
 *
 * Sin autenticar a propósito — el usuario que llama todavía no tiene
 * sesión de hogarSOS, solo el idToken que Identity Toolkit le acaba de
 * dar tras iniciar sesión con la contraseña nueva (ver
 * passwordReset.routes.ts). La verificación de ese idToken con el Admin
 * SDK es la única autorización que necesita: nadie puede fabricar un
 * idToken válido de Firebase para un uid ajeno.
 */
export async function passwordResetCompleted(req: Request, res: Response) {
  const parsed = passwordResetCompletedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID' });
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(parsed.data.idToken);
  } catch (e) {
    console.error('[auth.passwordResetCompleted] Token de Firebase inválido:', e);
    return res.status(401).json({ error: 'Token de Firebase inválido', code: 'AUTH_FIREBASE_TOKEN_INVALID' });
  }

  // Igual que en forgotPassword: la respuesta no distingue si había o no
  // una cuenta de hogarSOS para ese uid, para no dar pie a enumeración.
  await prisma.user
    .update({
      where: { firebaseUid: decoded.uid },
      data: { sessionVersion: { increment: 1 } },
    })
    .catch((e) => {
      console.error(`[auth.passwordResetCompleted] Sin cuenta de hogarSOS para uid ${decoded.uid}:`, e?.code ?? e);
    });

  return res.json({ success: true });
}

const fcmTokenSchema = z.object({
  fcmToken: z.string().min(1),
  // Opcional durante la transición (P2 #5): una app todavía no
  // actualizada no lo manda. 'legacy' agrupa esas instalaciones bajo
  // un installationId sintético — en cuanto ESA instalación real
  // vuelva a llamar con su propio installationId, la lógica de abajo
  // reclama el token y sustituye la fila legacy sola.
  installationId: z.string().min(1).optional(),
});

/**
 * Guarda (o reemplaza) el token FCM de la instalación actual — una
 * fila por (usuario, instalación), no una por usuario (P2 #5: un solo
 * fcmToken por usuario se pisaba silenciosamente entre dispositivos, y
 * podía quedar compartido entre dos cuentas en un dispositivo
 * reutilizado sin reinstalar). Se llama cada vez que la app arranca
 * con sesión activa — no solo al hacer login — porque Firebase puede
 * rotar el token en cualquier momento.
 *
 * Transacción en dos pasos, la BD (no la lógica de aplicación) es la
 * garantía final de unicidad vía UNIQUE(token):
 * 1. Cede el token si pertenece a OTRO par (userId, installationId) —
 *    cierra el caso de un dispositivo compartido/reutilizado que
 *    cambia de cuenta sin reinstalar, y el caso legacy de arriba.
 * 2. Upsert por (userId, installationId) — la identidad de la fila es
 *    el par, el token es mutable dentro de ella: una rotación de
 *    Firebase actualiza la MISMA fila, nunca crea una segunda.
 *
 * Un solo reintento de la transacción COMPLETA ante P2002 (revisión
 * adversarial P2 #5): el `upsert` compila a `INSERT ... ON CONFLICT
 * (user_id, installation_id) DO UPDATE`, cuyo target de conflicto es
 * ese par — no `token`. Si dos (userId, installationId) DISTINTOS
 * reclaman el MISMO token a la vez sin que ninguno tenga fila previa
 * que ceder (caso límite, no el de dispositivo compartido — ese
 * siempre tiene una fila previa y no pasa por aquí), el perdedor choca
 * contra UNIQUE(token) con un P2002 no cubierto por ese ON CONFLICT.
 * Para el reintento, la fila ganadora ya está confirmada y visible, así
 * que el `deleteMany` la encuentra y la cede por la vía normal — no
 * hace falta ninguna lógica nueva, solo repetir la operación entera.
 */
export async function updateFcmToken(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = fcmTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Falta fcmToken', code: 'AUTH_FCM_TOKEN_MISSING' });
  }

  const { fcmToken: token } = parsed.data;
  const installationId = parsed.data.installationId ?? 'legacy';

  // Sin transacción interactiva a propósito (auditoría de escalabilidad
  // 2026-08-17): `prisma.$transaction(async tx => ...)` retenía UNA
  // conexión del pool durante los ~4 round-trips de BEGIN+deleteMany+
  // upsert+COMMIT. Este endpoint se dispara en CADA apertura de la app
  // (registrarToken, fire-and-forget), así que bajo una ráfaga de
  // aperturas masiva las transacciones no conseguían conexión dentro del
  // `maxWait` de Prisma y devolvían 500 — MEDIDO: 219 errores 5xx en un
  // burst de 1.000 usuarios con pool=5, mientras que las lecturas solo
  // encolaban. Ahora son DOS sentencias autocommit independientes: cada
  // una toma y suelta una conexión al instante, sin retener el pool.
  //
  // Se conserva el ORDEN delete-primero y el reintento P2002: la columna
  // `token` es UNIQUE, así que hay que ceder el token de cualquier otra
  // fila ANTES de hacer el upsert de la nuestra (si no, el upsert choca
  // con UNIQUE(token)). Sin la transacción hay una ventana de carrera
  // mínima entre ambas sentencias — exactamente el caso que el retry
  // P2002 ya cubría: si otra petición reinserta el token en medio, el
  // upsert lanza P2002 y se reintenta la pareja una vez.
  const reclamarToken = async () => {
    await prisma.userFcmToken.deleteMany({
      where: { token, NOT: { userId, installationId } },
    });
    await prisma.userFcmToken.upsert({
      where: { userId_installationId: { userId, installationId } },
      update: { token },
      create: { userId, installationId, token },
    });
  };

  try {
    await reclamarToken();
  } catch (err: any) {
    if (err?.code !== 'P2002') {
      throw err;
    }
    await reclamarToken(); // único reintento; si vuelve a fallar, se propaga tal cual
  }

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

    // P2 #4: un refresh token emitido antes de un logout lleva la
    // versión de sesión de ese momento — si no coincide con la actual,
    // la sesión fue cerrada y el token ya no sirve. `?? 0` es
    // deliberado: un refresh token emitido ANTES de que existiera este
    // campo (todo el parque de sesiones reales en el momento de
    // desplegar este cambio) no lo lleva, y debe seguir funcionando con
    // normalidad hasta el primer logout real de ese usuario — sin este
    // fallback, el despliegue desconectaría de golpe a todos los
    // usuarios con sesión activa en ese instante.
    if ((payload.sessionVersion ?? 0) !== usuario.sessionVersion) {
      return res.status(401).json({ error: 'Refresh token inválido o expirado', code: 'AUTH_REFRESH_TOKEN_INVALID' });
    }

    return res.json({
      accessToken: generateAccessToken({ userId: usuario.id, role: usuario.role }),
    });
  } catch (e) {
    console.error('[auth.refreshToken] Refresh token inválido o expirado:', e);
    return res.status(401).json({ error: 'Refresh token inválido o expirado', code: 'AUTH_REFRESH_TOKEN_INVALID' });
  }
}

const logoutSchema = z.object({
  // Opcional a propósito (P2 #5, y compatibilidad con clientes que
  // todavía no lo mandan): sin él, se sigue revocando la sesión entera
  // vía sessionVersion, simplemente no se borra ningún UserFcmToken.
  installationId: z.string().min(1).optional(),
});

/**
 * Revoca todas las sesiones del usuario (todo-o-nada, P2 #4): el
 * access token vigente sigue funcionando hasta que expire solo (máx.
 * 15 min, decisión de producto — no se comprueba por petición), pero
 * cualquier refresh token ya emitido deja de servir en el siguiente
 * /refresh porque su sessionVersion queda desfasada. `increment`
 * atómico a propósito: dos logouts casi simultáneos (doble tap, dos
 * pestañas) dan el mismo resultado final sin importar el orden, sin
 * necesitar un findUnique+update separado.
 *
 * P2 #5: además borra el UserFcmToken de ESTA instalación concreta
 * (identificada por installationId, no por el usuario) — así el
 * dispositivo deslogueado deja de recibir push de inmediato, sin
 * esperar a que otro evento lo reclame. `deleteMany` (no `delete`)
 * porque es válido que la instalación nunca hubiera registrado push
 * (permiso denegado, o logout antes de que registrarToken() terminara)
 * — cero filas afectadas no es un error. El `where` va por
 * (userId, installationId): nunca puede coincidir con la fila de otro
 * dispositivo del mismo usuario, tengan el ID que tengan.
 */
export async function logout(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = logoutSchema.safeParse(req.body ?? {});
  const installationId = parsed.success ? parsed.data.installationId : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });

    if (installationId) {
      await tx.userFcmToken.deleteMany({ where: { userId, installationId } });
    }
  });

  return res.json({ success: true });
}
