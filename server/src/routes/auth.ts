import { Router } from 'express';
import db from '../db';
import { hashPassword, verifyPassword } from '../auth/passwords';
import {
  createSession,
  destroySessionByRawId,
  destroySessionByStoredId,
  hashSid,
  listSessionsForUser,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type SessionRow,
  type UserRow,
} from '../auth/sessions';
import { requireAuth } from '../auth/middleware';
import * as rateLimit from '../auth/rateLimit';
import { writeEvent } from '../eventLog';

const router = Router();

const MIN_PASSWORD_LEN = 8;

function cookieOptions(req: any) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !!req.secure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
}

// ── /me — client boot probe. Public because it has to work before login. ──
// Returns { user } (or { user: null } when the cookie is missing/expired).
router.get('/me', (req, res) => {
  const rawSid = (req as any).cookies?.[SESSION_COOKIE_NAME];
  if (typeof rawSid !== 'string' || !rawSid) {
    return res.json({ user: null });
  }
  const row = db.prepare(
    `SELECT u.id, u.username, u.role, u.disabled_at, s.expires_at
     FROM sessions s INNER JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).get(hashSid(rawSid)) as any;
  if (!row || row.disabled_at || new Date(row.expires_at).getTime() < Date.now()) {
    return res.json({ user: null });
  }
  res.json({ user: { id: row.id, username: row.username, role: row.role } });
});

router.post('/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const key = `login:${ip}`;

  // Check the lockout before touching the DB so a locked IP can't probe for
  // valid usernames via error-message timing / shape.
  const gate = rateLimit.check(key);
  if (!gate.allowed) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000).toString());
    return res.status(429).json({
      error: 'Too many failed login attempts. Try again later.',
      retryAfterMs: gate.retryAfterMs,
    });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? COLLATE NOCASE'
  ).get(username) as unknown as UserRow | undefined;

  // Any failed reason (missing user, disabled, wrong password) counts as one
  // failed attempt. Missing-user is intentionally included so an attacker
  // can't enumerate usernames for free — they hit the same ladder.
  const badPassword = !user || !!user.disabled_at || !verifyPassword(password, user.password_hash);
  if (badPassword) {
    const fail = rateLimit.recordFailure(key);
    if (fail.locked) {
      res.setHeader('Retry-After', Math.ceil(fail.retryAfterMs / 1000).toString());
      return res.status(429).json({
        error: 'Too many failed login attempts. Try again later.',
        retryAfterMs: fail.retryAfterMs,
      });
    }
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Success — createSession returns the RAW id for the cookie. The DB
  // stores its hash. Clear the rate-limit bucket so the caller isn't
  // punished by any earlier fat-fingering on the same IP.
  const rawSid = createSession(user!.id, {
    userAgent: req.get('user-agent') ?? undefined,
    ip: req.ip ?? undefined,
  });
  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user!.id);
  rateLimit.reset(key);
  writeEvent({ eventType: 'login', actor: user!.username });

  res.cookie(SESSION_COOKIE_NAME, rawSid, cookieOptions(req));
  res.json({ user: { id: user!.id, username: user!.username, role: user!.role } });
});

router.post('/logout', (req, res) => {
  const raw = (req as any).cookies?.[SESSION_COOKIE_NAME];
  if (typeof raw === 'string') destroySessionByRawId(raw);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, (req, res) => {
  // Rate-limit key is per-user (not per-session). A stolen session that
  // starts guessing the current password locks EVERY session for that user
  // via the same ladder as /login. Successful change resets the bucket.
  const key = `pwchange:${req.user!.id}`;

  const gate = rateLimit.check(key);
  if (!gate.allowed) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000).toString());
    return res.status(429).json({
      error: 'Too many failed password-change attempts. Try again later.',
      retryAfterMs: gate.retryAfterMs,
    });
  }

  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  // Weak-new-password isn't a failed guess against the CURRENT password —
  // it's just malformed input, so it doesn't feed the lockout ladder.
  if (newPassword.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as unknown as UserRow | undefined;
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  if (!verifyPassword(currentPassword, user.password_hash)) {
    const fail = rateLimit.recordFailure(key);
    if (fail.locked) {
      res.setHeader('Retry-After', Math.ceil(fail.retryAfterMs / 1000).toString());
      return res.status(429).json({
        error: 'Too many failed password-change attempts. Try again later.',
        retryAfterMs: fail.retryAfterMs,
      });
    }
    return res.status(403).json({ error: 'Current password is incorrect' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(user.id, req.sessionId ?? '');
  rateLimit.reset(key);
  writeEvent({ eventType: 'password_change', actor: user.username });
  res.json({ ok: true });
});

router.get('/sessions', requireAuth, (req, res) => {
  const rows = listSessionsForUser(req.user!.id);
  const currentSid = req.sessionId;
  res.json({
    sessions: rows.map((s: SessionRow) => ({
      id: s.id,
      created_at: s.created_at,
      expires_at: s.expires_at,
      user_agent: s.user_agent,
      ip: s.ip,
      isCurrent: s.id === currentSid,
    })),
  });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  // :id here is the stored (hashed) id — that's what listSessionsForUser
  // returned to the client. req.sessionId is also the stored id, so the
  // "this is my current session" check is a stored-vs-stored compare.
  const storedId = req.params.id;
  const row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(storedId) as any;
  if (!row) return res.status(404).json({ error: 'Session not found' });
  if (row.user_id !== req.user!.id) return res.status(403).json({ error: 'Not your session' });
  destroySessionByStoredId(storedId);
  if (storedId === req.sessionId) res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

export default router;
