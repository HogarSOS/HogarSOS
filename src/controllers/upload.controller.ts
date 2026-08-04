import { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { TipoArchivo } from '@prisma/client';
import { UPLOADS_DIR } from '../config/upload';
import { registrarArchivo, borrarDelDisco } from '../services/archivo.service';

// Tope de resolución para CUALQUIER imagen subida a la app: fotos de
// solicitudes/perfil, capturas de disputas y documentos de verificación
// (documento de identidad, seguro RC) comparten este único endpoint, así
// que el valor tiene que ser conservador — 1920px de lado más largo sigue
// siendo más que suficiente para que un admin lea un documento escaneado,
// pero recorta drásticamente los 3000-4000px+ que entrega una cámara de
// móvil moderna sin comprimir.
const LADO_MAXIMO_PX = 1920;
const CALIDAD_JPEG = 82;

/**
 * Sube una foto (o documento) para la app. Antes se guardaba el archivo
 * TAL CUAL llegaba de la cámara (hasta 8MB) — la mayoría de fotos de
 * móvil actuales rondan los 3-8MB a 3000-4000px+ de lado, muchísimo más
 * de lo que cualquier pantalla de la app necesita para mostrarlas. Ahora
 * se redimensiona y recomprime con sharp antes de guardar: mismo límite
 * de entrada (8MB, en memoria, ver config/upload.ts), pero el archivo
 * final que se guarda y se sirve después a cualquiera que lo vea suele
 * pesar un 80-95% menos. `.rotate()` sin argumentos aplica la orientación
 * EXIF y la descarta (algunos móviles guardan la foto "de lado" con un
 * flag de rotación) — de paso, recodificar a JPEG limpio elimina el
 * resto de metadatos EXIF (incluida geolocalización GPS si el móvil la
 * incluía), que no hace falta conservar y es preferible no exponer.
 *
 * Se guarda en disco local bajo /uploads (servido por el endpoint
 * AUTENTICADO de archivo.controller.ts, ya no como estático — ver B4),
 * en el disco persistente de Render (no en el filesystem
 * efímero del contenedor — hay un Persistent Disk montado ahí, así que
 * sí sobrevive a redeploys/reinicios). Antes de un crecimiento serio de
 * tráfico real, sigue siendo recomendable migrar a un storage dedicado +
 * CDN (ver docs/migracion_storage_cdn.md) — un único disco de un único
 * servidor no escala si algún día hay más de una instancia del backend.
 */
/**
 * Tipos que el cliente puede declarar al subir. Se valida contra el enum
 * real: un valor desconocido no puede acabar creando una fila sin
 * clasificar (que sería inaccesible) ni, peor, con un tipo más permisivo
 * del que le toca.
 */
const TIPOS_VALIDOS = new Set<TipoArchivo>([
  'foto_perfil',
  'foto_solicitud',
  'foto_disputa',
  'documento_identidad',
  'certificado',
  'seguro_rc',
]);

/**
 * Por defecto, el tipo menos permisivo de los NO sensibles. Solo aplica a
 * clientes antiguos que no manden `tipo` (versiones de la beta anteriores
 * a B4): una foto de solicitud queda visible solo para los participantes,
 * mientras que asumir `foto_perfil` la abriría a cualquier usuario.
 * Nunca se asume un tipo sensible: un documento mal clasificado sería más
 * accesible de lo debido, y ese es justo el fallo que B4 cierra.
 */
const TIPO_POR_DEFECTO: TipoArchivo = 'foto_solicitud';

export async function uploadPhoto(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo', code: 'UPLOAD_NO_FILE' });
  }

  const tipoBruto = (req.body?.tipo ?? '') as string;
  if (tipoBruto && !TIPOS_VALIDOS.has(tipoBruto as TipoArchivo)) {
    return res.status(400).json({
      error: 'Tipo de archivo no válido',
      code: 'UPLOAD_INVALID_TYPE',
      validos: [...TIPOS_VALIDOS],
    });
  }
  const tipo: TipoArchivo = (tipoBruto as TipoArchivo) || TIPO_POR_DEFECTO;

  const nombreArchivo = `${crypto.randomUUID()}.jpg`;
  const rutaDestino = path.join(UPLOADS_DIR, nombreArchivo);

  let bytes = 0;
  try {
    const buffer = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
      .toBuffer();
    bytes = buffer.byteLength;
    await fs.writeFile(rutaDestino, buffer);
  } catch (e) {
    console.error('[uploadPhoto] Error al procesar la imagen con sharp:', e);
    return res.status(400).json({ error: 'No se pudo procesar la imagen', code: 'UPLOAD_INVALID_IMAGE' });
  }

  // La fila se crea INMEDIATAMENTE después de escribir el fichero: sin
  // ella el archivo es inaccesible (servirArchivo devuelve 404 a lo que
  // no puede clasificar). Si el registro falla, se borra el fichero para
  // no dejar un huérfano en disco — sobre todo si era un DNI.
  try {
    await registrarArchivo({ nombreArchivo, tipo, propietarioId: req.user!.userId, bytes });
  } catch (e) {
    console.error('[uploadPhoto] No se pudo registrar el archivo, se descarta el fichero:', e);
    await borrarDelDisco(nombreArchivo);
    return res.status(500).json({ error: 'No se pudo guardar el archivo', code: 'UPLOAD_REGISTER_FAILED' });
  }

  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const url = `${appBaseUrl}/uploads/${nombreArchivo}`;

  return res.status(201).json({ url, tipo });
}
