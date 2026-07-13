import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import db, { transaction, UPLOADS_DIR } from '../db';
import { requireRole } from '../auth/middleware';

const router = Router();

// Export exposes a library's contents and import can wipe/replace it —
// restrict both to admin so a compromised editor account can't exfiltrate
// or overwrite.
router.use(requireRole('admin'));

const FORMAT = 'exotick-backup';
const LEGACY_FORMAT = 'testcms-backup'; // pre-rename backups still accepted on import
// v2: library-scoped (backup.json.library = { name }, sections/unsectioned inside)
// v1: whole-library (accepted on import — imported into a new library named
//     "Imported" or user-supplied)
const VERSION = 3;

// Matches every /uploads/<file> reference inside a notes string.
const UPLOAD_RE = /\/uploads\/([A-Za-z0-9._-]+)/g;

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_COUNT   = 2000;
const MAX_ENTRY_BYTES   = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES   = 500 * 1024 * 1024;

type CaseExport = { description: string; notes: string | null; order_index: number };
type SectionExport = { name: string; order_index: number; color: string | null; test_cases: CaseExport[] };

const VALID_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);

function collectImageUrls(notesList: (string | null)[]): Set<string> {
  const urls = new Set<string>();
  for (const notes of notesList) {
    if (!notes) continue;
    for (const m of notes.matchAll(UPLOAD_RE)) urls.add(m[0]);
  }
  return urls;
}

// Import scratch files go to the OS temp dir, NOT UPLOADS_DIR — the latter is
// served (auth-gated) at /uploads/*, so a temp import zip landing there was
// briefly fetchable by any authenticated user and could be orphaned there on
// a mid-import crash. The temp dir is never served.
const uploadZip = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) => cb(null, `exotick-import-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`),
  }),
  limits: { fileSize: MAX_ARCHIVE_BYTES },
});

// ── Export ──────────────────────────────────────────────────────────────────
// GET /export?library_id=N — one library at a time. Produces a .zip: backup.json
// (this library's sections + cases + notes) + uploads/<file> raw.
router.get('/export', (req, res) => {
  const libraryId = Number(req.query.library_id);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'library_id query param is required' });
  }
  const library = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId) as any;
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const sectionRows = db.prepare(
    'SELECT * FROM sections WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];

  const sections: SectionExport[] = sectionRows.map((s) => ({
    name: s.name,
    order_index: s.order_index,
    color: s.color ?? null,
    test_cases: (db.prepare(
      'SELECT description, notes, order_index FROM test_cases WHERE section_id = ? ORDER BY order_index, id'
    ).all(s.id) as any[]).map((c) => ({ description: c.description, notes: c.notes ?? null, order_index: c.order_index })),
  }));

  const unsectioned: CaseExport[] = (db.prepare(
    'SELECT description, notes, order_index FROM test_cases WHERE library_id = ? AND section_id IS NULL ORDER BY order_index, id'
  ).all(libraryId) as any[]).map((c) => ({ description: c.description, notes: c.notes ?? null, order_index: c.order_index }));

  const backup = {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    library: { name: library.name },
    sections,
    unsectioned,
  };

  const files: Record<string, Uint8Array> = {
    'backup.json': strToU8(JSON.stringify(backup, null, 2)),
  };
  const allNotes = [
    ...sections.flatMap((s) => s.test_cases.map((c) => c.notes)),
    ...unsectioned.map((c) => c.notes),
  ];
  for (const url of collectImageUrls(allNotes)) {
    const filename = path.basename(url);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    files[`uploads/${filename}`] = new Uint8Array(fs.readFileSync(filePath));
  }

  const zipped = zipSync(files, { level: 0 });
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = library.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) || 'library';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="exotick-backup-${safeName}-${stamp}.zip"`);
  res.send(Buffer.from(zipped));
});

// ── Import ────────────────────────────────────────────────────────────────
// Two modes:
//   mode=new      → create a fresh library named after backup.library.name
//                   (or the caller-supplied `name` field), stuffed with the
//                   backup's contents. Never touches existing libraries.
//   mode=merge    → target_library_id required — append the backup's
//                   sections/cases into that library. Existing rows are
//                   left alone.
//   mode=replace  → target_library_id required — wipe that library's
//                   sections + cases, then repopulate from the backup.
//                   test_run_items survive via ON DELETE SET NULL.
router.post('/import', uploadZip.single('backup'), (req, res) => {
  const tempPath = req.file?.path;
  const cleanup = () => {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch { /* already gone */ } }
  };

  const mode = req.body?.mode;
  if (mode !== 'merge' && mode !== 'replace' && mode !== 'new') {
    cleanup();
    return res.status(400).json({ error: "mode must be 'new', 'merge', or 'replace'" });
  }
  if (!tempPath) {
    return res.status(400).json({ error: 'No backup file uploaded' });
  }

  // For merge/replace, caller specifies which library to write into.
  let targetLibraryId: number | null = null;
  if (mode === 'merge' || mode === 'replace') {
    const raw = Number(req.body?.target_library_id);
    if (!Number.isInteger(raw)) {
      cleanup();
      return res.status(400).json({ error: 'target_library_id required for merge/replace' });
    }
    if (!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(raw)) {
      cleanup();
      return res.status(404).json({ error: 'target_library_id not found' });
    }
    targetLibraryId = raw;
  }

  // Zip-bomb defense MUST happen before inflation. fflate's `filter` runs per
  // entry with the uncompressed size declared in the zip header; returning
  // false means that entry is never allocated or decompressed. This defeats
  // the classic bomb (one entry declaring gigabytes) — the previous code only
  // checked sizes AFTER unzipSync had already inflated everything into memory,
  // so a 100 MB archive could OOM the process before any guard ran.
  let entries: Record<string, Uint8Array>;
  let declaredTotal = 0;
  let tooBig = false;
  let tooMany = false;
  let kept = 0;
  try {
    const raw = fs.readFileSync(tempPath);
    entries = unzipSync(new Uint8Array(raw), {
      filter: (file) => {
        if (++kept > MAX_ENTRY_COUNT) { tooMany = true; return false; }
        if (file.originalSize > MAX_ENTRY_BYTES) { tooBig = true; return false; }
        declaredTotal += file.originalSize;
        if (declaredTotal > MAX_TOTAL_BYTES) { tooBig = true; return false; }
        return true;
      },
    });
  } catch {
    cleanup();
    return res.status(400).json({ error: 'Not a valid .zip backup file' });
  }

  if (tooMany) {
    cleanup();
    return res.status(400).json({ error: 'Backup contains too many entries.' });
  }
  if (tooBig) {
    cleanup();
    return res.status(400).json({ error: 'Backup is too large to import (an entry or the total inflated size exceeds the limit).' });
  }
  // Backstop: verify the actually-inflated bytes too, in case a zip header
  // under-declared originalSize relative to the real decompressed payload.
  let totalBytes = 0;
  for (const name of Object.keys(entries)) {
    const size = entries[name].byteLength;
    if (size > MAX_ENTRY_BYTES) {
      cleanup();
      return res.status(400).json({ error: `Entry "${name}" is too large.` });
    }
    totalBytes += size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    cleanup();
    return res.status(400).json({ error: 'Backup is too large to import.' });
  }

  const manifest = entries['backup.json'];
  if (!manifest) {
    cleanup();
    return res.status(400).json({ error: 'Backup archive is missing backup.json' });
  }

  let data: any;
  try {
    data = JSON.parse(strFromU8(manifest));
  } catch {
    cleanup();
    return res.status(400).json({ error: 'backup.json is not valid JSON' });
  }
  if (data.format !== FORMAT && data.format !== LEGACY_FORMAT) {
    cleanup();
    return res.status(400).json({ error: 'Not an exotick backup file' });
  }
  if (typeof data.version !== 'number' || data.version > VERSION) {
    cleanup();
    return res.status(400).json({ error: `Unsupported backup version: ${data.version}` });
  }

  const sections: SectionExport[] = Array.isArray(data.sections) ? data.sections : [];
  const unsectioned: CaseExport[] = Array.isArray(data.unsectioned) ? data.unsectioned : [];
  const backupLibraryName: string | null =
    (data.library && typeof data.library.name === 'string' && data.library.name.trim()) || null;

  const validCase = (c: any) => c && typeof c.description === 'string' && c.description.trim().length > 0;
  for (const s of sections) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) {
      cleanup();
      return res.status(400).json({ error: 'Invalid section in backup (missing name)' });
    }
    if (!Array.isArray(s.test_cases) || !s.test_cases.every(validCase)) {
      cleanup();
      return res.status(400).json({ error: `Invalid test case in section "${s.name}"` });
    }
  }
  if (!unsectioned.every(validCase)) {
    cleanup();
    return res.status(400).json({ error: 'Invalid unsectioned test case in backup' });
  }

  // Restore images from the archive to disk (preserving basenames so note
  // references keep working). Written only if absent, so we never clobber.
  let imagesWritten = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith('uploads/')) continue;
    const filename = path.basename(name);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (path.dirname(filePath) !== UPLOADS_DIR) continue;
    if (fs.existsSync(filePath)) continue;
    try {
      fs.writeFileSync(filePath, Buffer.from(bytes));
      imagesWritten++;
    } catch {
      /* skip unwritable image, keep going */
    }
  }

  const insertSection = db.prepare('INSERT INTO sections (name, order_index, color, library_id) VALUES (?, ?, ?, ?)');
  const insertCase = db.prepare(
    'INSERT INTO test_cases (section_id, description, notes, order_index, library_id) VALUES (?, ?, ?, ?, ?)'
  );

  let sectionsAdded = 0;
  let casesAdded = 0;
  let libraryId = 0;

  transaction(() => {
    if (mode === 'new') {
      // Pick a name — prefer caller-provided, fall back to the backup's
      // recorded library name, then bump with (n) if the name is taken.
      const desired = (typeof req.body?.name === 'string' && req.body.name.trim())
        || backupLibraryName
        || 'Imported';
      const existingNames = new Set(
        (db.prepare('SELECT name FROM libraries').all() as any[]).map((r) => r.name)
      );
      let candidate = desired;
      let n = 2;
      while (existingNames.has(candidate)) candidate = `${desired} (${n++})`;

      const maxOrder = (db.prepare('SELECT MAX(order_index) as max FROM libraries').get() as any)?.max ?? -1;
      const libInfo = db.prepare('INSERT INTO libraries (name, order_index) VALUES (?, ?)').run(candidate, maxOrder + 1);
      libraryId = Number(libInfo.lastInsertRowid);
    } else {
      libraryId = targetLibraryId!;
      if (mode === 'replace') {
        // Cases first (test_run_items.test_case_id is ON DELETE SET NULL,
        // so run history keeps its snapshots), then sections. Only touches
        // rows belonging to the target library.
        db.prepare('DELETE FROM test_cases WHERE library_id = ?').run(libraryId);
        db.prepare('DELETE FROM sections WHERE library_id = ?').run(libraryId);
      }
    }

    let sectionOrder = ((db.prepare('SELECT MAX(order_index) as max FROM sections WHERE library_id = ?').get(libraryId) as any)?.max ?? -1) + 1;

    for (const s of sections) {
      const color = typeof s.color === 'string' && VALID_COLORS.has(s.color) ? s.color : null;
      const info = insertSection.run(s.name.trim(), sectionOrder++, color, libraryId);
      const sectionId = Number(info.lastInsertRowid);
      sectionsAdded++;
      s.test_cases
        .slice()
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .forEach((c, i) => {
          insertCase.run(sectionId, c.description.trim(), c.notes?.trim() || null, i, libraryId);
          casesAdded++;
        });
    }

    let unsecOrder = ((db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND section_id IS NULL').get(libraryId) as any)?.max ?? -1) + 1;
    unsectioned
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .forEach((c) => {
        insertCase.run(null, c.description.trim(), c.notes?.trim() || null, unsecOrder++, libraryId);
        casesAdded++;
      });
  });

  cleanup();
  const library = db.prepare('SELECT id, name, order_index, created_at FROM libraries WHERE id = ?').get(libraryId);
  res.json({ ok: true, mode, library, sectionsAdded, casesAdded, imagesWritten });
});

export default router;
