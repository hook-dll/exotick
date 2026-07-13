/**
 * Captures a handful of static PNG screenshots across different pages, each
 * signed in as a different role (admin / editor / runner / watcher), for the
 * docs/screens showcase folder.
 *
 * Isolated-server pattern (fresh temp DATA_DIR from env admin, wiped after).
 * Seeds sample data + one active run + one completed run via the API, then
 * screenshots each page in an already-authenticated context.
 *
 * Prereqs:  server/dist + client/dist built.
 * Run:      node docs/screens/capture-screenshots.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '../..');
const SHOTS = __dirname;
const PORT = 3991;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { username: 'admin', password: 'demo-admin-pw' };
const EDITOR = { username: 'sam', password: 'demo-editor-pw' };
const RUNNER = { username: 'bob', password: 'demo-runner-pw' };
const WATCHER = { username: 'wendy', password: 'demo-watcher-pw' };
const TEMP_DATA = path.join(os.tmpdir(), `exotick-shots-${Date.now()}`);
const VIEWPORT = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await sleep(300);
  }
  throw new Error(`Server on :${PORT} never became ready`);
}
function sidFrom(res) {
  const arr = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of arr) { const m = c.match(/exotick_sid=([^;]+)/); if (m) return m[1]; }
  return null;
}
async function login(creds) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
  if (!r.ok) throw new Error(`login ${creds.username}: ${r.status}`);
  const sid = sidFrom(r); if (!sid) throw new Error(`no cookie for ${creds.username}`);
  return sid;
}
async function apiJson(method, p, body, sid) {
  const r = await fetch(`${BASE}${p}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(sid ? { Cookie: `exotick_sid=${sid}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

const server = spawn(process.execPath, [path.join(PROJECT, 'server', 'dist', 'index.js')], {
  cwd: path.join(PROJECT, 'server'),
  env: { ...process.env, PORT: String(PORT), EXOTICK_DATA_DIR: TEMP_DATA, NODE_ENV: 'production',
         EXOTICK_ADMIN_USERNAME: ADMIN.username, EXOTICK_ADMIN_PASSWORD: ADMIN.password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

let browser;
async function shot(name, sid, fn) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  ctx.on('page', (p) => p.on('dialog', (d) => d.accept()));
  await ctx.addCookies([{ name: 'exotick_sid', value: sid, url: BASE }]);
  const page = await ctx.newPage();
  console.log(`▶ ${name}`);
  try { await fn(page); await page.screenshot({ path: path.join(SHOTS, name), type: 'png' }); }
  finally { await page.close(); await ctx.close(); }
}

async function main() {
  mkdirSync(TEMP_DATA, { recursive: true });
  if (!existsSync(path.join(PROJECT, 'server', 'dist', 'index.js'))) throw new Error('server not built');
  if (!existsSync(path.join(PROJECT, 'client', 'dist', 'index.html'))) throw new Error('client not built');
  await waitForServer();

  // ── Seed users + data via API ────────────────────────────────
  const adminSid = await login(ADMIN);
  for (const u of [EDITOR, RUNNER, WATCHER]) {
    await apiJson('POST', '/api/users', { username: u.username, password: u.password, role:
      u === EDITOR ? 'editor' : u === RUNNER ? 'runner' : 'watcher' }, adminSid);
  }
  const samSid = await login(EDITOR);
  const bobSid = await login(RUNNER);
  const wendySid = await login(WATCHER);

  const lib = await apiJson('POST', '/api/samples/load', {}, samSid);
  const libId = lib.library.id;
  const sec = await apiJson('GET', `/api/sections?library_id=${libId}`, undefined, samSid);
  const caseIds = [
    ...sec.sections.flatMap((s) => s.test_cases.map((c) => c.id)),
    ...sec.unsectioned.map((c) => c.id),
  ];

  // Active run owned by the runner, with a few live marks.
  const active = await apiJson('POST', '/api/test-runs', { name: 'Nightly smoke', runner_name: RUNNER.username, case_ids: caseIds.slice(0, 8) }, bobSid);
  await apiJson('POST', `/api/test-runs/${active.id}/start`, {}, bobSid);
  const activeFull = await apiJson('GET', `/api/test-runs/${active.id}`, undefined, bobSid);
  await apiJson('PATCH', `/api/test-runs/items/${activeFull.items[0].id}`, { status: 'pass' }, bobSid);
  await apiJson('PATCH', `/api/test-runs/items/${activeFull.items[1].id}`, { status: 'pass' }, bobSid);
  await apiJson('PATCH', `/api/test-runs/items/${activeFull.items[2].id}`, { status: 'fail' }, bobSid);

  // Completed run by the editor, marked + finished (gives History + Contributors).
  const done = await apiJson('POST', '/api/test-runs', { name: 'Release 2.3 sign-off', runner_name: EDITOR.username, case_ids: caseIds.slice(0, 6) }, samSid);
  await apiJson('POST', `/api/test-runs/${done.id}/start`, {}, samSid);
  const doneFull = await apiJson('GET', `/api/test-runs/${done.id}`, undefined, samSid);
  for (let i = 0; i < doneFull.items.length; i++) {
    await apiJson('PATCH', `/api/test-runs/items/${doneFull.items[i].id}`, { status: i % 3 === 2 ? 'fail' : 'pass' }, samSid);
  }
  await apiJson('POST', `/api/test-runs/${done.id}/finish`, {}, samSid);

  browser = await chromium.launch();

  // ── Screenshots ──────────────────────────────────────────────
  // Runner — Dashboard (their active run → Resume)
  await shot('shot-dashboard-runner.png', bobSid, async (page) => {
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.getByText('Nightly smoke').waitFor();
    await sleep(600);
  });

  // Editor — Edit Mode (Samples library, a case preview open)
  await shot('shot-edit-editor.png', samSid, async (page) => {
    await page.goto(`${BASE}/edit`, { waitUntil: 'load' });
    await page.locator('select[title="Switch library"]').selectOption({ label: 'Samples' });
    await page.getByText('Auth', { exact: true }).waitFor();
    await page.getByText('Sign up with valid email creates an account').click();
    await sleep(700);
  });

  // Runner — Compose (cases selected)
  await shot('shot-compose-runner.png', bobSid, async (page) => {
    await page.goto(`${BASE}/compose`, { waitUntil: 'load' });
    await page.locator('select[title="Switch library"]').selectOption({ label: 'Samples' });
    await page.getByText('Auth', { exact: true }).waitFor();
    await page.getByPlaceholder('e.g. Sprint 14 Regression').fill('Sprint 21 regression');
    await page.locator('input[title="Select all cases in section"]').first().click();
    await sleep(700);
  });

  // Watcher — viewing the active run read-only
  await shot('shot-activerun-watcher.png', wendySid, async (page) => {
    await page.goto(`${BASE}/run/${active.id}`, { waitUntil: 'load' });
    await page.getByText('Nightly smoke').waitFor();
    await sleep(700);
  });

  // Admin — Settings (scroll to Users management)
  await shot('shot-settings-admin.png', adminSid, async (page) => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'load' });
    await page.getByText('Branding', { exact: true }).waitFor();
    try { await page.getByText('Users', { exact: true }).scrollIntoViewIfNeeded(); } catch {}
    await sleep(700);
  });

  // Admin — History detail of the completed run (summary + contributors)
  await shot('shot-history-admin.png', adminSid, async (page) => {
    await page.goto(`${BASE}/history/${done.id}`, { waitUntil: 'load' });
    await page.getByText('Release 2.3 sign-off').first().waitFor();
    await sleep(700);
  });

  await browser.close();
  console.log('\nScreenshots written to docs/screens/');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch {}
    if (process.platform === 'win32' && server.pid) { try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    else { server.kill(); }
    await sleep(800);
    try { rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  });
