import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';
import { writeEvent, libraryById, libraryForSubModule } from '../eventLog';

const router = Router();

// GET /?library_id=N — flat list of a library's sub-modules (id, name, order,
// color, module_id). Gated to runner+ like modules/sections: a runner needs it
// to pick cases when composing. The full nested tree is served by GET
// /api/sections; this is the flat sub-module catalog.
router.get('/', requireRole('runner'), (req, res) => {
  const libraryId = Number(req.query.library_id);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'library_id query param is required' });
  }
  if (!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId)) {
    return res.status(404).json({ error: 'Library not found' });
  }
  const subModules = db.prepare(
    'SELECT id, name, order_index, color, module_id, library_id, created_at FROM sub_modules WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId);
  res.json({ subModules });
});

// Everything below requires editor+.
router.use(requireRole('editor'));

const MAX_NAME_LEN = 60;
const normalizeName = (n: unknown): string | null =>
  typeof n === 'string' && n.trim().length > 0 && n.trim().length <= MAX_NAME_LEN ? n.trim() : null;

const VALID_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
const normalizeColor = (c: unknown): string | null => (typeof c === 'string' && VALID_COLORS.has(c) ? c : null);

function requireLibrary(libraryId: number): boolean {
  return !!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId);
}

// A module_id, when provided, must belong to the same library. NULL is always
// valid (means "library root, no module").
function moduleInLibrary(moduleId: number | null, libraryId: number): boolean {
  if (moduleId === null) return true;
  return !!db.prepare('SELECT 1 FROM modules WHERE id = ? AND library_id = ?').get(moduleId, libraryId);
}

const cols = 'id, name, order_index, color, module_id, library_id, created_at';

router.post('/', (req, res) => {
  const { name, color, after_id, library_id, module_id } = req.body ?? {};
  const cleanName = normalizeName(name);
  if (!cleanName) return res.status(400).json({ error: `Name required (1-${MAX_NAME_LEN} chars).` });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }
  const moduleId = module_id ?? null;
  if (!moduleInLibrary(moduleId, libraryId)) {
    return res.status(400).json({ error: 'module_id belongs to a different library' });
  }

  try {
    let subModuleId = 0;
    transaction(() => {
      // order_index is scoped to the (library, module) bucket. `module_id IS ?`
      // matches NULL-to-NULL and value-to-value alike.
      let order_index: number;
      if (after_id != null) {
        const after = db.prepare('SELECT order_index FROM sub_modules WHERE id = ? AND library_id = ? AND module_id IS ?').get(after_id, libraryId, moduleId) as any;
        if (!after) throw new Error('SUBMODULE_NOT_FOUND');
        order_index = after.order_index + 1;
        db.prepare('UPDATE sub_modules SET order_index = order_index + 1 WHERE library_id = ? AND module_id IS ? AND order_index >= ?').run(libraryId, moduleId, order_index);
      } else {
        const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM sub_modules WHERE library_id = ? AND module_id IS ?').get(libraryId, moduleId) as any;
        order_index = (maxOrder?.max ?? -1) + 1;
      }
      const result = db.prepare(
        'INSERT INTO sub_modules (name, order_index, color, module_id, library_id) VALUES (?, ?, ?, ?, ?)'
      ).run(cleanName, order_index, normalizeColor(color), moduleId, libraryId);
      subModuleId = Number(result.lastInsertRowid);
    });
    const subModule = db.prepare(`SELECT ${cols} FROM sub_modules WHERE id = ?`).get(subModuleId);
    writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
    res.status(201).json(subModule);
  } catch (e: any) {
    if (e?.message === 'SUBMODULE_NOT_FOUND') return res.status(404).json({ error: 'after_id sub-module not found in this module' });
    throw e;
  }
});

// PUT /reorder before PUT /:id so 'reorder' isn't matched as an id. The client
// passes one bucket's ordered ids; assigning by position is bucket-agnostic.
router.put('/reorder', (req, res) => {
  const { ids, library_id } = req.body ?? {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId)) return res.status(400).json({ error: 'library_id required' });

  const update = db.prepare('UPDATE sub_modules SET order_index = ? WHERE id = ? AND library_id = ?');
  transaction(() => {
    (ids as number[]).forEach((id, index) => update.run(index, id, libraryId));
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true });
});

// Move whole sub-modules (with their sections + cases) into a module, or to the
// library root (module_id = null). Cascades module_id onto each sub-module's
// sections AND their cases to keep the invariant. Moved sub-modules append to
// the end of the destination (library, module) order, preserving relative order.
router.post('/move-module', (req, res) => {
  const { ids, library_id, module_id } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }
  const moduleId = module_id ?? null;
  if (!moduleInLibrary(moduleId, libraryId)) {
    return res.status(400).json({ error: 'module_id belongs to a different library' });
  }

  const updSub = db.prepare('UPDATE sub_modules SET module_id = ?, order_index = ? WHERE id = ? AND library_id = ?');
  const updSections = db.prepare('UPDATE sections SET module_id = ? WHERE sub_module_id = ?');
  const updCases = db.prepare('UPDATE test_cases SET module_id = ? WHERE sub_module_id = ?');
  let moved = 0;
  transaction(() => {
    const placeholders = (ids as number[]).map(() => '?').join(',');
    const ordered = db.prepare(
      `SELECT id FROM sub_modules WHERE id IN (${placeholders}) AND library_id = ? ORDER BY order_index, id`
    ).all(...(ids as number[]), libraryId) as any[];
    let order = ((db.prepare('SELECT MAX(order_index) as max FROM sub_modules WHERE library_id = ? AND module_id IS ?').get(libraryId, moduleId)) as any)?.max ?? -1;
    for (const sm of ordered) {
      moved += Number(updSub.run(moduleId, ++order, sm.id, libraryId).changes);
      updSections.run(moduleId, sm.id);
      updCases.run(moduleId, sm.id);
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true, moved });
});

// Rename and/or recolor.
router.put('/:id', (req, res) => {
  const body = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasColor = Object.prototype.hasOwnProperty.call(body, 'color');
  if (!hasName && !hasColor) return res.status(400).json({ error: 'Nothing to update' });

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (hasName) {
    const name = normalizeName(body.name);
    if (!name) return res.status(400).json({ error: `Name required (1-${MAX_NAME_LEN} chars).` });
    sets.push('name = ?'); vals.push(name);
  }
  if (hasColor) { sets.push('color = ?'); vals.push(normalizeColor(body.color)); }
  vals.push(req.params.id);

  const result = db.prepare(`UPDATE sub_modules SET ${sets.join(', ')} WHERE id = ?`).run(...vals as any);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryForSubModule(req.params.id) });
  res.json(db.prepare(`SELECT ${cols} FROM sub_modules WHERE id = ?`).get(req.params.id));
});

// Delete a sub-module. Its sections + cases fall back to the PARENT MODULE root
// (sub_module_id → NULL via ON DELETE SET NULL; module_id preserved), NOT
// deleted — parallel to how deleting a module frees its content to the library
// root. Freed sections + sub-module-level unsectioned cases are renumbered onto
// the END of the parent module's direct buckets so their old sub-module-scoped
// order_index values don't interleave.
router.delete('/:id', (req, res) => {
  const subModuleId = Number(req.params.id);
  const library = libraryForSubModule(req.params.id);
  const sm = db.prepare('SELECT library_id, module_id FROM sub_modules WHERE id = ?').get(subModuleId) as any;
  if (!sm) return res.status(404).json({ error: 'Not found' });
  const libraryId = sm.library_id as number;
  const moduleId = sm.module_id ?? null;

  transaction(() => {
    const freedSections = (db.prepare(
      'SELECT id FROM sections WHERE sub_module_id = ? ORDER BY order_index, id'
    ).all(subModuleId) as any[]).map((r) => r.id);
    const freedUnsectioned = (db.prepare(
      'SELECT id FROM test_cases WHERE sub_module_id = ? AND section_id IS NULL ORDER BY order_index, id'
    ).all(subModuleId) as any[]).map((r) => r.id);

    // Parent-module direct-bucket maxes BEFORE the delete.
    let secOrder = ((db.prepare(
      'SELECT MAX(order_index) as max FROM sections WHERE library_id = ? AND module_id IS ? AND sub_module_id IS NULL'
    ).get(libraryId, moduleId)) as any)?.max ?? -1;
    let caseOrder = ((db.prepare(
      'SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND module_id IS ? AND sub_module_id IS NULL AND section_id IS NULL'
    ).get(libraryId, moduleId)) as any)?.max ?? -1;

    db.prepare('DELETE FROM sub_modules WHERE id = ?').run(subModuleId);

    const updSec = db.prepare('UPDATE sections SET order_index = ? WHERE id = ?');
    for (const id of freedSections) updSec.run(++secOrder, id);
    const updCase = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ?');
    for (const id of freedUnsectioned) updCase.run(++caseOrder, id);
  });

  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(204).send();
});

export default router;
