import { Request, Response } from 'express';
import path from 'path';

/**
 * Sube una foto para una solicitud de servicio. Se guarda en disco
 * local bajo /uploads (servido como estático desde index.ts) y se
 * devuelve la URL pública.
 *
 * ⚠️ Nota de producción: el almacenamiento en disco local NO sobrevive
 * a un reinicio/redeploy en la mayoría de plataformas de hosting
 * (Render, Railway, Heroku, etc. tienen sistema de archivos efímero).
 * Es una implementación real y funcional para desarrollo/pruebas, pero
 * antes de producción real se recomienda migrar a un storage persistente
 * (S3, Cloudinary, Google Cloud Storage...) — no se hizo aquí porque no
 * hay credenciales de ningún proveedor cloud configuradas en el proyecto,
 * y añadir una dependencia externa sin credenciales reales no es un
 * endpoint "compatible con la arquitectura existente", sería inventar
 * infraestructura que no existe.
 */
export async function uploadPhoto(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo' });
  }

  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const url = `${appBaseUrl}/uploads/${path.basename(req.file.filename)}`;

  return res.status(201).json({ url });
}
