import type { Request, Response, NextFunction } from 'express';
import { resolveSession, SESSION_COOKIE_NAME, type Role, type UserRow } from './sessions';

export interface RequestUser {
  id: number;
  username: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: RequestUser;
      sessionId?: string;
    }
  }
}

function toRequestUser(row: UserRow): RequestUser {
  return { id: row.id, username: row.username, role: row.role };
}

// Reads the session cookie and attaches the resolved user. Any request that
// gets past this middleware has a real, signed-in identity — no anonymous
// fallback, no synthetic admin.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const sid = (req as any).cookies?.[SESSION_COOKIE_NAME];
  if (typeof sid !== 'string' || sid.length === 0) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const resolved = resolveSession(sid);
  if (!resolved) {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.user = toRequestUser(resolved.user);
  req.sessionId = resolved.session.id;
  next();
}

// Role hierarchy: admin > editor > runner > watcher.
const ROLE_RANK: Record<Role, number> = { watcher: 1, runner: 2, editor: 3, admin: 4 };

export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// Gate for the test-run workflow (compose / start / mark / finish / take over).
// Admin is deliberately excluded — the account is for user management, not
// day-to-day runs — so requireRole('runner') alone (which admin passes via
// the hierarchy) isn't enough. Editors and runners are the only two roles
// that can act on a run.
export function requireCanRun(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.role !== 'editor' && req.user.role !== 'runner') {
    res.status(403).json({ error: "Admins can't act on test runs. Sign in as an editor or runner." });
    return;
  }
  next();
}
