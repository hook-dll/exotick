/**
 * Isolated screenshot capture for the README.
 *
 * Spins up a production-mode exotick server (backend serves the built client
 * itself, so no separate Vite dev process needed) against a throwaway data
 * directory in the OS temp folder. Seeds sample data, drives the app through
 * the demo flow, and writes PNGs into docs/screens/.
 *
 * Run with:  node docs/screens/capture.mjs
 * Requires:  npx playwright install chromium  (one-time)
 *            client/dist  (built via `npx vite build` from client/)
 *
 * Leaves nothing behind — server subprocess killed, temp data dir removed.
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
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const TEMP_DATA = path.join(os.tmpdir(), `exotick-shots-${Date.now()}`);
const VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/state`);
      if (r.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server on :${PORT} never became ready`);
}

async function loadSamples() {
  const r = await fetch(`${BASE}/api/samples/load`, { method: 'POST' });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Sample load failed: ${r.status} ${body}`);
  }
}

async function shoot(page, name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  ✓ ${name}`);
}

async function main() {
  console.log(`Temp data dir: ${TEMP_DATA}`);
  mkdirSync(TEMP_DATA, { recursive: true });

  console.log('Spawning isolated server on port', PORT);
  // Run the compiled JS directly with `node` — spawning a .cmd shim (npx / tsx)
  // fails with EINVAL on Windows without shell:true, and shell:true creates
  // an orphan grandchild that ignores kill(). Real .js file avoids both.
  // Prereq: `cd server && npx tsc` has been run so server/dist/index.js exists.
  const serverEntry = path.join(PROJECT, 'server', 'dist', 'index.js');
  if (!existsSync(serverEntry)) {
    throw new Error(
      `Server not built. Run: cd server && npx tsc\n(missing: ${serverEntry})`
    );
  }
  const server = spawn(
    process.execPath, // the node binary that's running this script
    [serverEntry],
    {
      cwd: path.join(PROJECT, 'server'),
      env: {
        ...process.env,
        PORT: String(PORT),
        EXOTICK_DATA_DIR: TEMP_DATA,
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let serverErr = '';
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => { serverErr += d.toString(); process.stderr.write(`[server-err] ${d}`); });

  try {
    await waitForServer();
    console.log('Server ready. Seeding sample data.');
    await loadSamples();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    // Auto-accept confirm() dialogs (Finish Run confirmation).
    context.on('page', (p) => p.on('dialog', (d) => d.accept()));
    const page = await context.newPage();

    // ── 1. Edit Mode ─────────────────────────────────────────────
    console.log('Capturing: 01-edit-mode.png');
    await page.goto(`${BASE}/edit`);
    // PasswordGate loads state async — wait for the actual editor content.
    await page.waitForSelector('text=Edit Mode', { timeout: 10000 });
    await sleep(400);
    // Click a case with notes to populate the right preview panel.
    await page.locator('button', { hasText: 'Apply a valid discount code' }).first().click().catch(() => {});
    await sleep(500);
    await shoot(page, '01-edit-mode.png');

    // ── 2. Compose Test Run ──────────────────────────────────────
    console.log('Capturing: 02-compose.png');
    await page.goto(`${BASE}/compose`);
    await page.waitForSelector('text=Compose Test Run');
    await page.fill('input[placeholder*="Sprint"]', 'Sprint 14 Regression');
    await page.fill('input[placeholder*="Alice"]', 'Alice');
    // Select the entire Auth + Checkout sections via their header TriCheckbox.
    const authCheckbox = page.locator('div', { hasText: /^Auth\s*\d+\/\d+$/ }).locator('input[type="checkbox"]').first();
    await authCheckbox.click().catch(() => {});
    const checkoutCheckbox = page.locator('div', { hasText: /^Checkout\s*\d+\/\d+$/ }).locator('input[type="checkbox"]').first();
    await checkoutCheckbox.click().catch(() => {});
    await sleep(200);
    // Click a case to preview.
    await page.locator('button', { hasText: 'Apply a valid discount code' }).first().click().catch(() => {});
    await sleep(500);
    await shoot(page, '02-compose.png');

    // ── 3. Active Test Run ───────────────────────────────────────
    console.log('Capturing: 03-active-run.png');
    // Click Save & Start.
    await page.locator('button', { hasText: 'Save & Start' }).click();
    await page.waitForURL(/\/run\/\d+/, { timeout: 8000 });
    await page.waitForSelector('text=Finish Run');
    await sleep(500);
    // Mark 3 pass, 1 fail via the row buttons.
    const passButtons = page.locator('button', { hasText: /^Pass$/ });
    const failButtons = page.locator('button', { hasText: /^Fail$/ });
    await passButtons.nth(0).click(); await sleep(120);
    await passButtons.nth(1).click(); await sleep(120);
    await passButtons.nth(2).click(); await sleep(120);
    await failButtons.nth(3).click(); await sleep(120);
    // Click an unmarked case row so the preview shows.
    const rows = page.locator('.divide-y > div').filter({ hasText: /./ });
    await rows.nth(4).click().catch(() => {});
    await sleep(500);
    await shoot(page, '03-active-run.png');

    // ── 4. History Detail ────────────────────────────────────────
    console.log('Capturing: 04-history-detail.png');
    await page.locator('button', { hasText: /^Finish Run$/ }).first().click();
    await page.waitForURL(/\/history\/\d+/, { timeout: 8000 });
    await page.waitForSelector('text=Total');
    await sleep(500);
    await shoot(page, '04-history-detail.png');

    // ── 5. Settings ──────────────────────────────────────────────
    console.log('Capturing: 05-settings.png');
    await page.goto(`${BASE}/settings`);
    await page.waitForSelector('text=Editor password');
    await sleep(400);
    await shoot(page, '05-settings.png');

    // ── 6. Pastel easter egg ─────────────────────────────────────
    console.log('Capturing: 06-pastel.png');
    await page.goto(`${BASE}/`);
    await page.waitForSelector('text=Dashboard', { timeout: 6000 });
    // Rapid-toggle the theme button 7 times to unlock pastel.
    const toggle = page.locator('button', { hasText: /Light mode|Dark mode/ }).first();
    for (let i = 0; i < 7; i++) {
      await toggle.click();
      await sleep(80);
    }
    await sleep(500);
    await shoot(page, '06-pastel.png');

    await browser.close();
    console.log('All shots captured.');
  } finally {
    console.log('Shutting down server.');
    // On Windows, .kill() sends SIGKILL to the direct child but doesn't
    // recurse — tsx spawns node as a grandchild that keeps the port. Use
    // taskkill /T to nuke the whole tree.
    if (process.platform === 'win32' && server.pid) {
      try {
        spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
    } else {
      server.kill();
    }
    // Give it a moment to release the DB file before we rm it.
    await sleep(1000);
    try { rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
    if (serverErr && !serverErr.includes('Server running')) {
      console.log('\nServer stderr summary (first 500 chars):');
      console.log(serverErr.slice(0, 500));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
