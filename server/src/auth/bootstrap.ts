import readline from 'node:readline';
import db from '../db';
import { hashPassword } from './passwords';
import { destroyAllSessionsForUser } from './sessions';
import { writeEvent } from '../eventLog';

// Usernames may be plain handles or email addresses — `@` and `+` are
// included in the character class, and the upper bound is 64 chars to
// comfortably fit real-world emails.
const USERNAME_RE = /^[a-zA-Z0-9._@+-]{2,64}$/;
const MIN_PASSWORD_LEN = 8;

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

function activeAdminExists(): boolean {
  return !!db.prepare(
    "SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL LIMIT 1"
  ).get();
}

function usernameTaken(username: string): boolean {
  return !!db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

function createAdmin(username: string, password: string): void {
  db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(username, hashPassword(password), 'admin');
}

// Visible line input. Backed by readline so users get the usual editing
// affordances (arrow keys, backspace) on both cmd.exe and Unix TTYs.
function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Hidden line input — echoes nothing while the user types, honors Backspace
// and Ctrl+C. Built on raw mode so it doesn't rely on readline internals.
function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
    let value = '';
    process.stdout.write(prompt);

    const done = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r') { done(); resolve(value); return; }
        if (code === 3) { // Ctrl+C
          done();
          process.stdout.write('^C\n');
          process.exit(130);
        }
        if (code === 8 || code === 127) { // Backspace / DEL
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (code < 0x20) continue; // absorb other control chars
        value += ch;
      }
    };

    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
  });
}

// Bootstrap from EXOTICK_ADMIN_USERNAME + EXOTICK_ADMIN_PASSWORD if either is
// set. Both must be present and valid, or we throw with a checklist so a
// misconfigured Docker container fails loudly instead of falling through to
// an impossible interactive prompt.
function envCredentials(): { username: string; password: string } | null {
  const username = process.env.EXOTICK_ADMIN_USERNAME?.trim();
  const password = process.env.EXOTICK_ADMIN_PASSWORD;
  if (!username && !password) return null;

  const problems: string[] = [];
  if (!username) problems.push('EXOTICK_ADMIN_USERNAME is not set');
  if (!password) problems.push('EXOTICK_ADMIN_PASSWORD is not set');
  if (username && !USERNAME_RE.test(username)) {
    problems.push('EXOTICK_ADMIN_USERNAME must be 2-64 chars: letters, digits, and any of . _ - @ +');
  }
  if (password && password.length < MIN_PASSWORD_LEN) {
    problems.push(`EXOTICK_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  if (username && usernameTaken(username)) {
    problems.push(`user "${username}" already exists — pick a different EXOTICK_ADMIN_USERNAME or edit the DB`);
  }
  if (problems.length > 0) {
    throw new BootstrapError(
      'Cannot bootstrap admin from environment variables:\n  - ' + problems.join('\n  - ')
    );
  }
  return { username: username!, password: password! };
}

async function promptForCredentials(): Promise<{ username: string; password: string }> {
  process.stdout.write(
    '\n' +
    '================================================================\n' +
    ' exotick — first-time setup\n' +
    '================================================================\n' +
    ' No admin user exists yet. Create one now.\n' +
    ' Password can be changed later from Settings > Change my password.\n' +
    `   Username : 2-64 chars — letters, digits, or . _ - @ + (emails work)\n` +
    `   Password : at least ${MIN_PASSWORD_LEN} characters\n` +
    '\n'
  );

  let username = '';
  for (;;) {
    username = (await askLine('Admin username: ')).trim();
    if (!USERNAME_RE.test(username)) {
      console.log('  → Invalid. Use 2-64 letters, digits, or any of . _ - @ +');
      continue;
    }
    if (usernameTaken(username)) {
      console.log(`  → "${username}" is already in the DB (likely disabled). Pick another.`);
      continue;
    }
    break;
  }

  let password = '';
  for (;;) {
    password = await askSecret('Admin password: ');
    if (password.length < MIN_PASSWORD_LEN) {
      console.log(`  → Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      continue;
    }
    const confirm = await askSecret('Re-enter password: ');
    if (confirm !== password) {
      console.log('  → Passwords do not match. Try again.');
      continue;
    }
    break;
  }

  return { username, password };
}

/**
 * Ensure an active admin exists.
 *
 *   - Active admin in DB              → no-op (idempotent, safe every boot).
 *   - EXOTICK_ADMIN_USERNAME + PASSWORD in env → use them (Docker, CI).
 *   - stdin is a TTY                  → prompt interactively.
 *   - Neither                         → throw BootstrapError, server exits.
 *
 * The admin can rotate their password later from Settings › Change my
 * password inside the app — the credentials collected here are only used
 * for the very first sign-in.
 */
export async function bootstrapAdmin(): Promise<void> {
  if (activeAdminExists()) return;

  const fromEnv = envCredentials();
  if (fromEnv) {
    createAdmin(fromEnv.username, fromEnv.password);
    console.log(`[exotick] Bootstrapped admin user "${fromEnv.username}" from environment variables.`);
    return;
  }

  if (!process.stdin.isTTY) {
    throw new BootstrapError(
      'No admin user exists and no bootstrap credentials were provided.\n' +
      '  - Run the server in an interactive terminal to be prompted, OR\n' +
      '  - Set EXOTICK_ADMIN_USERNAME and EXOTICK_ADMIN_PASSWORD in the environment.'
    );
  }

  const { username, password } = await promptForCredentials();
  createAdmin(username, password);
  console.log(
    `\n[exotick] Admin "${username}" created. Sign in at http://localhost:5173/login.\n` +
    '          Change the password anytime from Settings › Change my password.\n'
  );
}

// ── Admin password recovery (host-side CLI) ─────────────────────────────────
// A locked-out admin can't self-serve from the web UI, but whoever runs exotick
// has shell / `docker compose exec` access — so recovery lives on the host, not
// behind a stored recovery secret. resetAdmin() sets a new password for an
// existing admin and revokes that admin's sessions. Wired to `npm run
// reset-admin` (local) and runnable in Docker via the compiled entry.

export class ResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetError';
  }
}

interface AdminRow { id: number; username: string }

function listAdmins(): AdminRow[] {
  return db.prepare("SELECT id, username FROM users WHERE role = 'admin' ORDER BY id").all() as unknown as AdminRow[];
}

// Confirmed hidden password entry, reusing the same raw-mode reader as bootstrap.
async function askNewPassword(): Promise<string> {
  for (;;) {
    const pw = await askSecret('New admin password: ');
    if (pw.length < MIN_PASSWORD_LEN) {
      console.log(`  → Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      continue;
    }
    const confirm = await askSecret('Re-enter password: ');
    if (confirm !== pw) {
      console.log('  → Passwords do not match. Try again.');
      continue;
    }
    return pw;
  }
}

/**
 * Reset an existing admin's password from the host.
 *
 *   - No admin in the DB              → throw ResetError (bootstrap first).
 *   - Which admin: the sole admin, or EXOTICK_RESET_USERNAME, or (interactive
 *     with several admins) a prompt.
 *   - New password: EXOTICK_RESET_PASSWORD if set, else an interactive prompt.
 *
 * Also clears disabled_at (a disabled sole admin is a lock-out too) and revokes
 * all of that admin's sessions, so a leaked/expired session can't linger.
 */
export async function resetAdmin(): Promise<void> {
  const admins = listAdmins();
  if (admins.length === 0) {
    throw new ResetError(
      'No admin account exists to reset.\n' +
      '  - Start the server to bootstrap one (interactive prompt), OR\n' +
      '  - Set EXOTICK_ADMIN_USERNAME + EXOTICK_ADMIN_PASSWORD and start the server.'
    );
  }

  // Pick the target admin.
  const envUser = process.env.EXOTICK_RESET_USERNAME?.trim();
  let target: AdminRow | undefined;
  if (envUser) {
    target = admins.find((a) => a.username.toLowerCase() === envUser.toLowerCase());
    if (!target) {
      throw new ResetError(`No admin named "${envUser}". Admins: ${admins.map((a) => a.username).join(', ')}`);
    }
  } else if (admins.length === 1) {
    target = admins[0];
  } else if (process.stdin.isTTY) {
    process.stdout.write(`Admins: ${admins.map((a) => a.username).join(', ')}\n`);
    for (;;) {
      const name = (await askLine('Admin username to reset: ')).trim();
      target = admins.find((a) => a.username.toLowerCase() === name.toLowerCase());
      if (target) break;
      console.log('  → No admin by that name. Try again.');
    }
  } else {
    throw new ResetError(
      `Multiple admins exist (${admins.map((a) => a.username).join(', ')}). ` +
      'Set EXOTICK_RESET_USERNAME to choose which one to reset.'
    );
  }

  // Pick the new password.
  let newPassword: string;
  const envPw = process.env.EXOTICK_RESET_PASSWORD;
  if (typeof envPw === 'string') {
    if (envPw.length < MIN_PASSWORD_LEN) {
      throw new ResetError(`EXOTICK_RESET_PASSWORD must be at least ${MIN_PASSWORD_LEN} characters.`);
    }
    newPassword = envPw;
  } else if (process.stdin.isTTY) {
    process.stdout.write(`\nResetting the password for admin "${target.username}".\n`);
    newPassword = await askNewPassword();
  } else {
    throw new ResetError('No interactive terminal and EXOTICK_RESET_PASSWORD is not set — nothing to do.');
  }

  db.prepare('UPDATE users SET password_hash = ?, disabled_at = NULL WHERE id = ?')
    .run(hashPassword(newPassword), target.id);
  destroyAllSessionsForUser(target.id);
  writeEvent({ eventType: 'password_reset', actor: 'reset-admin-cli', reason: `target: ${target.username} (host CLI reset)` });

  console.log(`\n[exotick] Password reset for admin "${target.username}". All of that admin's sessions were revoked.`);
}
