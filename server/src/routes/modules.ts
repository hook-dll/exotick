import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';
import { writeEvent, libraryById, libraryForModule } from '../eventLog';

const router = Router();

// GET /?library_id=N — list a library's modules (id + name + order + counts).
// Gated to runner+ like sections/libraries: a runner needs the module list to
// pick cases when composing. The full section/case tree grouped by module is
// served by GET /api/sections; this endpoint is the flat module catalog.
router.get('/', requireRole('runner'), (req, res) => {
  const libraryId = Number(req.query.library_id);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'library_id query param is required' });
  }
  if (!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId)) {
    return res.status(404).json({ error: 'Library not found' });
  }
  const modules = db.prepare(
    'SELECT id, name, order_index, library_id, created_at FROM modules WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId);
  res.json({ modules });
});

// Everything below requires editor+.
router.use(requireRole('editor'));

const MAX_NAME_LEN = 60;
const normalizeName = (n: unknown): string | null =>
  typeof n === 'string' && n.trim().length > 0 && n.trim().length <= MAX_NAME_LEN ? n.trim() : null;

function requireLibrary(libraryId: number): boolean {
  return !!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId);
}

router.post('/', (req, res) => {
  const name = normalizeName(req.body?.name);
  if (!name) return res.status(400).json({ error: `Name required (1-${MAX_NAME_LEN} chars).` });
  const libraryId = Number(req.body?.library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }
  const afterId = req.body?.after_id;

  try {
    let moduleId = 0;
    transaction(() => {
      let order_index: number;
      if (afterId != null) {
        const after = db.prepare('SELECT order_index FROM modules WHERE id = ? AND library_id = ?').get(afterId, libraryId) as any;
        if (!after) throw new Error('MODULE_NOT_FOUND');
        order_index = after.order_index + 1;
        db.prepare('UPDATE modules SET order_index = order_index + 1 WHERE library_id = ? AND order_index >= ?').run(libraryId, order_index);
      } else {
        const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM modules WHERE library_id = ?').get(libraryId) as any;
        order_index = (maxOrder?.max ?? -1) + 1;
      }
      const result = db.prepare(
        'INSERT INTO modules (name, order_index, library_id) VALUES (?, ?, ?)'
      ).run(name, order_index, libraryId);
      moduleId = Number(result.lastInsertRowid);
    });
    const module = db.prepare('SELECT id, name, order_index, library_id, created_at FROM modules WHERE id = ?').get(moduleId);
    writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
    res.status(201).json(module);
  } catch (e: any) {
    if (e?.message === 'MODULE_NOT_FOUND') return res.status(404).json({ error: 'after_id module not found in this library' });
    throw e;
  }
});

// PUT /reorder before PUT /:id so 'reorder' isn't matched as an id.
router.put('/reorder', (req, res) => {
  const { ids, library_id } = req.body ?? {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId)) return res.status(400).json({ error: 'library_id required' });

  const update = db.prepare('UPDATE modules SET order_index = ? WHERE id = ? AND library_id = ?');
  transaction(() => {
    (ids as number[]).forEach((id, index) => update.run(index, id, libraryId));
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true });
});

router.put('/:id', (req, res) => {
  const name = normalizeName(req.body?.name);
  if (!name) return res.status(400).json({ error: `Name required (1-${MAX_NAME_LEN} chars).` });
  const result = db.prepare('UPDATE modules SET name = ? WHERE id = ?').run(name, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryForModule(req.params.id) });
  res.json(db.prepare('SELECT id, name, order_index, library_id, created_at FROM modules WHERE id = ?').get(req.params.id));
});

// Delete a module. Its sections + cases fall back to the library root
// (module_id → NULL via ON DELETE SET NULL), NOT deleted — parallel to how
// deleting a section frees its cases to the unsectioned pile. The freed
// sections + module-level unsectioned cases are renumbered to the END of the
// root buckets so their old module-scoped order_index values don't interleave
// into the middle of whatever already sits at the root.
router.delete('/:id', (req, res) => {
  const moduleId = Number(req.params.id);
  const library = libraryForModule(req.params.id);
  const module = db.prepare('SELECT library_id FROM modules WHERE id = ?').get(moduleId) as any;
  if (!module) return res.status(404).json({ error: 'Not found' });
  const libraryId = module.library_id as number;

  transaction(() => {
    // Capture what's about to be freed, in its current display order.
    const freedSections = (db.prepare(
      'SELECT id FROM sections WHERE module_id = ? ORDER BY order_index, id'
    ).all(moduleId) as any[]).map((r) => r.id);
    const freedUnsectioned = (db.prepare(
      'SELECT id FROM test_cases WHERE module_id = ? AND section_id IS NULL ORDER BY order_index, id'
    ).all(moduleId) as any[]).map((r) => r.id);

    // Root maxes BEFORE the delete (before SET NULL folds the freed rows in).
    let secOrder = ((db.prepare(
      'SELECT MAX(order_index) as max FROM sections WHERE library_id = ? AND module_id IS NULL'
    ).get(libraryId)) as any)?.max ?? -1;
    let caseOrder = ((db.prepare(
      'SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND module_id IS NULL AND section_id IS NULL'
    ).get(libraryId)) as any)?.max ?? -1;

    db.prepare('DELETE FROM modules WHERE id = ?').run(moduleId);

    const updSec = db.prepare('UPDATE sections SET order_index = ? WHERE id = ?');
    for (const id of freedSections) updSec.run(++secOrder, id);
    const updCase = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ?');
    for (const id of freedUnsectioned) updCase.run(++caseOrder, id);
  });

  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(204).send();
});

export default router;
