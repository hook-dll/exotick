import { Router } from 'express';
import db from '../db';
import { requireRole } from '../auth/middleware';

const router = Router();

// Whole router is admin-only. The log is a security-adjacent surface;
// watchers / editors / runners have no read access.
//
// This is NOT a keystroke-level audit trail — it records key named actions
// (sign-in, edit, run compose/start/finish, take over, password change/reset).
router.use(requireRole('admin'));

const BROWSE_LIMIT = 200;

// Columns returned to the client / CSV. Kept in one place so browse +
// export stay in sync.
const SELECT_COLUMNS =
  'id, created_at, event_type, actor_username, test_run_id, test_run_name, library_id, library_name, previous_runner, reason';

// GET / — latest BROWSE_LIMIT rows, newest first. If the log grows large,
// the CSV export below carries the full history. We deliberately don't
// paginate the UI list: admins wanting older records download CSV.
router.get('/', (_req, res) => {
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM event_log
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).all(BROWSE_LIMIT);
  const total = (db.prepare('SELECT COUNT(*) as n FROM event_log').get() as any).n;
  res.json({ events: rows, total, limit: BROWSE_LIMIT });
});

// Minimal CSV encoder — no external dep. Wraps a field in quotes if it
// contains a comma, quote, or newline; escapes embedded quotes by doubling.
function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Spreadsheet formula-injection guard: a field beginning with = + - @ (or a
  // tab / carriage return, which Excel also treats as a formula lead) is
  // prefixed with a single quote so Excel / Google Sheets render it as literal
  // text instead of evaluating it. The `reason` and run-name fields are
  // attacker-controllable free text, so this matters on the log export.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// GET /export.csv — full history (no LIMIT). Streams row-by-row so a
// million-row log doesn't buffer in memory before the client sees it.
const CSV_HEADER = 'id,created_at,event_type,actor_username,test_run_id,test_run_name,library_id,library_name,previous_runner,reason';
// RFC 4180 uses CRLF line endings; Excel and every other reader accept them.
const CRLF = '\r\n';

router.get('/export.csv', (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="exotick-log-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');

  // Two things make this open with proper columns everywhere:
  //   1. A UTF-8 BOM (﻿) so Excel detects the encoding (also keeps
  //      non-ASCII names/reasons from garbling).
  //   2. A leading `sep=,` line. Excel chooses its column delimiter from the
  //      OS regional "list separator" — which is ';' in many locales — NOT
  //      from the file, so a comma CSV otherwise dumps every row into a single
  //      cell. `sep=,` overrides that; Excel/LibreOffice honor it and strip it.
  res.write('﻿' + 'sep=,' + CRLF);
  res.write(CSV_HEADER + CRLF);

  const stmt = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM event_log
     ORDER BY created_at ASC, id ASC`
  );
  for (const row of stmt.iterate() as unknown as Iterable<any>) {
    res.write(
      [
        row.id,
        row.created_at,
        row.event_type,
        row.actor_username,
        row.test_run_id ?? '',
        row.test_run_name ?? '',
        row.library_id ?? '',
        row.library_name ?? '',
        row.previous_runner ?? '',
        row.reason ?? '',
      ].map(csvField).join(',') + CRLF
    );
  }
  res.end();
});

export default router;
