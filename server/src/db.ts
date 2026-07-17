import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

// DATA_DIR can be overridden (e.g. for isolated tests) via EXOTICK_DATA_DIR.
export const DATA_DIR = process.env.EXOTICK_DATA_DIR
  ? path.resolve(process.env.EXOTICK_DATA_DIR)
  : path.join(__dirname, '../../data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'cms.db'));

// Use prepare().get() for pragmas that return a result row
db.prepare('PRAGMA journal_mode = WAL').get();
db.prepare('PRAGMA foreign_keys = ON').get();

// libraries is a parent container for sections + test_cases + test_runs.
// Every row in those three tables belongs to exactly one library. Compose
// only lets you pick cases from a single library, so runs are always
// scoped to one too.
db.exec(`
  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    runner_name TEXT,
    status TEXT NOT NULL DEFAULT 'composing' CHECK(status IN ('composing', 'active', 'completed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS test_run_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    test_case_id INTEGER REFERENCES test_cases(id) ON DELETE SET NULL,
    snapshot_description TEXT NOT NULL,
    snapshot_section_name TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    status TEXT CHECK(status IN ('pass', 'fail', 'skip')),
    updated_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'runner', 'watcher')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled_at DATETIME,
    last_login_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

  -- event_log tracks named actions: login / edit / compose / start /
  -- finish / take_over. Rows persist independently of test_runs so
  -- deleting a run does NOT wipe log history: test_run_id becomes NULL
  -- but test_run_name + previous_runner + reason stay on the row.
  -- Deliberately NOT a full audit of every interaction (no reads, no
  -- individual case marks, no role snapshot).
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,
    actor_username TEXT NOT NULL,
    test_run_id INTEGER REFERENCES test_runs(id) ON DELETE SET NULL,
    test_run_name TEXT,
    library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
    library_name TEXT,
    previous_runner TEXT,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_event_log_test_run_id ON event_log(test_run_id);
`);

// Backfill library_id + library_name on legacy event_log rows. MUST run
// before the library_id index below — for legacy installs the CREATE
// TABLE IF NOT EXISTS above is a no-op (the table already exists without
// these columns), so we add them first, then create the index.
const elCols2 = (db.prepare('PRAGMA table_info(event_log)').all() as any[]).map((c) => c.name);
if (!elCols2.includes('library_id')) {
  db.exec('ALTER TABLE event_log ADD COLUMN library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL');
}
if (!elCols2.includes('library_name')) {
  db.exec('ALTER TABLE event_log ADD COLUMN library_name TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_event_log_library_id ON event_log(library_id)');

// Rename legacy `audit_log` table (from an earlier, shorter-lived version of
// this feature) to the current `event_log`. Idempotent — only fires if the
// old table exists AND the new one is empty, so we don't stomp on real data.
const hasAuditLog = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
).get();
const eventLogCount = (db.prepare('SELECT COUNT(*) as n FROM event_log').get() as any).n;
if (hasAuditLog && eventLogCount === 0) {
  db.exec(`
    INSERT INTO event_log (id, created_at, event_type, actor_username, test_run_id, test_run_name, previous_runner, reason)
      SELECT id, created_at, event_type, actor_username, test_run_id, test_run_name, previous_runner, reason FROM audit_log;
    DROP INDEX IF EXISTS idx_audit_log_created_at;
    DROP INDEX IF EXISTS idx_audit_log_test_run_id;
    DROP TABLE audit_log;
  `);
}

// Idempotent migrations for new columns
const tcCols = (db.prepare('PRAGMA table_info(test_cases)').all() as any[]).map((c) => c.name);
if (!tcCols.includes('notes')) db.exec('ALTER TABLE test_cases ADD COLUMN notes TEXT');

const triCols = (db.prepare('PRAGMA table_info(test_run_items)').all() as any[]).map((c) => c.name);
if (!triCols.includes('snapshot_notes')) db.exec('ALTER TABLE test_run_items ADD COLUMN snapshot_notes TEXT');
// Records the username of whoever last marked/skipped this item. Null only
// on rows written before the column existed.
if (!triCols.includes('updated_by')) db.exec('ALTER TABLE test_run_items ADD COLUMN updated_by TEXT');
// Module the case belonged to at compose time (parallel to snapshot_section_name).
// Null = the case was not inside any module (library root). Run views + PDFs
// group items by module → section using this snapshot.
if (!triCols.includes('snapshot_module_name')) db.exec('ALTER TABLE test_run_items ADD COLUMN snapshot_module_name TEXT');

const secCols = (db.prepare('PRAGMA table_info(sections)').all() as any[]).map((c) => c.name);
if (!secCols.includes('color')) db.exec('ALTER TABLE sections ADD COLUMN color TEXT');

// users.role CHECK constraint may be missing 'watcher' in older DBs. SQLite
// doesn't allow altering a CHECK, so we rebuild the table when needed.
// Detection: inspect the CREATE TABLE SQL in sqlite_master for the literal.
const userSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as any)?.sql ?? '';
if (userSchema && !userSchema.includes("'watcher'")) {
  db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'runner', 'watcher')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      disabled_at DATETIME,
      last_login_at DATETIME
    );
    INSERT INTO users_new SELECT id, username, password_hash, role, created_at, disabled_at, last_login_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
}

// ── libraries migration ────────────────────────────────────────────────
// Ensure at least one library exists (name = "Main") before we backfill
// library_id columns on sections / test_cases / test_runs. The default id
// we interpolate into ALTER TABLE ADD COLUMN below must reference a real
// row, or SQLite refuses the statement with an FK violation.
let defaultLib = db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get() as { id: number } | undefined;
if (!defaultLib) {
  const inserted = db.prepare('INSERT INTO libraries (name, order_index) VALUES (?, ?)').run('Main', 0);
  defaultLib = { id: Number(inserted.lastInsertRowid) };
}
const DEFAULT_LIBRARY_ID = defaultLib.id;

// sections.library_id: CASCADE — when a library is deleted, its sections
// disappear with it. (The server-side guard refuses deletion when any runs
// reference the library, so cascade only ever fires for empty libraries.)
const secCols2 = (db.prepare('PRAGMA table_info(sections)').all() as any[]).map((c) => c.name);
if (!secCols2.includes('library_id')) {
  db.exec(`ALTER TABLE sections ADD COLUMN library_id INTEGER NOT NULL DEFAULT ${DEFAULT_LIBRARY_ID} REFERENCES libraries(id) ON DELETE CASCADE`);
}

// test_cases.library_id: CASCADE, same reasoning.
const tcCols2 = (db.prepare('PRAGMA table_info(test_cases)').all() as any[]).map((c) => c.name);
if (!tcCols2.includes('library_id')) {
  db.exec(`ALTER TABLE test_cases ADD COLUMN library_id INTEGER NOT NULL DEFAULT ${DEFAULT_LIBRARY_ID} REFERENCES libraries(id) ON DELETE CASCADE`);
}

// test_runs.library_id: RESTRICT — the FK is a belt-and-braces safety net
// on top of the app-layer 409-when-runs-exist guard. If somehow both got
// bypassed, SQLite would still refuse the delete.
const trCols = (db.prepare('PRAGMA table_info(test_runs)').all() as any[]).map((c) => c.name);
if (!trCols.includes('library_id')) {
  db.exec(`ALTER TABLE test_runs ADD COLUMN library_id INTEGER NOT NULL DEFAULT ${DEFAULT_LIBRARY_ID} REFERENCES libraries(id) ON DELETE RESTRICT`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sections_library_id  ON sections(library_id);
  CREATE INDEX IF NOT EXISTS idx_test_cases_library_id ON test_cases(library_id);
  CREATE INDEX IF NOT EXISTS idx_test_runs_library_id  ON test_runs(library_id);
`);

// ── modules migration ──────────────────────────────────────────────────
// A module is an OPTIONAL grouping container that lives inside a library and
// wraps sections + unsectioned cases. It mirrors the library_id pattern:
// sections and test_cases each carry a NULLABLE module_id. NULL means the
// row sits at the library root (no module) — exactly how every row behaved
// before this feature, so legacy databases need no data movement. The
// invariant, enforced in the route layer just like library_id: a sectioned
// case's module_id always equals its section's module_id.
//
// ON DELETE SET NULL: deleting a module returns its sections + cases to the
// library root rather than destroying them — parallel to how deleting a
// section returns its cases to the unsectioned pile.
db.exec(`
  CREATE TABLE IF NOT EXISTS modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_modules_library_id ON modules(library_id);
`);

const secCols3 = (db.prepare('PRAGMA table_info(sections)').all() as any[]).map((c) => c.name);
if (!secCols3.includes('module_id')) {
  db.exec('ALTER TABLE sections ADD COLUMN module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL');
}
const tcCols3 = (db.prepare('PRAGMA table_info(test_cases)').all() as any[]).map((c) => c.name);
if (!tcCols3.includes('module_id')) {
  db.exec('ALTER TABLE test_cases ADD COLUMN module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL');
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sections_module_id  ON sections(module_id);
  CREATE INDEX IF NOT EXISTS idx_test_cases_module_id ON test_cases(module_id);
`);

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export default db;
