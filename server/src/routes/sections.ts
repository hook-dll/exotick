import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';
import { writeEvent, libraryById, libraryForSection } from '../eventLog';

const router = Router();

// GET /?library_id=N — list sections + unsectioned cases within one library.
// Gated to runner+ (admin, editor, runner): this is library CONTENT, and a
// runner needs it to pick cases when composing. Watchers are excluded — they
// see runs and history only. Caller MUST specify a library to keep the
// response scoped and prevent accidental cross-library mixing on the client.
router.get('/', requireRole('runner'), (req, res) => {
  const libraryId = Number(req.query.library_id);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'library_id query param is required' });
  }
  if (!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId)) {
    return res.status(404).json({ error: 'Library not found' });
  }

  const sections = db.prepare(
    'SELECT * FROM sections WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];
  const result = sections.map((section) => ({
    ...section,
    test_cases: db.prepare(
      'SELECT * FROM test_cases WHERE section_id = ? ORDER BY order_index, id'
    ).all(section.id),
  }));
  const unsectioned = db.prepare(
    'SELECT * FROM test_cases WHERE library_id = ? AND section_id IS NULL ORDER BY order_index, id'
  ).all(libraryId);
  res.json({ sections: result, unsectioned });
});

// Everything below requires editor+. Anyone authenticated can still list above.
router.use(requireRole('editor'));

const VALID_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
const normalizeColor = (c: unknown): string | null => (typeof c === 'string' && VALID_COLORS.has(c) ? c : null);

function requireLibrary(libraryId: number): boolean {
  return !!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId);
}

router.post('/', (req, res) => {
  const { name, color, after_id, library_id } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }

  try {
    let sectionId = 0;
    transaction(() => {
      let order_index: number;
      if (after_id != null) {
        // after_id must belong to the same library or the visual result is wrong.
        const after = db.prepare('SELECT order_index FROM sections WHERE id = ? AND library_id = ?').get(after_id, libraryId) as any;
        if (!after) throw new Error('SECTION_NOT_FOUND');
        order_index = after.order_index + 1;
        db.prepare('UPDATE sections SET order_index = order_index + 1 WHERE library_id = ? AND order_index >= ?').run(libraryId, order_index);
      } else {
        const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM sections WHERE library_id = ?').get(libraryId) as any;
        order_index = (maxOrder?.max ?? -1) + 1;
      }
      const result = db.prepare(
        'INSERT INTO sections (name, order_index, color, library_id) VALUES (?, ?, ?, ?)'
      ).run(name.trim(), order_index, normalizeColor(color), libraryId);
      sectionId = Number(result.lastInsertRowid);
    });
    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId) as any;
    writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
    res.status(201).json({ ...section, test_cases: [] });
  } catch (e: any) {
    if (e?.message === 'SECTION_NOT_FOUND') return res.status(404).json({ error: 'after_id section not found in this library' });
    throw e;
  }
});

// PUT /reorder must come before PUT /:id to avoid 'reorder' matching as an id.
// Reorders within a single library — client must pass library_id + the full
// ordered list of section ids belonging to that library.
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
// Delete many sections; their test cases fall back to unsectioned (ON DELETE SET NULL).
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });

  // Snapshot the library from the first section BEFORE deleting, so the
  // log entry survives the deletion. Bulk-delete in the UI is scoped to
  // the active library anyway, so the "first id" heuristic is accurate.
  const library = ids.length > 0 ? libraryForSection((ids as number[])[0]) : null;
  const del = db.prepare('DELETE FROM sections WHERE id = ?');
  let deleted = 0;
  transaction(() => {
    // Same append-to-end concern as the single delete: gather every freed
    // case (in section order, then case order) and renumber them after the
    // existing unsectioned pile so they don't interleave into the middle.
    const first = db.prepare('SELECT library_id FROM sections WHERE id = ?').get((ids as number[])[0]) as any;
    const libraryId = first?.library_id as number | undefined;
    const freed: number[] = [];
    let maxOrder = -1;
    if (libraryId != null) {
      const placeholders = (ids as number[]).map(() => '?').join(',');
      const secRows = db.prepare(
        `SELECT id FROM sections WHERE id IN (${placeholders}) ORDER BY order_index, id`
      ).all(...(ids as number[])) as any[];
      const caseStmt = db.prepare('SELECT id FROM test_cases WHERE section_id = ? ORDER BY order_index, id');
      for (const s of secRows) for (const c of caseStmt.all(s.id) as any[]) freed.push(c.id);
      // Read the max BEFORE deleting, while freed cases still have section_id set.
      maxOrder = ((db.prepare(
        'SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND section_id IS NULL'
      ).get(libraryId)) as any)?.max ?? -1;
    }
    for (const id of ids as number[]) deleted += Number(del.run(id).changes);
    if (freed.length > 0) {
      const upd = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ?');
      for (const id of freed) upd.run(++maxOrder, id);
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.json({ ok: true, deleted });
});

// Merge sources into a target section: move every source's cases into the target
// (appended, order preserved), then delete the emptied source sections. All
// participants must belong to the same library.
router.post('/merge', (req, res) => {
  const { source_ids, target_id } = req.body ?? {};
  if (!Array.isArray(source_ids) || source_ids.length === 0) return res.status(400).json({ error: 'source_ids array required' });
  if (target_id == null) return res.status(400).json({ error: 'target_id required' });

  const target = db.prepare('SELECT library_id FROM sections WHERE id = ?').get(target_id) as any;
  if (!target) return res.status(404).json({ error: 'Target section not found' });

  const sources = (source_ids as number[]).filter((id) => id !== target_id);
  if (sources.length === 0) return res.status(400).json({ error: 'Nothing to merge (only the target was selected)' });

  // All sources must be in the same library as the target — refuse
  // cross-library merges silently instead of leaving orphaned cases.
  const placeholders = sources.map(() => '?').join(',');
  const misfits = db.prepare(
    `SELECT id FROM sections WHERE id IN (${placeholders}) AND library_id != ?`
  ).all(...sources, target.library_id) as any[];
  if (misfits.length > 0) {
    return res.status(400).json({ error: 'All sections in a merge must belong to the same library.' });
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
  // Snapshot the library BEFORE deleting the section.
  const library = libraryForSection(req.params.id);
  const section = db.prepare('SELECT library_id FROM sections WHERE id = ?').get(sectionId) as any;
  if (!section) return res.status(404).json({ error: 'Not found' });

  // The section's cases fall back to unsectioned via ON DELETE SET NULL, but
  // they keep their old order_index (0..n within the section). Since the
  // unsectioned list is sorted by order_index, those values would interleave
  // the freed cases into the MIDDLE of the existing unsectioned pile. Renumber
  // them so they land at the END, in their original order. maxOrder is read
  // BEFORE the delete, while the freed cases still have section_id set (so
  // they're excluded from the section_id IS NULL max).
  transaction(() => {
    const cases = db.prepare(
      'SELECT id FROM test_cases WHERE section_id = ? ORDER BY order_index, id'
    ).all(sectionId) as any[];
    let maxOrder = ((db.prepare(
      'SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND section_id IS NULL'
    ).get(section.library_id)) as any)?.max ?? -1;
    db.prepare('DELETE FROM sections WHERE id = ?').run(sectionId);
    const upd = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ?');
    for (const c of cases) upd.run(++maxOrder, c.id);
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(204).send();
});

export default router;
