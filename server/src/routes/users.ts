import { Router } from 'express';
import db from '../db';
import { hashPassword } from '../auth/passwords';
import { destroyAllSessionsForUser, type Role, type UserRow } from '../auth/sessions';
import { requireRole } from '../auth/middleware';
import { writeEvent } from '../eventLog';

const router = Router();

const VALID_ROLES: readonly Role[] = ['admin', 'editor', 'runner', 'watcher'];
const MIN_PASSWORD_LEN = 8;
// Kept in sync with server/src/auth/bootstrap.ts — allows plain handles
// and email addresses (2-64 chars, letters/digits/. _ - @ +).
const USERNAME_RE = /^[a-zA-Z0-9._@+-]{2,64}$/;

function toPublic(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    created_at: u.created_at,
    disabled_at: u.disabled_at,
    last_login_at: u.last_login_at,
  };
}

// Roster — usernames only, available to ANY authenticated user regardless
// of role. Used by the Compose page to render a runner-name dropdown.
// Placed BEFORE router.use so it doesn't inherit the admin gate below.
//
// Filtering rules:
//   - Watchers are ALWAYS excluded — they can't be runners (server rejects
//     them via requireCanRun), so listing them in the runner picker is a
//     dead-end suggestion.
//   - Admins are hidden from non-admin callers — the admin account is for
//     management, not day-to-day runs, and non-admins don't need to see it.
router.get('/roster', (req, res) => {
  const includeAdmins = req.user!.role === 'admin';
  const rows = db.prepare(
    includeAdmins
      ? "SELECT username FROM users WHERE disabled_at IS NULL AND role != 'watcher' ORDER BY username COLLATE NOCASE"
      : "SELECT username FROM users WHERE disabled_at IS NULL AND role NOT IN ('admin', 'watcher') ORDER BY username COLLATE NOCASE"
  ).all() as any[];
  res.json({ usernames: rows.map((r) => r.username) });
});

// Everything below (list/create/patch/reset-password/delete) is admin-only.
router.use(requireRole('admin'));

router.get('/', (_req, res) => {
  const rows = db.prepare(
    'SELECT id, username, role, created_at, disabled_at, last_login_at FROM users ORDER BY id'
  ).all() as unknown as UserRow[];
  res.json({ users: rows.map(toPublic) });
});

router.post('/', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role = req.body?.role as Role | undefined;

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-64 chars: letters, digits, or any of . _ - @ +' });
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be one of admin, editor, runner, watcher' });
  }

  const clash = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (clash) return res.status(409).json({ error: 'Username is already taken' });

  const result = db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(username, hashPassword(password), role);
  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as unknown as UserRow;
  res.status(201).json({ user: toPublic(created) });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  if (!target) return res.status(404).json({ error: 'User not found' });

  const body = req.body ?? {};
  const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
  const hasDisabled = Object.prototype.hasOwnProperty.call(body, 'disabled');

  if (!hasRole && !hasDisabled) return res.status(400).json({ error: 'Nothing to update' });

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (hasRole) {
    if (!VALID_ROLES.includes(body.role)) return res.status(400).json({ error: 'Invalid role' });
    if (target.id === req.user!.id && body.role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote yourself; ask another admin' });
    }
    if (target.role === 'admin' && body.role !== 'admin') {
      const adminCount = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get() as any).n;
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot demote the last active admin' });
    }
    sets.push('role = ?'); vals.push(body.role);
  }

  if (hasDisabled) {
    const disabled = !!body.disabled;
    if (disabled && target.id === req.user!.id) {
      return res.status(400).json({ error: 'Cannot disable yourself' });
    }
    if (disabled && target.role === 'admin') {
      const adminCount = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get() as any).n;
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot disable the last active admin' });
    }
    sets.push(disabled ? 'disabled_at = CURRENT_TIMESTAMP' : 'disabled_at = NULL');
  }

  vals.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
  if (hasDisabled && !!body.disabled) destroyAllSessionsForUser(id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;
  res.json({ user: toPublic(updated) });
});

router.post('/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), id);
  // Force re-login on all their devices — a resettable password shouldn't
  // leave a stale session alive.
  destroyAllSessionsForUser(id);
  // Log the fact of a reset. `reason` here doubles as the target-username
  // slot so admins scanning the log can see whose password was reset,
  // without needing an extra column.
  writeEvent({
    eventType: 'password_reset',
    actor: req.user!.username,
    reason: `target: ${target.username}`,
  });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });
  if (id === req.user!.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.role === 'admin') {
    const adminCount = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get() as any).n;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last active admin' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.status(204).send();
});

export default router;
