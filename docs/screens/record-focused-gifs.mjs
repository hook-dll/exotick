/**
 * Records four short, focused feature GIFs for the README / docs.
 *
 * Isolated-server pattern (fresh temp DATA_DIR, admin from env, no pollution
 * of your real data). Each scene runs in its own already-authenticated
 * browser context (cookie injected, so no login frames), records a WebM, and
 * is converted to an optimized GIF via ffmpeg-static.
 *
 * Scenes:
 *   1  library.gif   — load samples, add a case, add many, add a section
 *   2  compose.gif   — pick a library, select cases, Save & Start
 *   3  edit.gif      — move a case, edit it to add a markdown description
 *   4  branding.gif  — set an emoji app name + upload a logo, see it apply
 *
 * Prereqs:  server/dist + client/dist built; `npm install --no-save ffmpeg-static`.
 * Run:      node docs/screens/record-focused-gifs.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '../..');
const SHOTS = __dirname;
const PORT = 3990;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { username: 'admin', password: 'demo-admin-pw' };
const EDITOR = { username: 'sam', password: 'demo-editor-pw' };
const TEMP_DATA = path.join(os.tmpdir(), `exotick-gifs-${Date.now()}`);
const VIDEO_DIR = path.join(os.tmpdir(), `exotick-gifvid-${Date.now()}`);
const VIEWPORT = { width: 1120, height: 720 };
const SIDEBAR = 208; // nav is w-52 = 208px; crop it out for content scenes

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
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds),
  });
  if (!r.ok) throw new Error(`login ${creds.username} failed: ${r.status}`);
  const sid = sidFrom(r);
  if (!sid) throw new Error(`no session cookie for ${creds.username}`);
  return sid;
}

function findFfmpeg() {
  const staticPath = path.join(PROJECT, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (existsSync(staticPath)) return staticPath;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  if (which.status === 0) { const line = which.stdout.toString().split(/\r?\n/)[0].trim(); if (line && existsSync(line)) return line; }
  return null;
}

const server = spawn(process.execPath, [path.join(PROJECT, 'server', 'dist', 'index.js')], {
  cwd: path.join(PROJECT, 'server'),
  env: { ...process.env, PORT: String(PORT), EXOTICK_DATA_DIR: TEMP_DATA, NODE_ENV: 'production',
         EXOTICK_ADMIN_USERNAME: ADMIN.username, EXOTICK_ADMIN_PASSWORD: ADMIN.password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

async function runScene(name, sid, fn) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT } });
  context.on('page', (p) => p.on('dialog', (d) => d.accept()));
  await context.addCookies([{ name: 'exotick_sid', value: sid, url: BASE }]);
  const page = await context.newPage();
  console.log(`\n▶ scene: ${name}`);
  try { await fn(page); } finally { await page.close(); await context.close(); }
  const webms = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'))
    .map((f) => path.join(VIDEO_DIR, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return webms[0];
}

function toGif(webm, outName, { crop, width }) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found (npm install --no-save ffmpeg-static)');
  const out = path.join(SHOTS, outName);
  const pre = crop ? `crop=${crop},` : '';
  const filter = `${pre}fps=13,scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  // Trim the opening ~0.8s: recordVideo starts before the SPA paints, so the
  // first frames are a blank white screen. Output seeking (-ss after -i) is
  // frame-accurate. This runs on every loop of the GIF, so it's worth it.
  const r = spawnSync(ffmpeg, ['-y', '-i', webm, '-ss', '0.8', '-vf', filter, '-loop', '0', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) { console.error(r.stderr?.toString().slice(-800)); throw new Error(`ffmpeg failed for ${outName}`); }
  console.log(`✓ ${outName} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
}

let browser;
async function main() {
  mkdirSync(TEMP_DATA, { recursive: true });
  mkdirSync(VIDEO_DIR, { recursive: true });
  if (!existsSync(path.join(PROJECT, 'server', 'dist', 'index.js'))) throw new Error('server not built');
  if (!existsSync(path.join(PROJECT, 'client', 'dist', 'index.html'))) throw new Error('client not built');

  await waitForServer();
  console.log('server ready');

  // Seed an editor account (admin was bootstrapped from env).
  const adminSid = await login(ADMIN);
  const mk = await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `exotick_sid=${adminSid}` },
    body: JSON.stringify({ username: EDITOR.username, password: EDITOR.password, role: 'editor' }),
  });
  if (!mk.ok && mk.status !== 409) throw new Error(`create editor failed: ${mk.status}`);
  const editorSid = await login(EDITOR);

  browser = await chromium.launch();

  // Make a nice dummy logo (gradient tile + emoji) to upload in the branding scene.
  const logoPath = path.join(VIDEO_DIR, 'logo.png');
  {
    const p = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await p.setContent(`<body style="margin:0"><div id="t" style="width:128px;height:128px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6366f1,#a855f7);border-radius:26px;font-size:70px">🧪</div></body>`);
    await p.locator('#t').screenshot({ path: logoPath });
    await p.close();
  }

  const CONTENT_CROP = `${VIEWPORT.width - SIDEBAR}:${VIEWPORT.height}:${SIDEBAR}:0`;

  // ── Scene 1: library — load samples, add a case, add many, add a section ──
  const w1 = await runScene('library', editorSid, async (page) => {
    await page.goto(`${BASE}/edit`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Load sample data' }).click();
    await page.getByText('Auth', { exact: true }).waitFor();
    await sleep(1000);
    // add a single case to the first section
    await page.getByText('+ Add test case').first().click();
    const caseInput = page.getByPlaceholder('Test case description...');
    await caseInput.fill('Session survives a page refresh');
    await sleep(500); await caseInput.press('Enter');
    await sleep(900);
    // add several at once
    await page.getByText('+ Add many').first().click();
    const many = page.getByPlaceholder(/Valid login works/);
    await many.fill('Password reset email arrives\nRemember-me keeps me signed in\nLogout clears the session');
    await sleep(600);
    await page.getByRole('button', { name: /^Add \d+ cases$/ }).click();
    await sleep(1000);
    // add a new section
    await page.getByText('+ Add section').first().click();
    const sec = page.getByPlaceholder('Section name...');
    await sec.fill('Smoke Tests');
    await sleep(500); await sec.press('Enter');
    await sleep(1300);
  });
  toGif(w1, 'gif-1-library.gif', { crop: CONTENT_CROP, width: 820 });

  // ── Scene 2: compose — pick library, select cases, Save & Start ──
  const w2 = await runScene('compose', editorSid, async (page) => {
    await page.goto(`${BASE}/compose`, { waitUntil: 'load' });
    await page.locator('select[title="Switch library"]').selectOption({ label: 'Samples' });
    await page.getByText('Auth', { exact: true }).waitFor();
    await sleep(700);
    await page.getByPlaceholder('e.g. Sprint 14 Regression').fill('Smoke — build 42');
    await sleep(600);
    const selAll = page.locator('input[title="Select all cases in section"]');
    const nBoxes = await selAll.count();
    for (let i = 0; i < nBoxes; i++) { await selAll.nth(i).click(); await sleep(400); }
    await sleep(500);
    await page.getByRole('button', { name: 'Save & Start' }).click();
    await page.waitForURL(/\/run\/\d+/);
    await sleep(900);
    // a couple of live marks for flavor (best-effort)
    try {
      const pass = page.getByRole('button', { name: 'Pass' });
      await pass.nth(0).click(); await sleep(450);
      await pass.nth(1).click(); await sleep(450);
      const fail = page.getByRole('button', { name: 'Fail' });
      await fail.nth(2).click(); await sleep(900);
    } catch {}
    await sleep(700);
  });
  toGif(w2, 'gif-2-compose.gif', { crop: CONTENT_CROP, width: 820 });

  // ── Scene 3: edit — move a case, edit it to add a markdown description ──
  const w3 = await runScene('edit', editorSid, async (page) => {
    await page.goto(`${BASE}/edit`, { waitUntil: 'load' });
    await page.locator('select[title="Switch library"]').selectOption({ label: 'Samples' });
    await page.getByText('Auth', { exact: true }).waitFor();
    await sleep(800);
    const row = page.locator('div.group').filter({ hasText: 'Sign in with correct password lands on Dashboard' }).first();
    await row.scrollIntoViewIfNeeded();
    await row.hover(); await sleep(500);
    await row.locator('button[title="Move down"]').click();
    await sleep(900);
    await row.hover(); await sleep(300);
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await sleep(700);
    const notes = page.getByPlaceholder(/Supports markdown/);
    await notes.fill('**Steps**\n1. Open the login page\n2. Enter a valid email + password\n3. Submit\n\n**Expected:** lands on the Dashboard.');
    await sleep(900);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await sleep(1300);
  });
  toGif(w3, 'gif-3-edit.gif', { crop: CONTENT_CROP, width: 820 });

  // ── Scene 4: branding — emoji name + logo (keep sidebar to show the result) ──
  const w4 = await runScene('branding', adminSid, async (page) => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'load' });
    await page.getByText('Branding', { exact: true }).waitFor();
    const nameInput = page.getByPlaceholder('exotick');
    await nameInput.scrollIntoViewIfNeeded();
    await sleep(600);
    await nameInput.fill('Exotick 🚀 ✅ 🧪');
    await sleep(700);
    await page.locator('input[type=file][accept="image/png,image/jpeg,image/webp"]').setInputFiles(logoPath);
    await sleep(900);
    // Settings has two "Save" buttons (branding + cooldown). The cooldown one
    // is disabled (unchanged), so click the enabled branding Save.
    const saves = page.getByRole('button', { name: 'Save', exact: true });
    const nSaves = await saves.count();
    for (let i = 0; i < nSaves; i++) { if (await saves.nth(i).isEnabled()) { await saves.nth(i).click(); break; } }
    await page.getByText(/reflects your changes/).waitFor();
    await sleep(1800); // linger so the sidebar logo + name update is visible
  });
  toGif(w4, 'gif-4-branding.gif', { crop: null, width: 900 });

  await browser.close();
}

main()
  .then(() => { console.log('\nAll GIFs written to docs/screens/'); })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch {}
    if (process.platform === 'win32' && server.pid) {
      try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else { server.kill(); }
    await sleep(800);
    try { rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
    try { rmSync(VIDEO_DIR, { recursive: true, force: true }); } catch {}
  });
