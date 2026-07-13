import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { transaction } from '../db';
import { requireCanRun, requireRole } from '../auth/middleware';
import { getCooldownMinutes } from './settings';
import { writeEvent } from '../eventLog';

const router = Router();

// Items selection deliberately omits `updated_at` — the timestamp reveals
// when the current runner last touched a case, which is surveillance of
// another user. Callers only need updated_by (for Contributors chips).
const ITEM_COLUMNS =
  'id, test_run_id, test_case_id, snapshot_description, snapshot_notes, snapshot_section_name, order_index, status, updated_by';

// Server-side SQL fragment that produces cooldown_active as 0/1 per run row.
// Kept as an expression rather than a JS-side computation so `last_activity_at`
// never leaves the database.
function cooldownActiveSelect(cooldownSeconds: number): { sql: string; params: number[] } {
  if (cooldownSeconds <= 0) {
    // Admin set the cooldown to 0 → nothing is ever "active".
    return { sql: '0 AS cooldown_active', params: [] };
  }
  return {
    sql: `CASE
            WHEN tr.status != 'active' THEN 0
            WHEN (strftime('%s', 'now') - strftime('%s', COALESCE(
              (SELECT MAX(updated_at) FROM test_run_items WHERE test_run_id = tr.id),
              tr.started_at
            ))) < ? THEN 1
            ELSE 0
          END AS cooldown_active`,
    params: [cooldownSeconds],
  };
}

router.get('/', (req, res) => {
  const { status, library_id } = req.query;
  const filters: string[] = [];
  const params: any[] = [];
  if (typeof status === 'string' && status) {
    filters.push('tr.status = ?');
    params.push(status);
  }
  if (typeof library_id === 'string' && library_id) {
    const lid = Number(library_id);
    if (Number.isInteger(lid)) {
      filters.push('tr.library_id = ?');
      params.push(lid);
    }
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const cd = cooldownActiveSelect(getCooldownMinutes() * 60);
  const rows = db.prepare(
    `SELECT tr.*,
            l.name AS library_name,
            ${cd.sql}
     FROM test_runs tr
     LEFT JOIN libraries l ON l.id = tr.library_id
     ${where}
     ORDER BY tr.created_at DESC`
  ).all(...cd.params, ...params) as any[];
  // Normalize cooldown_active to a real boolean at the API boundary.
  res.json(rows.map((r) => ({ ...r, cooldown_active: !!r.cooldown_active })));
});

router.get('/:id', (req, res) => {
  const cd = cooldownActiveSelect(getCooldownMinutes() * 60);
  const run = db.prepare(
    `SELECT tr.*, l.name AS library_name, ${cd.sql}
     FROM test_runs tr LEFT JOIN libraries l ON l.id = tr.library_id
     WHERE tr.id = ?`
  ).get(...cd.params, req.params.id) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });

  const items = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM test_run_items WHERE test_run_id = ? ORDER BY order_index, id`
  ).all(req.params.id);

  res.json({ ...run, cooldown_active: !!run.cooldown_active, items });
});

router.post('/', requireCanRun, (req, res) => {
  const { name, runner_name, case_ids } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const ids: number[] = Array.isArray(case_ids) ? case_ids.filter((n) => Number.isInteger(n)) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Select at least one test case' });

  const rn = typeof runner_name === 'string' ? runner_name.trim() : '';
  if (rn) {
    const targetIsAdmin = db.prepare(
      "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND role = 'admin'"
    ).get(rn);
    if (targetIsAdmin) {
      return res.status(400).json({ error: "Admin can't be a runner. Pick a different user." });
    }
  }

  try {
    const run = transaction(() => {
      const placeholders = ids.map(() => '?').join(',');
      const cases = db.prepare(
        `SELECT tc.id, tc.description, tc.notes, tc.library_id, s.name AS section_name
         FROM test_cases tc
         LEFT JOIN sections s ON s.id = tc.section_id
         WHERE tc.id IN (${placeholders})
         ORDER BY
           CASE WHEN tc.section_id IS NULL THEN 1 ELSE 0 END,
           s.order_index, s.id,
           tc.order_index, tc.id`
      ).all(...ids) as any[];

      if (cases.length === 0) throw new Error('NO_VALID_CASES');

      const libraryIds = new Set(cases.map((c) => c.library_id));
      if (libraryIds.size > 1) throw new Error('MULTIPLE_LIBRARIES');
      const libraryId = cases[0].library_id;

      const runResult = db.prepare(
        'INSERT INTO test_runs (name, runner_name, library_id) VALUES (?, ?, ?)'
      ).run(name.trim(), rn || null, libraryId);
      const runId = Number(runResult.lastInsertRowid);

      const insertItem = db.prepare(
        `INSERT INTO test_run_items
         (test_run_id, test_case_id, snapshot_description, snapshot_notes, snapshot_section_name, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      let orderIndex = 0;
      for (const tc of cases) {
        insertItem.run(runId, tc.id, tc.description, tc.notes ?? null, tc.section_name ?? null, orderIndex++);
      }

      return db.prepare(
        `SELECT tr.*, l.name AS library_name
         FROM test_runs tr LEFT JOIN libraries l ON l.id = tr.library_id
         WHERE tr.id = ?`
      ).get(runId);
    });

    const composedRun = run as any;
    writeEvent({
      eventType: 'compose',
      actor: req.user!.username,
      testRun: { id: composedRun.id, name: composedRun.name },
    });
    res.status(201).json({ ...composedRun, cooldown_active: false });
  } catch (e: any) {
    if (e?.message === 'NO_VALID_CASES') {
      return res.status(400).json({ error: 'None of the selected test cases exist any more.' });
    }
    if (e?.message === 'MULTIPLE_LIBRARIES') {
      return res.status(400).json({ error: 'All selected cases must belong to the same library.' });
    }
    throw e;
  }
});

router.post('/:id/start', requireCanRun, (req, res) => {
  const run = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (run.status !== 'composing') return res.status(400).json({ error: 'Run is not in composing status' });
  if (!assertOwnership(req, res, run)) return;

  db.prepare(
    "UPDATE test_runs SET status = 'active', started_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(req.params.id);

  writeEvent({
    eventType: 'start',
    actor: req.user!.username,
    testRun: { id: run.id, name: run.name },
  });
  res.json(db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.id));
});

const MIN_REASON_LEN = 10;
router.post('/:id/take-over', requireCanRun, (req, res) => {
  const actor = req.user!.username;

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < MIN_REASON_LEN) {
    return res.status(400).json({ error: `Reason required (at least ${MIN_REASON_LEN} characters).` });
  }

  const run = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });
  // Drafts (composing) can't be taken over — there's no activity to
  // protect and no cooldown, which would make take over a pure steal
  // from whoever's drafting. Completed runs are terminal.
  if (run.status !== 'active') {
    return res.status(400).json({ error: 'Only active runs can be taken over.' });
  }
  if (run.runner_name === actor) return res.json(run); // no-op

  // Cooldown window is admin-tunable. 0 disables the check entirely (still
  // requires the reason — misclick friction stays).
  const cooldownMinutes = getCooldownMinutes();
  if (cooldownMinutes > 0) {
    const activityRow = db.prepare(
      `SELECT (
         strftime('%s', 'now') - strftime('%s', COALESCE(
           (SELECT MAX(updated_at) FROM test_run_items WHERE test_run_id = ?),
           (SELECT started_at FROM test_runs WHERE id = ?)
         ))
       ) AS elapsed_seconds`
    ).get(run.id, run.id) as any;
    const elapsedSec = activityRow?.elapsed_seconds;
    if (typeof elapsedSec === 'number' && Number.isFinite(elapsedSec)) {
      if (elapsedSec < cooldownMinutes * 60) {
        // Vague on purpose — the server never returns a "N minutes left"
        // number. Both the wire and the display stay opaque to the caller.
        return res.status(409).json({
          error: 'This runner seems to be active on the run — try again later.',
        });
      }
    }
  }

  const previousRunner: string | null = run.runner_name;
  db.prepare('UPDATE test_runs SET runner_name = ? WHERE id = ?').run(actor, req.params.id);
  // Log entry — carries a snapshot of the run's name so it stays readable
  // if the run is deleted later. Reason is stored as-is (already ≥10 chars).
  writeEvent({
    eventType: 'take_over',
    actor,
    testRun: { id: run.id, name: run.name },
    previousRunner,
    reason,
  });
  res.json(db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.id));
});

function assertOwnership(req: Request, res: Response, run: { runner_name: string | null }): boolean {
  const actor = req.user!.username;
  if (run.runner_name !== actor) {
    res.status(403).json({
      error: `This run is currently assigned to ${run.runner_name ?? '(no one)'}. Take it over to continue.`,
      currentRunner: run.runner_name,
    });
    return false;
  }
  return true;
}

router.patch('/items/:itemId', requireCanRun, (req, res) => {
  const { status } = req.body ?? {};
  if (status !== null && !['pass', 'fail'].includes(status)) {
    return res.status(400).json({ error: 'Status must be pass, fail, or null' });
  }

  const run = db.prepare(
    'SELECT tr.* FROM test_run_items tri JOIN test_runs tr ON tr.id = tri.test_run_id WHERE tri.id = ?'
  ).get(req.params.itemId) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (!assertOwnership(req, res, run)) return;

  const result = db.prepare(
    'UPDATE test_run_items SET status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?'
  ).run(status, req.user!.username, req.params.itemId);

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

  // Response drops updated_at (privacy — see ITEM_COLUMNS at the top).
  res.json(db.prepare(`SELECT ${ITEM_COLUMNS} FROM test_run_items WHERE id = ?`).get(req.params.itemId));
});

router.post('/:id/finish', requireCanRun, (req, res) => {
  const run = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (run.status !== 'active') return res.status(400).json({ error: 'Run is not active' });
  if (!assertOwnership(req, res, run)) return;

  const actor = req.user!.username;

  transaction(() => {
    db.prepare(
      "UPDATE test_run_items SET status = 'skip', updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE test_run_id = ? AND status IS NULL"
    ).run(actor, req.params.id);

    db.prepare(
      "UPDATE test_runs SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(req.params.id);
  });

  const finished = db.prepare(
    `SELECT tr.*, l.name AS library_name
     FROM test_runs tr LEFT JOIN libraries l ON l.id = tr.library_id
     WHERE tr.id = ?`
  ).get(req.params.id) as any;
  const items = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM test_run_items WHERE test_run_id = ? ORDER BY order_index`
  ).all(req.params.id);
  writeEvent({
    eventType: 'finish',
    actor,
    testRun: { id: finished.id, name: finished.name },
  });
  res.json({ ...finished, cooldown_active: false, items });
});

router.delete('/:id', requireRole('editor'), (req, res) => {
  const run = db.prepare('SELECT status FROM test_runs WHERE id = ?').get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });
  // Editors may delete only DRAFT (composing) runs — cleaning up unstarted
  // drafts. Deleting an active run (destroys in-progress work) or a completed
  // run (erases audit-visible history) is admin-only, so a compromised editor
  // account can't halt live runs or quietly wipe results.
  if (run.status !== 'composing' && req.user!.role !== 'admin') {
    const kind = run.status === 'active' ? 'active' : 'completed';
    return res.status(403).json({ error: `Only admin can delete ${kind} runs.` });
  }
  const result = db.prepare('DELETE FROM test_runs WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

export default router;
