import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';
import { writeEvent, libraryById, libraryForCase } from '../eventLog';

const router = Router();

// Every route on this router mutates the library; editor+ only.
router.use(requireRole('editor'));

function requireLibrary(libraryId: number): boolean {
  return !!db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId);
}

// Helper: fetch the library id a section belongs to (or null if the id is
// wrong). Used to enforce "case can only belong to a section from the same
// library".
function sectionLibrary(sectionId: number): number | null {
  const r = db.prepare('SELECT library_id FROM sections WHERE id = ?').get(sectionId) as any;
  return r ? r.library_id : null;
}

router.post('/', (req, res) => {
  const { section_id, description, notes, library_id } = req.body ?? {};
  if (!description?.trim()) return res.status(400).json({ error: 'Description required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }

  const sectionId = section_id ?? null;
  if (sectionId !== null && sectionLibrary(sectionId) !== libraryId) {
    return res.status(400).json({ error: 'section_id belongs to a different library' });
  }

  const maxOrder = sectionId !== null
    ? (db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE section_id = ?').get(sectionId) as any)
    : (db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND section_id IS NULL').get(libraryId) as any);

  const order_index = (maxOrder?.max ?? -1) + 1;

  const result = db.prepare(
    'INSERT INTO test_cases (section_id, description, notes, order_index, library_id) VALUES (?, ?, ?, ?, ?)'
  ).run(sectionId, description.trim(), notes?.trim() || null, order_index, libraryId);

  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.status(201).json(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(result.lastInsertRowid)));
});

// PATCH /reorder must come before PUT /:id. Reorder scoped to a library.
router.patch('/reorder', (req, res) => {
  const { ids, library_id } = req.body ?? {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId)) return res.status(400).json({ error: 'library_id required' });

  const update = db.prepare('UPDATE test_cases SET order_index = ? WHERE id = ? AND library_id = ?');
  transaction(() => {
    (ids as number[]).forEach((id, index) => update.run(index, id, libraryId));
  });

  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true });
});

// ── Bulk operations ──────────────────────────────────────────────────────────
const maxOrderIn = (libraryId: number, sectionId: number | null): number =>
  ((sectionId !== null
    ? db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE section_id = ?').get(sectionId)
    : db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND section_id IS NULL').get(libraryId)) as any)?.max ?? -1;

// Create many cases from a list of descriptions (one per line in the UI).
router.post('/bulk', (req, res) => {
  const { section_id, descriptions, library_id } = req.body ?? {};
  if (!Array.isArray(descriptions)) return res.status(400).json({ error: 'descriptions array required' });
  const clean = (descriptions as any[]).map((d) => String(d ?? '').trim()).filter((d) => d.length > 0);
  if (clean.length === 0) return res.status(400).json({ error: 'No non-empty descriptions provided' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }

  const sectionId = section_id ?? null;
  if (sectionId !== null && sectionLibrary(sectionId) !== libraryId) {
    return res.status(400).json({ error: 'section_id belongs to a different library' });
  }

  const insert = db.prepare('INSERT INTO test_cases (section_id, description, notes, order_index, library_id) VALUES (?, ?, ?, ?, ?)');
  const created: any[] = [];
  transaction(() => {
    let order = maxOrderIn(libraryId, sectionId);
    for (const desc of clean) {
      const r = insert.run(sectionId, desc, null, ++order, libraryId);
      created.push(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.status(201).json({ created: created.length, cases: created });
});

// Move many cases within the SAME library. Refuses cross-library moves
// silently — client should never send those.
router.patch('/bulk-move', (req, res) => {
  const { ids, section_id, library_id } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }
  const sectionId = section_id ?? null;
  if (sectionId !== null && sectionLibrary(sectionId) !== libraryId) {
    return res.status(400).json({ error: 'section_id belongs to a different library' });
  }

  const update = db.prepare('UPDATE test_cases SET section_id = ?, order_index = ? WHERE id = ? AND library_id = ?');
  let moved = 0;
  transaction(() => {
    let order = maxOrderIn(libraryId, sectionId);
    for (const id of ids as number[]) moved += Number(update.run(sectionId, ++order, id, libraryId).changes);
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true, moved });
});

// Delete many cases.
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });

  // Snapshot library from the first case BEFORE deleting. Bulk-delete in
  // the UI is scoped to the active library, so first id is representative.
  const library = ids.length > 0 ? libraryForCase((ids as number[])[0]) : null;
  const del = db.prepare('DELETE FROM test_cases WHERE id = ?');
  let deleted = 0;
  transaction(() => {
    for (const id of ids as number[]) deleted += Number(del.run(id).changes);
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.json({ ok: true, deleted });
});

// Duplicate many cases (copy of description + notes, appended within each source's
// section, inside its own library).
router.post('/bulk-duplicate', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });

  const get = db.prepare('SELECT * FROM test_cases WHERE id = ?');
  const insert = db.prepare('INSERT INTO test_cases (section_id, description, notes, order_index, library_id) VALUES (?, ?, ?, ?, ?)');
  const created: any[] = [];
  transaction(() => {
    // Running-order cache keyed by (library, section) so duplicating a batch
    // stays contiguous within each destination.
    const nextOrder = new Map<string, number>();
    for (const id of ids as number[]) {
      const src = get.get(id) as any;
      if (!src) continue;
      const sid = src.section_id ?? null;
      const key = `${src.library_id}:${sid === null ? 'null' : sid}`;
      const order = (nextOrder.get(key) ?? maxOrderIn(src.library_id, sid)) + 1;
      nextOrder.set(key, order);
      const r = insert.run(sid, src.description, src.notes ?? null, order, src.library_id);
      created.push(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  });
  // Duplicated cases keep their source library, so any created row is
  // representative. If nothing was actually created, no library.
  const library = created.length > 0 ? libraryById(created[0].library_id) : null;
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(201).json({ created: created.length, cases: created });
});

router.put('/:id', (req, res) => {
  const { description, section_id, notes } = req.body ?? {};
  if (!description?.trim()) return res.status(400).json({ error: 'Description required' });

  // If the caller is reassigning the section, it must belong to the same
  // library as the case. Cross-library moves aren't supported here (users
  // duplicate then delete, or move within Edit Mode's bulk actions).
  const existing = db.prepare('SELECT library_id FROM test_cases WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const sectionId = section_id ?? null;
  if (sectionId !== null && sectionLibrary(sectionId) !== existing.library_id) {
    return res.status(400).json({ error: 'section_id belongs to a different library' });
  }

  const result = db.prepare(
    'UPDATE test_cases SET description = ?, section_id = ?, notes = ? WHERE id = ?'
  ).run(description.trim(), sectionId, notes?.trim() || null, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryForCase(req.params.id) });
  res.json(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  // Snapshot library BEFORE deleting the case.
  const library = libraryForCase(req.params.id);
  const result = db.prepare('DELETE FROM test_cases WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(204).send();
});

export default router;
