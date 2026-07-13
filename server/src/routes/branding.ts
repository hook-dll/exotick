import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db, { DATA_DIR } from '../db';
import { requireAuth, requireRole } from '../auth/middleware';

// data/branding/ holds the currently-active custom logo. Served publicly at
// /branding/<file> so the login page can render it before the user has a
// session. We store the current filename in the settings table.
const BRANDING_DIR = path.join(DATA_DIR, 'branding');
if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });

// SVG is intentionally excluded — it's an XML document that can carry
// <script>, and this file is served from the same origin as the app on the
// (unauthenticated) login page. An admin uploading a hostile SVG would ship
// stored XSS to every visitor. Raster formats only.
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_NAME_LEN = 40;

const upload = multer({
  storage: multer.diskStorage({
    destination: BRANDING_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `logo-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext) && ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else {
      const err = new Error('Only PNG, JPG, or WebP images are allowed');
      (err as any).status = 400; // central error handler → clean 400 JSON
      cb(err as any);
    }
  },
});

const NAME_KEY = 'app_name';
const LOGO_KEY = 'app_logo_file';

function getBranding() {
  const name = (db.prepare('SELECT value FROM settings WHERE key = ?').get(NAME_KEY) as any)?.value ?? null;
  const logoFile = (db.prepare('SELECT value FROM settings WHERE key = ?').get(LOGO_KEY) as any)?.value ?? null;
  return {
    name: typeof name === 'string' ? name : null,
    logoUrl: typeof logoFile === 'string' && logoFile ? `/branding/${logoFile}` : null,
  };
}

function currentLogoFile(): string | null {
  const v = (db.prepare('SELECT value FROM settings WHERE key = ?').get(LOGO_KEY) as any)?.value;
  return typeof v === 'string' && v ? v : null;
}

function unlinkLogo(filename: string | null): void {
  if (!filename) return;
  try {
    const abs = path.join(BRANDING_DIR, filename);
    // Defense in depth — refuse to delete anything outside BRANDING_DIR.
    if (!abs.startsWith(BRANDING_DIR + path.sep) && abs !== BRANDING_DIR) return;
    fs.unlinkSync(abs);
  } catch { /* file already gone — fine */ }
}

const router = Router();

// GET is intentionally public: the login screen renders the brand before
// the user has any session.
router.get('/', (_req, res) => {
  res.json(getBranding());
});

// POST is admin-only. Multer parses multipart/form-data so name arrives as
// a text field and logo as a file. Optional `clearLogo=true` removes the
// current logo without uploading a new one.
router.post('/', requireAuth, requireRole('admin'), upload.single('logo'), (req, res) => {
  const body = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const clearLogo = body.clearLogo === 'true' || body.clearLogo === '1';

  if (hasName) {
    const raw = typeof body.name === 'string' ? body.name.trim() : '';
    if (raw.length > MAX_NAME_LEN) {
      // Clean up any uploaded file since we're not going to commit.
      if (req.file) unlinkLogo(req.file.filename);
      return res.status(400).json({ error: `Name must be ${MAX_NAME_LEN} characters or fewer` });
    }
    if (raw === '') {
      db.prepare('DELETE FROM settings WHERE key = ?').run(NAME_KEY);
    } else {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(NAME_KEY, raw);
    }
  }

  if (req.file) {
    const previous = currentLogoFile();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(LOGO_KEY, req.file.filename);
    if (previous && previous !== req.file.filename) unlinkLogo(previous);
  } else if (clearLogo) {
    const previous = currentLogoFile();
    db.prepare('DELETE FROM settings WHERE key = ?').run(LOGO_KEY);
    unlinkLogo(previous);
  }

  res.json(getBranding());
});

export { BRANDING_DIR };
export default router;
