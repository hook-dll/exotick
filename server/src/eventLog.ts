import db from './db';

// Every event we record in event_log. Deliberately coarse — the log
// captures WHO did WHAT (superficially), not the exact fields touched
// or the actor's role at the time.
export type EventType =
  | 'login'
  | 'edit'             // any mutation to libraries / sections / test cases
  | 'compose'          // new test run created
  | 'start'            // active state entered
  | 'finish'           // completed state entered
  | 'take_over'        // runner_name changed via take over
  | 'password_change'  // user changed their own password
  | 'password_reset';  // admin reset someone else's password (target in reason)

export interface EventOptions {
  eventType: EventType;
  actor: string;                                   // username
  testRun?: { id: number; name: string } | null;
  // id may be null when the library no longer exists (e.g. logging its own
  // deletion) — we still keep the name so the row stays readable, matching
  // the event_log design where library_id goes NULL but library_name stays.
  library?: { id: number | null; name: string } | null;
  previousRunner?: string | null;
  reason?: string | null;
}

// Fire-and-forget log insert. Called from within a successful handler's
// happy path — never for validation failures, never for reads. Errors
// during insert are logged and swallowed so a broken log doesn't take
// down the actual user action.
export function writeEvent(opts: EventOptions): void {
  try {
    db.prepare(
      `INSERT INTO event_log
         (event_type, actor_username, test_run_id, test_run_name, library_id, library_name, previous_runner, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.eventType,
      opts.actor,
      opts.testRun?.id ?? null,
      opts.testRun?.name ?? null,
      opts.library?.id ?? null,
      opts.library?.name ?? null,
      opts.previousRunner ?? null,
      opts.reason ?? null,
    );
  } catch (e) {
    console.error('[exotick] writeEvent failed:', e);
  }
}

// Lookups used by edit-event handlers to snapshot the affected library at
// mutation time. Each returns null if the row doesn't exist (e.g. the
// section was already deleted); callers use that to log without a library
// annotation rather than crashing.

export function libraryById(libraryId: number): { id: number; name: string } | null {
  const row = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId) as any;
  return row ? { id: row.id, name: row.name } : null;
}

export function libraryForSection(sectionId: number | string): { id: number; name: string } | null {
  const row = db.prepare(
    'SELECT l.id, l.name FROM sections s JOIN libraries l ON l.id = s.library_id WHERE s.id = ?'
  ).get(sectionId) as any;
  return row ? { id: row.id, name: row.name } : null;
}

export function libraryForCase(caseId: number | string): { id: number; name: string } | null {
  const row = db.prepare(
    'SELECT l.id, l.name FROM test_cases tc JOIN libraries l ON l.id = tc.library_id WHERE tc.id = ?'
  ).get(caseId) as any;
  return row ? { id: row.id, name: row.name } : null;
}

export function libraryForModule(moduleId: number | string): { id: number; name: string } | null {
  const row = db.prepare(
    'SELECT l.id, l.name FROM modules m JOIN libraries l ON l.id = m.library_id WHERE m.id = ?'
  ).get(moduleId) as any;
  return row ? { id: row.id, name: row.name } : null;
}

export function libraryForSubModule(subModuleId: number | string): { id: number; name: string } | null {
  const row = db.prepare(
    'SELECT l.id, l.name FROM sub_modules sm JOIN libraries l ON l.id = sm.library_id WHERE sm.id = ?'
  ).get(subModuleId) as any;
  return row ? { id: row.id, name: row.name } : null;
}
