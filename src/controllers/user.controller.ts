import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { firebaseAuth } from '../config/firebase';
import { stripe } from '../config/stripe';
import { marcarArchivosDeUsuarioParaBorrado } from '../services/archivo.service';

function serializarUsuario(usuario: {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  fotoPerfilUrl: string | null;
  role: string;
  valoracionMedia: unknown;
  totalValoraciones: number;
}) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    telefono: usuario.telefono,
    fotoPerfilUrl: usuario.fotoPerfilUrl,
    role: usuario.role,
    valoracionMedia: Number(usuario.valoracionMedia),
    totalValoraciones: usuario.totalValoraciones,
  };
}

/**
 * Perfil genérico del usuario autenticado — vale para cualquier rol.
 * El perfil de profesional (oficio, tarifa, verificación...) sigue
 * viviendo aparte en professional.controller.ts; esto es solo lo común
 * a todos: nombre, email, teléfono, foto, valoración recibida (como
 * cliente que contrata, o como profesional — ver review.controller.ts,
 * que actualiza estos mismos campos sea cual sea el rol).
 */
export async function getMe(req: Request, res: Response) {
  const userId = req.user!.userId;

  const usuario = await prisma.user.findUnique({ where: { id: userId } });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
  }

  return res.json(serializarUsuario(usuario));
}

const updateMeSchema = z.object({
  nombre: z.string().min(2).max(150).optional(),
  telefono: z.string().max(30).optional(),
  fotoPerfilUrl: z.string().url().optional(),
});

/**
 * El email NO se puede editar aquí a propósito: está atado a la
 * identidad de Firebase Auth (ver auth.controller.ts) — cambiarlo
 * necesitaría un flujo de re-verificación que no existe todavía.
 */
export async function updateMe(req: Request, res: Response) {
  const userId = req.user!.userId;
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', code: 'VALIDATION_INVALID', detalles: parsed.error.flatten() });
  }

  const usuario = await prisma.user.update({ where: { id: userId }, data: parsed.data });

  return res.json(serializarUsuario(usuario));
}

/**
 * Elimina la cuenta del usuario autenticado (BLOQUE 4, 2026-08-03:
 * requisito de la política de datos de Google Play desde abril de
 * 2024 — cualquier app que permite crear cuenta DEBE ofrecer también
 * una vía para eliminarla, tanto dentro de la app como por un enlace
 * web; ver legal.routes.ts para la página pública). No se puede
 * "pausar" ni desactivar temporalmente en su lugar, tiene que ser un
 * borrado real.
 *
 * No se hace DELETE físico de la fila `User`: hay reseñas, solicitudes
 * de servicio y pagos que la referencian, necesarios para el historial
 * del OTRO lado de cada relación (el cliente/profesional con el que
 * trabajó) y, en el caso de los pagos, para la contabilidad. En su
 * lugar se anonimizan los datos personales (nombre, email, teléfono,
 * foto, documentos de verificación si es profesional) y se desactiva
 * la cuenta — cumple con el borrado de datos personales exigido sin
 * romper la integridad referencial ni el historial de otros usuarios.
 * El usuario de Firebase Auth SÍ se borra por completo (ya no podrá
 * volver a iniciar sesión con esas credenciales).
 */
export async function deleteMe(req: Request, res: Response) {
  const userId = req.user!.userId;

  const usuario = await prisma.user.findUnique({ where: { id: userId } });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
  }

  if (usuario.firebaseUid) {
    try {
      await firebaseAuth.deleteUser(usuario.firebaseUid);
    } catch (e) {
      // Si el usuario de Firebase ya no existe (ej. borrado manual
      // previo), seguimos igualmente con el borrado de nuestro lado —
      // el objetivo es que la cuenta quede eliminada, no que falle
      // aquí por un estado que ya estaba a medias.
      console.error(`[user.deleteMe] No se pudo borrar el usuario de Firebase (${usuario.firebaseUid}) para ${userId}:`, e);
    }
  }

  // Auditoría de cierre (2026-08-13): el Customer de Stripe
  // (obtenerOCrearStripeCustomerId, payment.service.ts) se crea con
  // nombre/email/teléfono reales y nunca se tocaba desde aquí — una
  // cuenta "eliminada" seguía con su PII completa visible en el
  // dashboard de Stripe indefinidamente. No se borra el Customer
  // (customers.del): igual que con la fila de User, hace falta que
  // siga existiendo para la integridad de los pagos ya hechos
  // (PaymentIntents/Charges lo referencian). Se anonimiza igual que
  // Postgres, no se inventa una política nueva.
  if (usuario.stripeCustomerId) {
    try {
      await stripe.customers.update(usuario.stripeCustomerId, {
        name: 'Usuario eliminado',
        email: '',
        phone: '',
      });
    } catch (e) {
      console.error(`[user.deleteMe] No se pudo anonimizar el Customer de Stripe (${usuario.stripeCustomerId}) para ${userId}:`, e);
    }
  }

  // RGPD Art. 17 (auditoría B4). Antes esto solo ponía las URLs a NULL en
  // la base de datos: el JPEG del documento de identidad seguía en el
  // disco de Render, servido públicamente en su URL, para siempre. Es
  // decir, se le decía al usuario que sus datos estaban borrados cuando
  // su DNI seguía accesible.
  //
  // Borrado LÓGICO aquí (marca `eliminadoAt`) y físico en la tarea
  // programada `limpiar-archivos-huerfanos`: así el borrado de cuenta
  // responde al instante y un fallo de disco no deja la operación a
  // medias. En cuanto se marca, `servirArchivo` ya devuelve 404 — el
  // acceso se corta de inmediato, no cuando pase la tarea.
  const archivosMarcados = await marcarArchivosDeUsuarioParaBorrado(userId);
  console.log(`[user.deleteMe] ${archivosMarcados} archivo(s) de ${userId} marcados para borrado.`);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        nombre: 'Usuario eliminado',
        email: null,
        telefono: null,
        fotoPerfilUrl: null,
        firebaseUid: null,
        fcmToken: null,
        activo: false,
      },
    });

    // El perfil de profesional guarda datos aún más sensibles (documento
    // de identidad, certificados, seguro de responsabilidad civil) —
    // se limpian igual, y se apaga la disponibilidad para que deje de
    // aparecer en cualquier búsqueda.
    if (usuario.role === 'profesional') {
      await tx.professional.update({
        where: { userId },
        data: {
          documentoIdentidadUrl: null,
          certificadosUrl: [],
          seguroRcUrl: null,
          fotoPerfilUrl: null,
          descripcion: null,
          disponible: false,
        },
      });
    }
  });

  return res.json({ success: true });
}

/**
 * Valoraciones recibidas por el usuario autenticado — vale tanto para
 * un cliente (valorado por profesionales) como para un profesional
 * (aunque este último normalmente las ve desde su propio perfil de
 * profesional, ver professional.controller.ts::getProfile).
 */
export async function getMisValoraciones(req: Request, res: Response) {
  const userId = req.user!.userId;

  const reviews = await prisma.review.findMany({
    where: { destinatarioId: userId },
    include: { autor: { select: { nombre: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return res.json({
    opiniones: reviews.map((r) => ({
      autor: r.autor.nombre,
      puntuacion: r.puntuacion,
      comentario: r.comentario,
      fecha: r.createdAt,
    })),
  });
}
