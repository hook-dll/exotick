import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';
import { writeEvent, libraryById } from '../eventLog';

const router = Router();

// Listing libraries is library CONTENT, so it's gated to runner+ (admin,
// editor, runner): a runner needs the catalog to pick a library when
// composing. Watchers are excluded — they only ever see current runs and
// history, never the library list. (Run rows still carry their own
// library_name via a server-side join, so watcher read screens are unaffected.)
// Mutations below are editor+.
router.get('/', requireRole('runner'), (_req, res) => {
  const rows = db.prepare(
    'SELECT id, name, order_index, created_at FROM libraries ORDER BY order_index, id'
  ).all();
  res.json({ libraries: rows });
});

// Everything below (create / rename / delete / reorder) is editor+.
router.use(requireRole('editor'));

const MAX_NAME_LEN = 60;
const normalizeName = (n: unknown): string | null =>
  typeof n === 'string' && n.trim().length > 0 && n.trim().length <= MAX_NAME_LEN ? n.trim() : null;

router.post('/', (req, res) => {
  const name = normalizeName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: `Name required (1-${MAX_NAME_LEN} chars).` });
  }

  const maxOrder = (db.prepare('SELECT MAX(order_index) as max FROM libraries').get() as any)?.max ?? -1;
  const result = db.prepare(
    'INSERT INTO libraries (name, order_index) VALUES (?, ?)'
  ).run(name, maxOrder + 1);
  const row = db.prepare('SELECT id, name, order_index, created_at FROM libraries WHERE id = ?').get(Number(result.lastInsertRowid)) as any;
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: { id: row.id, name: row.name } });
  res.status(201).json(row);
});

// PUT /reorder must come before PUT /:id to avoid 'reorder' matching as an id.
router.put('/reorder', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });

  const update = db.prepare('UPDATE libraries SET order_index = ? WHERE id = ?');
  transaction(() => {
    (ids as number[]).forEach((id, index) => update.run(index, id));
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username });
  res.json({ ok: true });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const name = normalizeName(req.body?.name);
  if (!name) return res.status(400).json({ error: `Name required (1-${MAX_NAME_LEN} chars).` });

  const result = db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name, id);
  if (result.changes === 0) return res.status(404).json({ error: 'Library not found' });
  const row = db.prepare('SELECT id, name, order_index, created_at FROM libraries WHERE id = ?').get(id) as any;
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: { id: row.id, name: row.name } });
  res.json(row);
});

// Delete a library. Refuses in two cases:
//   1. Any test_run still references it — user should archive/delete those
//      runs first. This is the guard the FK's ON DELETE RESTRICT catches
//      if the app-layer check is somehow bypassed.
//   2. It's the last remaining library — the app needs at least one
//      container for sections/cases to live in.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  // Grab the name BEFORE deletion so the log entry stays informative
  // ("Library Samples3") even though the row is about to disappear.
  const target = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(id) as any;
  if (!target) return res.status(404).json({ error: 'Library not found' });

  const total = (db.prepare('SELECT COUNT(*) as n FROM libraries').get() as any).n;
  if (total <= 1) {
    return res.status(409).json({ error: 'Cannot delete the last library — at least one must exist.' });
  }

  const runCount = (db.prepare('SELECT COUNT(*) as n FROM test_runs WHERE library_id = ?').get(id) as any).n;
  if (runCount > 0) {
    return res.status(409).json({
      error: `Cannot delete: ${runCount} test run${runCount === 1 ? '' : 's'} still reference${runCount === 1 ? 's' : ''} this library. Delete those runs first.`,
      runCount,
    });
  }

  // sections + test_cases cascade via the FK; the library row itself is
  // removed here. Wrapped in a transaction so a failure mid-cascade doesn't
  // leave the DB half-migrated.
  transaction(() => {
    db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
  });
  // The library row is gone now, so we must NOT reference its id — that would
  // violate the event_log.library_id FK. Log with a null id but keep the name
  // so the entry stays readable (per the event_log design).
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: { id: null, name: target.name } });
  res.status(204).send();
});

export default router;
