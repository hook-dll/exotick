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

// Fetch a section's (library_id, module_id) or null if the id is wrong. Used
// to enforce "a case can only belong to a section from the same library" and
// to derive the case's module_id from its section (the invariant:
// test_cases.module_id === sections.module_id for a sectioned case).
function sectionInfo(sectionId: number): { library_id: number; module_id: number | null } | null {
  const r = db.prepare('SELECT library_id, module_id FROM sections WHERE id = ?').get(sectionId) as any;
  return r ? { library_id: r.library_id, module_id: r.module_id ?? null } : null;
}

function moduleInLibrary(moduleId: number | null, libraryId: number): boolean {
  if (moduleId === null) return true;
  return !!db.prepare('SELECT 1 FROM modules WHERE id = ? AND library_id = ?').get(moduleId, libraryId);
}

// Max order_index within a case bucket: a section (sectioned cases) or the
// unsectioned pile of a given (library, module) — `module_id IS ?` matches
// NULL (root) or a value.
const maxOrderIn = (libraryId: number, sectionId: number | null, moduleId: number | null): number =>
  ((sectionId !== null
    ? db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE section_id = ?').get(sectionId)
    : db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND module_id IS ? AND section_id IS NULL').get(libraryId, moduleId)) as any)?.max ?? -1;

// Resolve the (section_id, module_id) a new/moved case should carry, given a
// requested section_id and module_id, validating both against the library.
// Returns an error string, or the resolved pair.
function resolvePlacement(
  libraryId: number,
  sectionId: number | null,
  moduleIdRaw: number | null,
): { section_id: number | null; module_id: number | null } | { error: string } {
  if (sectionId !== null) {
    const sec = sectionInfo(sectionId);
    if (!sec || sec.library_id !== libraryId) return { error: 'section_id belongs to a different library' };
    // Sectioned: module is derived from the section (ignore any requested one).
    return { section_id: sectionId, module_id: sec.module_id };
  }
  if (!moduleInLibrary(moduleIdRaw, libraryId)) return { error: 'module_id belongs to a different library' };
  return { section_id: null, module_id: moduleIdRaw };
}

router.post('/', (req, res) => {
  const { section_id, description, notes, library_id, module_id } = req.body ?? {};
  if (!description?.trim()) return res.status(400).json({ error: 'Description required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }

  const placed = resolvePlacement(libraryId, section_id ?? null, module_id ?? null);
  if ('error' in placed) return res.status(400).json({ error: placed.error });

  const order_index = maxOrderIn(libraryId, placed.section_id, placed.module_id) + 1;
  const result = db.prepare(
    'INSERT INTO test_cases (section_id, description, notes, order_index, library_id, module_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(placed.section_id, description.trim(), notes?.trim() || null, order_index, libraryId, placed.module_id);

  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.status(201).json(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(result.lastInsertRowid)));
});

// PATCH /reorder must come before PUT /:id. Client sends one bucket's ordered
// ids; assigning by position is bucket-agnostic (ids are unique).
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
// Create many cases from a list of descriptions (one per line in the UI).
router.post('/bulk', (req, res) => {
  const { section_id, descriptions, library_id, module_id } = req.body ?? {};
  if (!Array.isArray(descriptions)) return res.status(400).json({ error: 'descriptions array required' });
  const clean = (descriptions as any[]).map((d) => String(d ?? '').trim()).filter((d) => d.length > 0);
  if (clean.length === 0) return res.status(400).json({ error: 'No non-empty descriptions provided' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }

  const placed = resolvePlacement(libraryId, section_id ?? null, module_id ?? null);
  if ('error' in placed) return res.status(400).json({ error: placed.error });

  const insert = db.prepare('INSERT INTO test_cases (section_id, description, notes, order_index, library_id, module_id) VALUES (?, ?, ?, ?, ?, ?)');
  const created: any[] = [];
  transaction(() => {
    let order = maxOrderIn(libraryId, placed.section_id, placed.module_id);
    for (const desc of clean) {
      const r = insert.run(placed.section_id, desc, null, ++order, libraryId, placed.module_id);
      created.push(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.status(201).json({ created: created.length, cases: created });
});

// Move many cases within the SAME library. Target may be a section (module
// derived) or the unsectioned pile of a given module (section_id null +
// module_id). Refuses cross-library moves silently.
router.patch('/bulk-move', (req, res) => {
  const { ids, section_id, library_id, module_id } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const libraryId = Number(library_id);
  if (!Number.isInteger(libraryId) || !requireLibrary(libraryId)) {
    return res.status(400).json({ error: 'Valid library_id required' });
  }
  const placed = resolvePlacement(libraryId, section_id ?? null, module_id ?? null);
  if ('error' in placed) return res.status(400).json({ error: placed.error });

  const update = db.prepare('UPDATE test_cases SET section_id = ?, module_id = ?, order_index = ? WHERE id = ? AND library_id = ?');
  let moved = 0;
  transaction(() => {
    let order = maxOrderIn(libraryId, placed.section_id, placed.module_id);
    for (const id of ids as number[]) moved += Number(update.run(placed.section_id, placed.module_id, ++order, id, libraryId).changes);
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryById(libraryId) });
  res.json({ ok: true, moved });
});

// Delete many cases.
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });

  const library = ids.length > 0 ? libraryForCase((ids as number[])[0]) : null;
  const del = db.prepare('DELETE FROM test_cases WHERE id = ?');
  let deleted = 0;
  transaction(() => {
    for (const id of ids as number[]) deleted += Number(del.run(id).changes);
  });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.json({ ok: true, deleted });
});

// Duplicate many cases (copy of description + notes, appended within each
// source's section/module bucket, inside its own library).
router.post('/bulk-duplicate', (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });

  const get = db.prepare('SELECT * FROM test_cases WHERE id = ?');
  const insert = db.prepare('INSERT INTO test_cases (section_id, description, notes, order_index, library_id, module_id) VALUES (?, ?, ?, ?, ?, ?)');
  const created: any[] = [];
  transaction(() => {
    const nextOrder = new Map<string, number>();
    for (const id of ids as number[]) {
      const src = get.get(id) as any;
      if (!src) continue;
      const sid = src.section_id ?? null;
      const mid = src.module_id ?? null;
      const key = `${src.library_id}:${mid === null ? 'null' : mid}:${sid === null ? 'null' : sid}`;
      const order = (nextOrder.get(key) ?? maxOrderIn(src.library_id, sid, mid)) + 1;
      nextOrder.set(key, order);
      const r = insert.run(sid, src.description, src.notes ?? null, order, src.library_id, mid);
      created.push(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  });
  const library = created.length > 0 ? libraryById(created[0].library_id) : null;
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(201).json({ created: created.length, cases: created });
});

// Copy selected modules / sections / cases into ANOTHER library, non-
// destructively. Structure is recreated in the target:
//   - modules by NAME (reused if a same-named module already exists there,
//     else created)
//   - sections by NAME + COLOR *within their destination module* (a "Checkout"
//     section in module A is distinct from a root "Checkout")
//   - cases append to the end of their destination bucket
// Explicitly-selected modules/sections are materialised even when empty. The
// client includes every descendant id when a module/section checkbox is
// ticked, so "copy a whole module" is just its full subtree in the selection.
router.post('/bulk-copy', (req, res) => {
  const { target_library_id, case_ids, section_ids, module_ids } = req.body ?? {};
  const targetId = Number(target_library_id);
  if (!Number.isInteger(targetId) || !requireLibrary(targetId)) {
    return res.status(400).json({ error: 'Valid target_library_id required' });
  }
  const caseIds = Array.isArray(case_ids) ? (case_ids as any[]).map(Number).filter(Number.isInteger) : [];
  const sectionIds = Array.isArray(section_ids) ? (section_ids as any[]).map(Number).filter(Number.isInteger) : [];
  const moduleIds = Array.isArray(module_ids) ? (module_ids as any[]).map(Number).filter(Number.isInteger) : [];
  if (caseIds.length === 0 && sectionIds.length === 0 && moduleIds.length === 0) {
    return res.status(400).json({ error: 'Nothing selected to copy' });
  }

  const findDestModule = db.prepare('SELECT id FROM modules WHERE library_id = ? AND name = ?');
  const insertModule = db.prepare('INSERT INTO modules (name, order_index, library_id) VALUES (?, ?, ?)');
  const getModule = db.prepare('SELECT id, name, order_index FROM modules WHERE id = ?');
  const findDestSection = db.prepare('SELECT id FROM sections WHERE library_id = ? AND module_id IS ? AND name = ? AND color IS ?');
  const insertSection = db.prepare('INSERT INTO sections (name, order_index, color, library_id, module_id) VALUES (?, ?, ?, ?, ?)');
  const getSection = db.prepare('SELECT id, name, color, order_index, module_id FROM sections WHERE id = ?');
  const insertCase = db.prepare('INSERT INTO test_cases (section_id, description, notes, order_index, library_id, module_id) VALUES (?, ?, ?, ?, ?, ?)');

  let copiedCases = 0;
  let sectionsCreated = 0;
  let modulesCreated = 0;

  transaction(() => {
    // Selected cases, grouped by source module → section → order so copies
    // land in the same relative order.
    let cases: any[] = [];
    if (caseIds.length > 0) {
      const ph = caseIds.map(() => '?').join(',');
      cases = db.prepare(
        `SELECT id, description, notes, section_id, module_id, order_index
           FROM test_cases WHERE id IN (${ph})
          ORDER BY (module_id IS NULL), module_id, (section_id IS NULL), section_id, order_index, id`
      ).all(...caseIds) as any[];
    }

    // ── Modules to materialise ──────────────────────────────────────────
    const neededSrcModuleIds = new Set<number>();
    for (const mid of moduleIds) neededSrcModuleIds.add(mid);
    for (const c of cases) if (c.module_id != null) neededSrcModuleIds.add(c.module_id);
    // Sections carry their own module; pull those in too.
    const srcSectionRows = new Map<number, any>();
    const collectSection = (sid: number) => {
      if (!srcSectionRows.has(sid)) {
        const s = getSection.get(sid) as any;
        if (s) srcSectionRows.set(sid, s);
      }
    };
    for (const sid of sectionIds) collectSection(sid);
    for (const c of cases) if (c.section_id != null) collectSection(c.section_id);
    for (const s of srcSectionRows.values()) if (s.module_id != null) neededSrcModuleIds.add(s.module_id);

    const srcModToDest = new Map<number, number>();
    let nextModuleOrder = (db.prepare('SELECT MAX(order_index) as max FROM modules WHERE library_id = ?').get(targetId) as any)?.max ?? -1;
    const srcModules = [...neededSrcModuleIds]
      .map((id) => getModule.get(id) as any)
      .filter(Boolean)
      .sort((a, b) => a.order_index - b.order_index || a.id - b.id);
    for (const m of srcModules) {
      const existing = findDestModule.get(targetId, m.name) as any;
      if (existing) {
        srcModToDest.set(m.id, existing.id);
      } else {
        const r = insertModule.run(m.name, ++nextModuleOrder, targetId);
        srcModToDest.set(m.id, Number(r.lastInsertRowid));
        modulesCreated++;
      }
    }
    const destModuleFor = (srcModuleId: number | null): number | null =>
      srcModuleId == null ? null : (srcModToDest.get(srcModuleId) ?? null);

    // ── Sections to materialise ─────────────────────────────────────────
    const srcToDestSection = new Map<number, number>();
    // Per destination module bucket, running section order.
    const sectionOrderByModule = new Map<string, number>();
    const nextSectionOrder = (destModuleId: number | null): number => {
      const key = destModuleId === null ? 'null' : String(destModuleId);
      if (!sectionOrderByModule.has(key)) {
        const max = (db.prepare('SELECT MAX(order_index) as max FROM sections WHERE library_id = ? AND module_id IS ?').get(targetId, destModuleId) as any)?.max ?? -1;
        sectionOrderByModule.set(key, max);
      }
      const next = sectionOrderByModule.get(key)! + 1;
      sectionOrderByModule.set(key, next);
      return next;
    };
    const srcSectionsSorted = [...srcSectionRows.values()].sort((a, b) => a.order_index - b.order_index || a.id - b.id);
    for (const s of srcSectionsSorted) {
      const destModule = destModuleFor(s.module_id ?? null);
      const existing = findDestSection.get(targetId, destModule, s.name, s.color ?? null) as any;
      if (existing) {
        srcToDestSection.set(s.id, existing.id);
      } else {
        const r = insertSection.run(s.name, nextSectionOrder(destModule), s.color ?? null, targetId, destModule);
        srcToDestSection.set(s.id, Number(r.lastInsertRowid));
        sectionsCreated++;
      }
    }

    // ── Cases ───────────────────────────────────────────────────────────
    // Running append-order per destination bucket. Key: dest section id, or
    // `u:<destModuleId>` for an unsectioned pile.
    const bucketOrder = new Map<string, number>();
    const nextInBucket = (destSectionId: number | null, destModuleId: number | null): number => {
      const key = destSectionId === null ? `u:${destModuleId === null ? 'null' : destModuleId}` : `s:${destSectionId}`;
      if (!bucketOrder.has(key)) {
        const max = destSectionId === null
          ? (db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE library_id = ? AND module_id IS ? AND section_id IS NULL').get(targetId, destModuleId) as any)?.max ?? -1
          : (db.prepare('SELECT MAX(order_index) as max FROM test_cases WHERE section_id = ?').get(destSectionId) as any)?.max ?? -1;
        bucketOrder.set(key, max);
      }
      const next = bucketOrder.get(key)! + 1;
      bucketOrder.set(key, next);
      return next;
    };

    for (const c of cases) {
      const destSectionId = c.section_id == null ? null : (srcToDestSection.get(c.section_id) ?? null);
      // A sectioned case takes its module from the dest section; an
      // unsectioned case takes it from the case's own source module.
      const destModuleId = c.section_id == null
        ? destModuleFor(c.module_id ?? null)
        : destModuleFor((srcSectionRows.get(c.section_id)?.module_id) ?? null);
      insertCase.run(destSectionId, c.description, c.notes ?? null, nextInBucket(destSectionId, destModuleId), targetId, destModuleId);
      copiedCases++;
    }
  });

  const library = libraryById(targetId);
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(201).json({ ok: true, copiedCases, sectionsCreated, modulesCreated, library });
});

router.put('/:id', (req, res) => {
  const { description, section_id, notes } = req.body ?? {};
  if (!description?.trim()) return res.status(400).json({ error: 'Description required' });

  const existing = db.prepare('SELECT library_id, module_id FROM test_cases WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const sectionId = section_id ?? null;
  // Moving into a section derives the module from it; clearing the section
  // (→ unsectioned) leaves the case in its current module.
  let moduleId = existing.module_id ?? null;
  if (sectionId !== null) {
    const sec = sectionInfo(sectionId);
    if (!sec || sec.library_id !== existing.library_id) {
      return res.status(400).json({ error: 'section_id belongs to a different library' });
    }
    moduleId = sec.module_id;
  }

  const result = db.prepare(
    'UPDATE test_cases SET description = ?, section_id = ?, notes = ?, module_id = ? WHERE id = ?'
  ).run(description.trim(), sectionId, notes?.trim() || null, moduleId, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

  writeEvent({ eventType: 'edit', actor: req.user!.username, library: libraryForCase(req.params.id) });
  res.json(db.prepare('SELECT * FROM test_cases WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const library = libraryForCase(req.params.id);
  const result = db.prepare('DELETE FROM test_cases WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  writeEvent({ eventType: 'edit', actor: req.user!.username, library });
  res.status(204).send();
});

export default router;
