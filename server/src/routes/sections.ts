import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';
import { writeEvent, libraryById, libraryForSection } from '../eventLog';

const router = Router();

// GET /?library_id=N — the library's full content tree, grouped by module.
// Gated to runner+ (admin, editor, runner): this is library CONTENT, and a
// runner needs it to pick cases when composing. Watchers are excluded — they
// see runs and history only. Caller MUST specify a library.
//
// Shape:
//   {
//     modules: [{ id, name, order_index, sections: SectionWithCases[], unsectioned: TestCase[] }],
//     sections:    SectionWithCases[],   // library root (module_id IS NULL)
//     unsectioned: TestCase[]            // library root (module_id IS NULL, section_id IS NULL)
//   }
// A module is an optional container; sections/cases with module_id NULL live
// at the root exactly as they did before modules existed.
router.get('/', requireRole('runner'), (req, res) => {
  const libraryId = Number(req.query.library_id);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'library_id query param is required' });
  }
  if (!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId)) {
    return res.status(404).json({ error: 'Library not found' });
  }

  const allSections = db.prepare(
    'SELECT * FROM sections WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];
  const caseStmt = db.prepare('SELECT * FROM test_cases WHERE section_id = ? ORDER BY order_index, id');
  const withCases = (s: any) => ({ ...s, test_cases: caseStmt.all(s.id) });

  const moduleUnsec = db.prepare(
    'SELECT * FROM test_cases WHERE library_id = ? AND module_id = ? AND section_id IS NULL ORDER BY order_index, id'
  );
  const moduleRows = db.prepare(
    'SELECT id, name, order_index, library_id, created_at FROM modules WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];
  const modules = moduleRows.map((m) => ({
    id: m.id,
    name: m.name,
    order_index: m.order_index,
    library_id: m.library_id,
    created_at: m.created_at,
    sections: allSections.filter((s) => s.module_id === m.id).map(withCases),
    unsectioned: moduleUnsec.all(libraryId, m.id),
  }));

  const sections = allSections.filter((s) => s.module_id == null).map(withCases);
  const unsectioned = db.prepare(
    'SELECT * FROM test_cases WHERE library_id = ? AND module_id IS NULL AND section_id IS NULL ORDER BY order_index, id'
  ).all(libraryId);
  res.json({ modules, sections, unsectioned });
});

// Everything below requires editor+. Anyone authenticated can still list above.
router.use(requireRole('editor'));

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

router.post('/', (req, res) => {
  const { name, color, after_id, library_id, module_id } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }
  const moduleId = module_id ?? null;
  if (!moduleInLibrary(moduleId, libraryId)) {
    return res.status(400).json({ error: 'module_id belongs to a different library' });
  }

  try {
    let sectionId = 0;
    transaction(() => {
      // order_index is scoped to the (library, module) bucket — sections in a
      // module order independently of root sections. `module_id IS ?` matches
      // NULL-to-NULL and value-to-value alike.
      let order_index: number;
      if (after_id != null) {
        const after = db.prepare('SELECT order_index FROM sections WHERE id = ? AND library_id = ? AND module_id IS ?').get(after_id, libraryId, moduleId) as any;
        if (!after) throw new Error('SECTION_NOT_FOUND');
        order_index = after.order_index + 1;
        db.prepare('UPDATE sections SET order_index = order_index + 1 WHERE library_id = ? AND module_id IS ? AND order_index >= ?').run(libraryId, moduleId, order_index);
      } else {
        const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM sections WHERE library_id = ? AND module_id IS ?').get(libraryId, moduleId) as any;
        order_index = (maxOrder?.max ?? -1) + 1;
      }
      const result = db.prepare(
        'INSERT INTO sections (name, order_index, color, library_id, module_id) VALUES (?, ?, ?, ?, ?)'
      ).run(name.trim(), order_index, normalizeColor(color), libraryId, moduleId);
      sectionId = Number(result.lastInsertRowid);
    });
    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId) as any;
    writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
    res.status(201).json({ ...section, test_cases: [] });
  } catch (e: any) {
    if (e?.message === 'SECTION_NOT_FOUND') return res.status(404).json({ error: 'after_id section not found in this module' });
    throw e;
  }
});

// PUT /reorder must come before PUT /:id. The client passes the full ordered
// list of section ids for ONE bucket (a module, or the root) — assigning
// order_index by position is bucket-agnostic since ids are unique.
router.put('/reorder', (req, res) => {
  const { ids, library_id } = req.body ?? {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId)) return res.status(400).json({ error: 'library_id required' });

  const update = db.prepare('UPDATE sections SET order_index = ? WHERE id = ? AND library_id = ?');
  transaction(() => {
    (ids as number[]).forEach((id, index) => update.run(index, id, libraryId));
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true });
});

// ── Bulk operations ──────────────────────────────────────────────────────────
// Delete many sections; their cases fall back to unsectioned WITHIN THE SAME
// MODULE (section_id → NULL via ON DELETE SET NULL, module_id preserved), and
// are renumbered to the end of that module's unsectioned pile so they don't
// interleave into the middle.
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });

  const library = ids.length > 0 ? libraryForSection((ids as number[])[0]) : null;
  const del = db.prepare('DELETE FROM sections WHERE id = ?');
  let deleted = 0;
  transaction(() => {
    const first = db.prepare('SELECT library_id FROM sections WHERE id = ?').get((ids as number[])[0]) as any;
    const libraryId = first?.library_id as number | undefined;
    // Freed cases, tagged with the module bucket they'll fall into.
    const freed: { id: number; moduleId: number | null }[] = [];
    if (libraryId != null) {
      const placeholders = (ids as number[]).map(() => '?').join(',');
      const secRows = db.prepare(
        `SELECT id, module_id FROM sections WHERE id IN (${placeholders}) ORDER BY order_index, id`
      ).all(...(ids as number[])) as any[];
      const caseStmt = db.prepare('SELECT id FROM test_cases WHERE section_id = ? ORDER BY order_index, id');
      for (const s of secRows) for (const c of caseStmt.all(s.id) as any[]) freed.push({ id: c.id, moduleId: s.module_id ?? null });
    }
    // Read each touched bucket's current max BEFORE deleting.
    const bucketMax = new Map<string, number>();
    if (libraryId != null) {
      const maxStmt = db.prepare(
        'SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND module_id IS ? AND section_id IS NULL'
      );
      for (const f of freed) {
        const key = f.moduleId === null ? 'null' : String(f.moduleId);
        if (!bucketMax.has(key)) bucketMax.set(key, ((maxStmt.get(libraryId, f.moduleId)) as any)?.max ?? -1);
      }
    }
    for (const id of ids as number[]) deleted += Number(del.run(id).changes);
    const upd = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ?');
    for (const f of freed) {
      const key = f.moduleId === null ? 'null' : String(f.moduleId);
      const next = (bucketMax.get(key) ?? -1) + 1;
      bucketMax.set(key, next);
      upd.run(next, f.id);
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.json({ ok: true, deleted });
});

// Move whole sections (with their cases) into another module, or to the
// library root (module_id = null). Cascades module_id onto each section's
// cases to keep the invariant. Moved sections append to the end of the
// destination module's section order, preserving their relative order.
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

  const updSection = db.prepare('UPDATE sections SET module_id = ?, order_index = ? WHERE id = ? AND library_id = ?');
  const updCases = db.prepare('UPDATE test_cases SET module_id = ? WHERE section_id = ?');
  let moved = 0;
  transaction(() => {
    // Preserve the relative order of the moved sections.
    const placeholders = (ids as number[]).map(() => '?').join(',');
    const ordered = db.prepare(
      `SELECT id FROM sections WHERE id IN (${placeholders}) AND library_id = ? ORDER BY order_index, id`
    ).all(...(ids as number[]), libraryId) as any[];
    let order = ((db.prepare('SELECT MAX(order_index) as max FROM sections WHERE library_id = ? AND module_id IS ?').get(libraryId, moduleId)) as any)?.max ?? -1;
    for (const s of ordered) {
      moved += Number(updSection.run(moduleId, ++order, s.id, libraryId).changes);
      updCases.run(moduleId, s.id);
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true, moved });
});

// Merge sources into a target section. All participants must be in the same
// library AND the same module (merging across modules is disallowed — the
// result would be ambiguous). Cases move into the target (order preserved);
// module_id already matches (same module), so it's left untouched.
router.post('/merge', (req, res) => {
  const { source_ids, target_id } = req.body ?? {};
  if (!Array.isArray(source_ids) || source_ids.length === 0) return res.status(400).json({ error: 'source_ids array required' });
  if (target_id == null) return res.status(400).json({ error: 'target_id required' });

  const target = db.prepare('SELECT library_id, module_id FROM sections WHERE id = ?').get(target_id) as any;
  if (!target) return res.status(404).json({ error: 'Target section not found' });

  const sources = (source_ids as number[]).filter((id) => id !== target_id);
  if (sources.length === 0) return res.status(400).json({ error: 'Nothing to merge (only the target was selected)' });

  const placeholders = sources.map(() => '?').join(',');
  const misfits = db.prepare(
    `SELECT id FROM sections WHERE id IN (${placeholders}) AND (library_id != ? OR module_id IS NOT ?)`
  ).all(...sources, target.library_id, target.module_id ?? null) as any[];
  if (misfits.length > 0) {
    return res.status(400).json({ error: 'All sections in a merge must belong to the same library and module.' });
  }

  const moveCase = db.prepare('UPDATE test_cases SET section_id = ?, order_index = ? WHERE id = ?');
  const delSection = db.prepare('DELETE FROM sections WHERE id = ?');
  let movedCases = 0;
  let mergedSections = 0;
  transaction(() => {
    let order = ((db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE section_id = ?').get(target_id)) as any)?.max ?? -1;
    for (const sid of sources) {
      const cases = db.prepare('SELECT id FROM test_cases WHERE section_id = ? ORDER BY order_index, id').all(sid) as any[];
      for (const c of cases) movedCases += Number(moveCase.run(target_id, ++order, c.id).changes);
      mergedSections += Number(delSection.run(sid).changes);
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(target.library_id) });
  res.json({ ok: true, movedCases, mergedSections });
});

router.put('/:id', (req, res) => {
  const { name, color } = req.body ?? {};
  const hasName = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'name');
  const hasColor = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'color');
  if (hasName && !name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (!hasName && !hasColor) return res.status(400).json({ error: 'Nothing to update' });

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (hasName) { sets.push('name = ?'); vals.push(name.trim()); }
  if (hasColor) { sets.push('color = ?'); vals.push(normalizeColor(color)); }
  vals.push(req.params.id);

  const result = db.prepare(`UPDATE sections SET ${sets.join(', ')} WHERE id = ?`).run(...vals as any);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryForSection(req.params.id) });
  res.json(db.prepare('SELECT * FROM sections WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const sectionId = Number(req.params.id);
  const library = libraryForSection(req.params.id);
  const section = db.prepare('SELECT library_id, module_id FROM sections WHERE id = ?').get(sectionId) as any;
  if (!section) return res.status(404).json({ error: 'Not found' });

  // Freed cases fall back to unsectioned within the SAME module (module_id is
  // unchanged; only section_id → NULL). Renumber them to the end of that
  // module's unsectioned pile. maxOrder is read BEFORE the delete.
  transaction(() => {
    const cases = db.prepare(
      'SELECT id FROM test_cases WHERE section_id = ? ORDER BY order_index, id'
    ).all(sectionId) as any[];
    let maxOrder = ((db.prepare(
      'SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND module_id IS ? AND section_id IS NULL'
    ).get(section.library_id, section.module_id ?? null)) as any)?.max ?? -1;
    db.prepare('DELETE FROM sections WHERE id = ?').run(sectionId);
    const upd = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ?');
    for (const c of cases) upd.run(++maxOrder, c.id);
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(204).send();
});

export default router;
