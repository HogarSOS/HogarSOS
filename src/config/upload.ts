import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const nombreUnico = `${crypto.randomUUID()}${path.extname(file.originalname)}`;
    cb(null, nombreUnico);
  },
});

const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB por foto
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error('Formato de imagen no permitido (solo JPEG, PNG o WEBP)'));
    }
    cb(null, true);
  },
});
