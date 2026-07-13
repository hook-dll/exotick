import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { UPLOADS_DIR } from '../db';
import { requireRole } from '../auth/middleware';

// Raster formats only. SVG is excluded because it's an XML document that can
// carry <script>; /uploads/* is served from the same origin as the app, so a
// hostile SVG would run as stored XSS in any teammate's browser.
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext) && ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else {
      const err = new Error('Only PNG, JPG, GIF, or WebP images are allowed');
      (err as any).status = 400; // let the central error handler return a clean 400 JSON
      cb(err);
    }
  },
});

const router = Router();

router.post('/', requireRole('editor'), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

export default router;
