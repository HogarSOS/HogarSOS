import fs from 'fs/promises';
import path from 'path';
import { ArchivoSubido, TipoArchivo, UserRole } from '@prisma/client';
import { prisma } from '../config/prisma';
import { UPLOADS_DIR } from '../config/upload';

/**
 * Control de acceso y ciclo de vida de los archivos subidos (auditoría B4).
 *
 * Antes, /uploads se servía con express.static SIN autenticación, y por
 * ese mismo endpoint pasaban las fotos de una solicitud y los DOCUMENTOS
 * DE IDENTIDAD de los profesionales. Cualquiera con la URL leía un DNI
 * escaneado, para siempre y sin sesión.
 *
 * La causa raíz no era "falta un middleware": era que el sistema perdía
 * la información de QUÉ era cada archivo en el momento de escribirlo, así
 * que no podía aplicar reglas distintas ni borrar nada. Clasificar al
 * escribir (tabla `archivos_subidos`) es lo que permite verificar al leer.
 */

/** Tipos cuyo contenido identifica a una persona: solo su dueño y un admin, jamás nadie más. */
const TIPOS_SENSIBLES: ReadonlySet<TipoArchivo> = new Set<TipoArchivo>([
  'documento_identidad',
  'certificado',
  'seguro_rc',
]);

export function esArchivoSensible(tipo: TipoArchivo): boolean {
  return TIPOS_SENSIBLES.has(tipo);
}

/**
 * Solo `<uuid>.<ext>`. Cierra el path traversal (`/uploads/../../.env`)
 * antes incluso de tocar la base de datos: `path.basename` ya quita
 * cualquier componente de directorio, y este patrón descarta todo lo que
 * no tenga la forma exacta que genera `uploadPhoto`.
 */
const PATRON_NOMBRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/i;

export function normalizarNombreArchivo(entrada: string): string | null {
  const base = path.basename(entrada);
  return PATRON_NOMBRE.test(base) ? base : null;
}

export interface Visor {
  userId: string;
  role: UserRole;
}

/**
 * ¿Puede este usuario leer este archivo?
 *
 * El `default` del switch es `false` a propósito: si mañana alguien añade
 * un tipo nuevo al enum y olvida añadirlo aquí, queda CERRADO en vez de
 * abierto. Es la diferencia entre una lista blanca y una negra.
 */
export async function puedeVerArchivo(archivo: ArchivoSubido, visor: Visor): Promise<boolean> {
  // Un admin necesita ver los documentos para poder verificar a los
  // profesionales — es el motivo por el que se suben.
  if (visor.role === 'admin') return true;

  // Tu propio archivo siempre, sea del tipo que sea.
  if (archivo.propietarioId === visor.userId) return true;

  switch (archivo.tipo) {
    // Los perfiles de profesional son navegables por cualquier cliente
    // (searchProfessionals, getPublicProfile): es una foto que su dueño
    // publica a propósito para que la vean.
    case 'foto_perfil':
      return true;

    // Fotos del interior de la casa de alguien, o pruebas de una
    // reclamación: solo las dos partes de esa solicitud concreta.
    case 'foto_solicitud':
    case 'foto_disputa': {
      if (!archivo.serviceRequestId) return false;
      const solicitud = await prisma.serviceRequest.findUnique({
        where: { id: archivo.serviceRequestId },
        select: { clienteId: true, profesionalId: true },
      });
      if (!solicitud) return false;
      return solicitud.clienteId === visor.userId || solicitud.profesionalId === visor.userId;
    }

    // documento_identidad, certificado, seguro_rc: ya se resolvieron
    // arriba (propietario o admin). Llegar aquí significa que es otra
    // persona pidiendo un documento ajeno.
    default:
      return false;
  }
}

/** Registra un archivo recién escrito en disco. */
export async function registrarArchivo(params: {
  nombreArchivo: string;
  tipo: TipoArchivo;
  propietarioId: string;
  bytes: number;
}): Promise<ArchivoSubido> {
  return prisma.archivoSubido.create({ data: params });
}

/**
 * Asocia archivos ya subidos a la solicitud a la que pertenecen. Las
 * fotos se suben ANTES de que la solicitud exista (el asistente sube y
 * luego crea), así que este es el momento en que se puede saber a qué
 * pertenecen — y sin esa asociación no hay forma de comprobar después si
 * quien pide la foto es participante.
 *
 * Best-effort a propósito: que una foto no quede asociada no debe
 * impedir crear la solicitud. El coste de fallar es que esa foto solo la
 * vea su propietario, no que se filtre.
 */
export async function asociarArchivosASolicitud(
  urls: string[],
  serviceRequestId: string,
  tipo: TipoArchivo
): Promise<void> {
  const nombres = urls
    .map((u) => normalizarNombreArchivo(u))
    .filter((n): n is string => n !== null);
  if (nombres.length === 0) return;

  await prisma.archivoSubido
    .updateMany({
      where: { nombreArchivo: { in: nombres } },
      data: { serviceRequestId, tipo },
    })
    .catch((e) => console.error(`[archivo.service] No se pudieron asociar archivos a ${serviceRequestId}:`, e));
}

/**
 * Marca para borrado todos los archivos de un usuario. Se llama al
 * eliminar la cuenta (RGPD Art. 17): antes solo se ponía la URL a NULL
 * en la BD y el JPEG del DNI seguía en el disco de Render para siempre.
 *
 * Borrado LÓGICO aquí y físico en la tarea programada: así el borrado de
 * cuenta responde al instante y un fallo de disco no deja la operación a
 * medias ni bloquea al usuario. Devuelve cuántos se han marcado.
 */
export async function marcarArchivosDeUsuarioParaBorrado(propietarioId: string): Promise<number> {
  const { count } = await prisma.archivoSubido.updateMany({
    where: { propietarioId, eliminadoAt: null },
    data: { eliminadoAt: new Date() },
  });
  return count;
}

/** Borra un fichero del disco. Que no exista no es un error: el objetivo es que no esté. */
export async function borrarDelDisco(nombreArchivo: string): Promise<boolean> {
  const seguro = normalizarNombreArchivo(nombreArchivo);
  if (!seguro) return false;

  try {
    await fs.unlink(path.join(UPLOADS_DIR, seguro));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    console.error(`[archivo.service] No se pudo borrar ${seguro} del disco:`, e);
    return false;
  }
}

export interface ResultadoLimpieza {
  borradosMarcados: number;
  huerfanosBorrados: number;
  fallos: number;
}

/**
 * Limpieza de disco. Dos categorías, ambas necesarias:
 *
 * 1. Archivos marcados como eliminados (cuenta borrada): se quitan del
 *    disco y su fila desaparece. Esto es lo que cierra de verdad el
 *    RGPD Art. 17.
 * 2. HUÉRFANOS: ficheros en disco sin ninguna fila que los describa.
 *    Son subidas abandonadas (alguien subió su DNI y no llegó a enviar
 *    el formulario). No se pueden clasificar, así que ya son
 *    inaccesibles vía HTTP — pero seguir guardando el DNI de alguien
 *    "por si acaso" es exactamente lo que el RGPD llama conservación
 *    sin base legal.
 *
 * `edadMinimaMs` protege de una carrera real: un fichero recién escrito
 * cuya fila todavía no se ha creado (o cuyo formulario el usuario está
 * rellenando ahora mismo) parecería huérfano. Con 24h de margen eso no
 * puede pasar.
 */
export async function limpiarArchivos(edadMinimaMs = 24 * 60 * 60 * 1000): Promise<ResultadoLimpieza> {
  const resultado: ResultadoLimpieza = { borradosMarcados: 0, huerfanosBorrados: 0, fallos: 0 };

  // --- 1. Los marcados para borrado ---
  const marcados = await prisma.archivoSubido.findMany({
    where: { eliminadoAt: { not: null } },
    take: 500,
  });

  for (const archivo of marcados) {
    if (await borrarDelDisco(archivo.nombreArchivo)) {
      await prisma.archivoSubido.delete({ where: { id: archivo.id } }).catch(() => undefined);
      resultado.borradosMarcados++;
    } else {
      resultado.fallos++;
    }
  }

  // --- 2. Los huérfanos ---
  let enDisco: string[];
  try {
    enDisco = await fs.readdir(UPLOADS_DIR);
  } catch (e) {
    console.error('[archivo.service] No se pudo listar el directorio de subidas:', e);
    return resultado;
  }

  const corte = Date.now() - edadMinimaMs;

  for (const nombre of enDisco) {
    if (!normalizarNombreArchivo(nombre)) continue; // .gitkeep y demás

    const ruta = path.join(UPLOADS_DIR, nombre);
    let stat;
    try {
      stat = await fs.stat(ruta);
    } catch {
      continue;
    }
    if (stat.mtimeMs > corte) continue; // demasiado reciente, podría estar en uso

    const fila = await prisma.archivoSubido.findUnique({ where: { nombreArchivo: nombre } });
    if (fila) continue;

    console.warn(`[archivo.service] Huérfano sin clasificar borrado: ${nombre}`);
    if (await borrarDelDisco(nombre)) resultado.huerfanosBorrados++;
    else resultado.fallos++;
  }

  return resultado;
}
