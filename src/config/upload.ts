import multer from 'multer';
import path from 'path';
import fs from 'fs';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Memoria, no disco: el archivo original (hasta 8MB, cámara de móvil sin
// comprimir) nunca llega a escribirse tal cual — uploadPhoto lo redimensiona/
// recomprime con sharp y solo el resultado final (mucho más pequeño) se
// guarda en UPLOADS_DIR. Ver comentario completo en upload.controller.ts.
const storage = multer.memoryStorage();

const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB por foto (antes de recomprimir)
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error('Formato de imagen no permitido (solo JPEG, PNG o WEBP)'));
    }
    cb(null, true);
  },
});

export { UPLOADS_DIR };
