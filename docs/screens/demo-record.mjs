/**
 * Records the 20-second README demo GIF.
 *
 * Same isolated-server pattern as capture.mjs (fresh temp DATA_DIR, no
 * pollution of your real data), but instead of taking still screenshots
 * it runs Playwright with recordVideo, then converts the WebM output to
 * an optimized GIF using the ffmpeg that Playwright ships with.
 *
 * Run with:  node docs/screens/demo-record.mjs
 * Prereqs:   `cd server && npx tsc`  (builds server/dist/index.js)
 *            `cd client && npx vite build`  (builds client/dist)
 *            `npx playwright install chromium`  (one-time)
 *
 * Output:    docs/screens/demo.gif
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
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const TEMP_DATA = path.join(os.tmpdir(), `exotick-gif-${Date.now()}`);
const VIDEO_DIR = path.join(os.tmpdir(), `exotick-video-${Date.now()}`);
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

function findFfmpeg() {
  // Prefer ffmpeg-static (full build, has GIF muxer). Playwright's own
  // bundled ffmpeg only muxes WebM/image2, so it can't produce GIFs.
  // Install with: npm install --no-save ffmpeg-static
  const staticPath = path.join(
    PROJECT,
    'node_modules',
    'ffmpeg-static',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  );
  if (existsSync(staticPath)) return staticPath;

  // Fallback: system ffmpeg on PATH.
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  if (which.status === 0) {
    const line = which.stdout.toString().split(/\r?\n/)[0].trim();
    if (line && existsSync(line)) return line;
  }
  return null;
}

async function main() {
  console.log(`Temp data dir: ${TEMP_DATA}`);
  console.log(`Video dir:     ${VIDEO_DIR}`);
  mkdirSync(TEMP_DATA, { recursive: true });
  mkdirSync(VIDEO_DIR, { recursive: true });

  const serverEntry = path.join(PROJECT, 'server', 'dist', 'index.js');
  if (!existsSync(serverEntry)) throw new Error(`Server not built: ${serverEntry}`);

  console.log('Spawning isolated server on port', PORT);
  const server = spawn(process.execPath, [serverEntry], {
    cwd: path.join(PROJECT, 'server'),
    env: { ...process.env, PORT: String(PORT), EXOTICK_DATA_DIR: TEMP_DATA, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  try {
    await waitForServer();
    console.log('Server ready.');

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1, // 1x for smaller video / smaller final GIF
      recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
    });
    context.on('page', (p) => p.on('dialog', (d) => d.accept()));
    const page = await context.newPage();

    // ── Scene 1: land on empty Edit Mode → load sample data ──────
    console.log('Scene 1: empty edit mode → load samples');
    await page.goto(`${BASE}/edit`);
    await page.waitForSelector('text=Your library is empty');
    await sleep(1500);
    await page.locator('button', { hasText: 'Load sample data' }).click();
    await page.waitForSelector('text=Auth');
    await sleep(1500);

    // ── Scene 2: click a colored case → preview on right ─────────
    console.log('Scene 2: preview a case');
    await page.locator('button', { hasText: 'Apply a valid discount code' }).first().click();
    await sleep(2500);

    // ── Scene 3: compose a run ───────────────────────────────────
    console.log('Scene 3: compose');
    await page.locator('a[href="/compose"]').click();
    await page.waitForSelector('text=Compose Test Run');
    await sleep(800);
    await page.fill('input[placeholder*="Sprint"]', 'Sprint 14 Regression');
    await sleep(400);
    await page.fill('input[placeholder*="Alice"]', 'Alice');
    await sleep(400);
    // Section-level "select all" for Auth + Checkout via header TriCheckbox.
    await page.locator('div', { hasText: /^Auth\s*\d+\/\d+$/ }).locator('input[type="checkbox"]').first().click();
    await sleep(400);
    await page.locator('div', { hasText: /^Checkout\s*\d+\/\d+$/ }).locator('input[type="checkbox"]').first().click();
    await sleep(1000);

    // ── Scene 4: start run → mark pass/fail ──────────────────────
    console.log('Scene 4: mark pass/fail');
    await page.locator('button', { hasText: 'Save & Start' }).click();
    await page.waitForURL(/\/run\/\d+/);
    await page.waitForSelector('text=Finish Run');
    await sleep(800);
    const passButtons = page.locator('button', { hasText: /^Pass$/ });
    const failButtons = page.locator('button', { hasText: /^Fail$/ });
    await passButtons.nth(0).click(); await sleep(400);
    await passButtons.nth(1).click(); await sleep(400);
    await passButtons.nth(2).click(); await sleep(400);
    await failButtons.nth(3).click(); await sleep(400);
    await passButtons.nth(4).click(); await sleep(1000);

    // ── Scene 5: finish → history detail ─────────────────────────
    console.log('Scene 5: finish + history');
    await page.locator('button', { hasText: /^Finish Run$/ }).first().click();
    await page.waitForURL(/\/history\/\d+/);
    await page.waitForSelector('text=Total');
    await sleep(2500);

    console.log('Closing context (flushes video).');
    await page.close();
    await context.close();
    await browser.close();

    // Find the produced WebM.
    const webms = readdirSync(VIDEO_DIR)
      .filter((f) => f.endsWith('.webm'))
      .map((f) => path.join(VIDEO_DIR, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (webms.length === 0) throw new Error('No .webm produced by Playwright');
    const webm = webms[0];
    console.log(`Video: ${webm} (${(statSync(webm).size / 1024).toFixed(0)} KB)`);

    // Convert to GIF via Playwright's bundled ffmpeg. Two-pass palette
    // approach for good color quality at moderate file size.
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) throw new Error('Could not find Playwright ffmpeg');
    console.log(`Using ffmpeg: ${ffmpeg}`);
    const gifOut = path.join(SHOTS, 'demo.gif');
    // 15fps, scale down to 900px wide for reasonable file size.
    const filter = 'fps=15,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
    const args = ['-y', '-i', webm, '-vf', filter, '-loop', '0', gifOut];
    console.log('Converting to GIF…');
    const conv = spawnSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (conv.status !== 0) {
      console.error(conv.stderr?.toString().slice(-1000) || '(no stderr)');
      throw new Error(`ffmpeg exited with code ${conv.status}`);
    }
    const gifStat = statSync(gifOut);
    console.log(`✓ ${gifOut} (${(gifStat.size / 1024).toFixed(0)} KB)`);
  } finally {
    console.log('Shutting down server.');
    if (process.platform === 'win32' && server.pid) {
      try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else { server.kill(); }
    await sleep(1000);
    try { rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
    try { rmSync(VIDEO_DIR, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
