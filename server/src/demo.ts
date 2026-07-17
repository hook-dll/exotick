import db from './db';
import { hashPassword } from './auth/passwords';
import { seedSamplesLibrary } from './routes/samples';

// ── Demo mode ────────────────────────────────────────────────────────────────
// Opt-in, env-gated, and OFF by default: normal deploys and local dev are
// completely unaffected. It exists so a PUBLIC demo instance (e.g. Render) can
// hand out a shared login without a visitor being able to lock everyone else
// out or take over the box:
//   - A fixed low-privilege account (editor) is seeded with known credentials
//     that are re-asserted on every boot, so the login advertised on the sign-in
//     screen always works.
//   - Password changes are refused in demo mode (see routes/auth.ts), so nobody
//     can rotate the shared account's password out from under the next visitor.
//   - editor role means visitors can create/edit cases and compose/run test
//     runs (the interesting part) but CANNOT manage users, change branding, or
//     touch backups — so there's no admin surface to grief.
//   - A Samples library is seeded when the instance is empty, so a fresh (or
//     reset) demo is never blank.

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// The public account is deliberately an editor — the highest role that still
// has zero user-management / lockout powers. (admin is bootstrap-only and
// excluded from the run workflow; editor is the sweet spot for a demo.)
const DEMO_ROLE = 'editor';

export function demoCredentials(): { username: string; password: string } {
  const username = process.env.EXOTICK_DEMO_USERNAME?.trim() || 'demo';
  const password = process.env.EXOTICK_DEMO_PASSWORD || 'demo';
  return { username, password };
}

// Idempotent; safe to call on every boot. No-op unless DEMO_MODE is on.
export function seedDemo(): void {
  if (!isDemoMode()) return;
  const { username, password } = demoCredentials();

  // Upsert the shared account, re-asserting password/role/enabled so a
  // persisted DB can't drift from what the login screen advertises.
  const existing = db.prepare(
    'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
  ).get(username) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ?, disabled_at = NULL WHERE id = ?')
      .run(hashPassword(password), DEMO_ROLE, existing.id);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), DEMO_ROLE);
  }

  // Seed sample content only when there's nothing to show yet.
  const caseCount = (db.prepare('SELECT COUNT(*) AS n FROM test_cases').get() as { n: number } | undefined)?.n ?? 0;
  if (caseCount === 0) seedSamplesLibrary();

  console.log(
    `[exotick] DEMO_MODE on — public login "${username}" (role ${DEMO_ROLE}); password changes disabled.`
  );
}
