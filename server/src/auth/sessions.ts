import { createHash, randomBytes } from 'crypto';
import db from '../db';

export type Role = 'admin' | 'editor' | 'runner' | 'watcher';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
  disabled_at: string | null;
  last_login_at: string | null;
}

export interface SessionRow {
  // Stored form: sha256(rawSessionId). The raw ID lives ONLY in the cookie
  // and in memory during the request that just created / validated it.
  // Anyone who steals a copy of the sessions table cannot impersonate users
  // — hashing has 2^256 collision resistance, and the raw ID is 32 random
  // bytes so preimage brute force is infeasible.
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

// 30 days sliding window. Every authenticated request extends this.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Only rewrite expires_at when < 24h has passed since last slide — cheap
// optimization so we don't UPDATE on every single request.
const SLIDE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function newRawSessionId(): string {
  return randomBytes(32).toString('base64url');
}

// Deterministic one-way hash of a raw session ID → the value stored as
// `sessions.id`. Same input always maps to the same key, so cookie lookups
// stay a single indexed query.
export function hashSid(rawId: string): string {
  return createHash('sha256').update(rawId).digest('base64url');
}

/**
 * Create a session. Returns the RAW session ID — set this as the cookie
 * value. The DB stores only its hash, so a leaked sessions table cannot be
 * used to hijack a live session.
 */
export function createSession(userId: number, meta: { userAgent?: string; ip?: string }): string {
  const rawId = newRawSessionId();
  const storedId = hashSid(rawId);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)`
  ).run(storedId, userId, expiresAt, meta.userAgent ?? null, meta.ip ?? null);
  return rawId;
}

/**
 * Look up a session given the raw ID from the cookie. Returns null if the
 * session is missing, expired, or the user is disabled. Slides expiry when
 * more than 24h old.
 *
 * The returned `session.id` is the STORED (hashed) id — it's fine to use
 * for equality checks against other stored ids, and it's what `req.sessionId`
 * should be so downstream code can match against listSessionsForUser rows.
 */
export function resolveSession(rawSessionId: string): { session: SessionRow; user: UserRow } | null {
  if (!rawSessionId) return null;
  const storedId = hashSid(rawSessionId);
  const row = db.prepare(
    `SELECT s.id AS s_id, s.user_id, s.created_at AS s_created_at, s.expires_at, s.user_agent, s.ip,
            u.id AS u_id, u.username, u.password_hash, u.role, u.created_at AS u_created_at,
            u.disabled_at, u.last_login_at
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).get(storedId) as any;
  if (!row) return null;

  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(storedId);
    return null;
  }
  if (row.disabled_at) return null;

  // Slide expiry if we haven't in the last 24h.
  const lastSlideBase = new Date(row.expires_at).getTime() - SESSION_TTL_MS;
  if (Date.now() - lastSlideBase > SLIDE_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(newExpiresAt, storedId);
    row.expires_at = newExpiresAt;
  }

  return {
    session: {
      id: row.s_id,
      user_id: row.user_id,
      created_at: row.s_created_at,
      expires_at: row.expires_at,
      user_agent: row.user_agent,
      ip: row.ip,
    },
    user: {
      id: row.u_id,
      username: row.username,
      password_hash: row.password_hash,
      role: row.role,
      created_at: row.u_created_at,
      disabled_at: row.disabled_at,
      last_login_at: row.last_login_at,
    },
  };
}

// Delete a session by the raw ID from a cookie. Used by /logout.
export function destroySessionByRawId(rawSessionId: string): void {
  if (!rawSessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashSid(rawSessionId));
}

// Delete a session by the stored (hashed) ID. Used by /sessions/:id where
// the client sent us a stored ID it got from listSessionsForUser.
export function destroySessionByStoredId(storedId: string): void {
  if (!storedId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(storedId);
}

export function destroyAllSessionsForUser(userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function pruneExpiredSessions(): number {
  const r = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return Number(r.changes);
}

// Returns rows with `id` = stored (hashed) ids. Safe to expose in API
// responses — they cannot be used as cookies. Client uses them only as
// opaque handles for the revoke endpoint.
export function listSessionsForUser(userId: number): SessionRow[] {
  return db.prepare(
    'SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as unknown as SessionRow[];
}

export const SESSION_COOKIE_NAME = 'exotick_sid';
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
