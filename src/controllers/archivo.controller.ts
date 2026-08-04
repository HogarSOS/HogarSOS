import { Request, Response } from 'express';
import path from 'path';
import { prisma } from '../config/prisma';
import { UPLOADS_DIR } from '../config/upload';
import { esArchivoSensible, normalizarNombreArchivo, puedeVerArchivo } from '../services/archivo.service';

/**
 * Único camino de lectura hacia el disco (auditoría B4). Sustituye a
 * `express.static('/uploads')`, que servía sin ninguna autenticación
 * tanto las fotos de una solicitud como los documentos de identidad de
 * los profesionales.
 *
 * La ruta NO cambia (`/uploads/<uuid>.jpg`): así ninguna de las URLs ya
 * guardadas en la base de datos hay que reescribirla — que era la parte
 * que sí podía romper datos históricos. Lo único que cambia es que ahora
 * hace falta sesión y permiso.
 */
export async function servirArchivo(req: Request, res: Response) {
  const visor = req.user!;

  // Se valida ANTES de tocar la base de datos: `path.basename` quita
  // cualquier componente de directorio y el patrón exige la forma exacta
  // `<uuid>.<ext>`, así que `/uploads/..%2f..%2f.env` no llega ni a
  // consultarse.
  const nombreArchivo = normalizarNombreArchivo(req.params.archivo ?? '');
  if (!nombreArchivo) {
    return res.status(404).json({ error: 'Archivo no encontrado', code: 'FILE_NOT_FOUND' });
  }

  const archivo = await prisma.archivoSubido.findUnique({ where: { nombreArchivo } });

  // Sin fila no se puede saber qué es, y sin saber qué es no se puede
  // autorizar. Los ficheros anteriores a esta tabla se registraron en la
  // migración de backfill; los que quedan sin fila son subidas
  // abandonadas sin clasificar, y para esas 404 es la respuesta correcta.
  if (!archivo || archivo.eliminadoAt) {
    return res.status(404).json({ error: 'Archivo no encontrado', code: 'FILE_NOT_FOUND' });
  }

  if (!(await puedeVerArchivo(archivo, visor))) {
    // 404 y no 403 en los sensibles: un 403 confirmaría a un tercero que
    // ese documento existe, que ya es información de más.
    if (esArchivoSensible(archivo.tipo)) {
      console.warn(
        `[servirArchivo] Acceso denegado a ${archivo.tipo} ${nombreArchivo} por parte de ${visor.userId} (propietario: ${archivo.propietarioId}).`
      );
      return res.status(404).json({ error: 'Archivo no encontrado', code: 'FILE_NOT_FOUND' });
    }
    return res.status(403).json({ error: 'No tienes acceso a este archivo', code: 'FILE_FORBIDDEN' });
  }

  // Un documento de identidad no debe quedarse en ninguna caché: ni en
  // un proxy intermedio, ni en el disco del navegador de quien lo vio.
  // Las fotos normales sí se cachean (privadas al usuario) porque se
  // repintan constantemente en listas.
  res.setHeader(
    'Cache-Control',
    esArchivoSensible(archivo.tipo) ? 'private, no-store, max-age=0' : 'private, max-age=86400'
  );

  return res.sendFile(path.join(UPLOADS_DIR, nombreArchivo), (err) => {
    if (!err || res.headersSent) return;
    console.error(`[servirArchivo] La fila ${archivo.id} existe pero el fichero no se pudo leer:`, err);
    res.status(404).json({ error: 'Archivo no encontrado', code: 'FILE_NOT_FOUND' });
  });
}
