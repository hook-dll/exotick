import { Router } from 'express';
import db from '../db';
import { requireRole } from '../auth/middleware';

const router = Router();

// Persisted operator-tunable settings. Currently just the take over
// cooldown window; extend by adding more keys below and matching routes.

const COOLDOWN_KEY = 'take_over_cooldown_minutes';
const COOLDOWN_DEFAULT_MINUTES = 60;
const COOLDOWN_MAX_MINUTES = 10080; // 7 days — arbitrary but keeps abuse windows bounded

/**
 * Reads the take over cooldown (in minutes). Falls back to the default when
 * unset or malformed. Called from routes/testRuns.ts every time a take over
 * or run listing needs the current value.
 */
export function getCooldownMinutes(): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(COOLDOWN_KEY) as any;
  if (!row) return COOLDOWN_DEFAULT_MINUTES;
  const n = Number(row.value);
  if (!Number.isFinite(n) || n < 0 || n > COOLDOWN_MAX_MINUTES) return COOLDOWN_DEFAULT_MINUTES;
  return Math.floor(n);
}

// Any authenticated user can read the current cooldown (the UI shows it as
// context on the take over dialog and on Settings for admins).
router.get('/take-over-cooldown', (_req, res) => {
  res.json({ minutes: getCooldownMinutes() });
});

router.put('/take-over-cooldown', requireRole('admin'), (req, res) => {
  const raw = Number(req.body?.minutes);
  if (!Number.isFinite(raw) || raw < 0 || raw > COOLDOWN_MAX_MINUTES) {
    return res.status(400).json({
      error: `minutes must be an integer between 0 and ${COOLDOWN_MAX_MINUTES}`,
    });
  }
  const minutes = Math.floor(raw);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(COOLDOWN_KEY, String(minutes));
  res.json({ ok: true, minutes });
});

export default router;
