import { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { UPLOADS_DIR } from '../config/upload';

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
 * Se guarda en disco local bajo /uploads (servido como estático desde
 * index.ts), en el disco persistente de Render (no en el filesystem
 * efímero del contenedor — hay un Persistent Disk montado ahí, así que
 * sí sobrevive a redeploys/reinicios). Antes de un crecimiento serio de
 * tráfico real, sigue siendo recomendable migrar a un storage dedicado +
 * CDN (ver docs/migracion_storage_cdn.md) — un único disco de un único
 * servidor no escala si algún día hay más de una instancia del backend.
 */
export async function uploadPhoto(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo', code: 'UPLOAD_NO_FILE' });
  }

  const nombreArchivo = `${crypto.randomUUID()}.jpg`;
  const rutaDestino = path.join(UPLOADS_DIR, nombreArchivo);

  try {
    const buffer = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
      .toBuffer();
    await fs.writeFile(rutaDestino, buffer);
  } catch (e) {
    console.error('[uploadPhoto] Error al procesar la imagen con sharp:', e);
    return res.status(400).json({ error: 'No se pudo procesar la imagen', code: 'UPLOAD_INVALID_IMAGE' });
  }

  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const url = `${appBaseUrl}/uploads/${nombreArchivo}`;

  return res.status(201).json({ url });
}
