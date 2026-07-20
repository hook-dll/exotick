// Integration tests for the modules feature. They spin up an Express app that
// mounts the real routers behind a stub auth middleware (role comes from an
// `x-test-role` header, default 'editor'), against a throwaway SQLite DB in a
// temp dir. Run: `npm test` in server/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { unzipSync, strFromU8 } from 'fflate';
import type { AddressInfo } from 'net';

// EXOTICK_DATA_DIR must be set BEFORE importing db (it opens the file at load).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exotick-modtest-'));
process.env.EXOTICK_DATA_DIR = DATA_DIR;

let base = '';
let server: import('http').Server;

before(async () => {
  const express = (await import('express')).default;
  const librariesRouter = (await import('../src/routes/libraries')).default;
  const modulesRouter = (await import('../src/routes/modules')).default;
  const subModulesRouter = (await import('../src/routes/subModules')).default;
  const sectionsRouter = (await import('../src/routes/sections')).default;
  const testCasesRouter = (await import('../src/routes/testCases')).default;
  const testRunsRouter = (await import('../src/routes/testRuns')).default;
  const backupRouter = (await import('../src/routes/backup')).default;
  const exportRouter = (await import('../src/routes/export')).default;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { username: (req.headers['x-test-user'] as string) || 'tester', role: (req.headers['x-test-role'] as string) || 'editor' };
    next();
  });
  app.use('/api/libraries', librariesRouter);
  app.use('/api/modules', modulesRouter);
  app.use('/api/sub-modules', subModulesRouter);
  app.use('/api/sections', sectionsRouter);
  app.use('/api/test-cases', testCasesRouter);
  app.use('/api/test-runs', testRunsRouter);
  app.use('/api/backup', backupRouter);
  app.use('/api/export', exportRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// JSON request helper.
async function j(method: string, p: string, body?: unknown, role = 'editor') {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  return { status: res.status, body: parsed as any };
}

// Convenience: create a library and return its id.
async function newLibrary(name: string): Promise<number> {
  const r = await j('POST', '/api/libraries', { name });
  assert.equal(r.status, 201, `create library: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

test('module CRUD + delete returns content to root', async () => {
  const lib = await newLibrary('CRUD lib');

  // Create two modules.
  const m1 = (await j('POST', '/api/modules', { name: 'Payments', library_id: lib })).body;
  const m2 = (await j('POST', '/api/modules', { name: 'Search', library_id: lib })).body;
  assert.ok(m1.id && m2.id);

  // List returns them in order.
  let list = (await j('GET', `/api/modules?library_id=${lib}`, undefined, 'runner')).body.modules;
  assert.deepEqual(list.map((m: any) => m.name), ['Payments', 'Search']);

  // Reorder.
  await j('PUT', '/api/modules/reorder', { ids: [m2.id, m1.id], library_id: lib });
  list = (await j('GET', `/api/modules?library_id=${lib}`)).body.modules;
  assert.deepEqual(list.map((m: any) => m.name), ['Search', 'Payments']);

  // Rename.
  await j('PUT', `/api/modules/${m1.id}`, { name: 'Billing' });
  list = (await j('GET', `/api/modules?library_id=${lib}`)).body.modules;
  assert.ok(list.find((m: any) => m.name === 'Billing'));

  // Put a section + case inside m1, then delete m1 — content should survive at root.
  const sec = (await j('POST', '/api/sections', { name: 'Checkout', library_id: lib, module_id: m1.id })).body;
  await j('POST', '/api/test-cases', { description: 'loose case', library_id: lib, module_id: m1.id });
  const del = await j('DELETE', `/api/modules/${m1.id}`);
  assert.equal(del.status, 204);

  const tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  // Section is now at the root (module_id null), not destroyed.
  assert.ok(tree.sections.find((s: any) => s.id === sec.id && s.module_id == null));
  assert.ok(tree.unsectioned.find((c: any) => c.description === 'loose case'));
});

test('GET /sections groups content by module', async () => {
  const lib = await newLibrary('Tree lib');
  const mod = (await j('POST', '/api/modules', { name: 'Mod A', library_id: lib })).body;
  const secIn = (await j('POST', '/api/sections', { name: 'In module', library_id: lib, module_id: mod.id })).body;
  const secRoot = (await j('POST', '/api/sections', { name: 'At root', library_id: lib })).body;
  await j('POST', '/api/test-cases', { description: 'c1', library_id: lib, section_id: secIn.id });
  await j('POST', '/api/test-cases', { description: 'mod unsectioned', library_id: lib, module_id: mod.id });
  await j('POST', '/api/test-cases', { description: 'root unsectioned', library_id: lib });

  const tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  assert.equal(tree.modules.length, 1);
  const mtree = tree.modules[0];
  assert.equal(mtree.sections.length, 1);
  assert.equal(mtree.sections[0].id, secIn.id);
  assert.equal(mtree.sections[0].test_cases[0].description, 'c1');
  assert.equal(mtree.unsectioned.length, 1);
  assert.equal(mtree.unsectioned[0].description, 'mod unsectioned');
  assert.deepEqual(tree.sections.map((s: any) => s.id), [secRoot.id]);
  assert.equal(tree.unsectioned.length, 1);
  assert.equal(tree.unsectioned[0].description, 'root unsectioned');
});

test('sectioned case inherits its section module (invariant)', async () => {
  const lib = await newLibrary('Invariant lib');
  const mod = (await j('POST', '/api/modules', { name: 'M', library_id: lib })).body;
  const sec = (await j('POST', '/api/sections', { name: 'S', library_id: lib, module_id: mod.id })).body;
  // Even if a bogus module_id is sent, a sectioned case takes the section's module.
  const tc = (await j('POST', '/api/test-cases', { description: 'x', library_id: lib, section_id: sec.id, module_id: 99999 })).body;
  assert.equal(tc.module_id, mod.id);
});

test('move sections into a module cascades module_id onto their cases', async () => {
  const lib = await newLibrary('Move lib');
  const mod = (await j('POST', '/api/modules', { name: 'Target Mod', library_id: lib })).body;
  const sec = (await j('POST', '/api/sections', { name: 'Root Sec', library_id: lib })).body;
  const tc = (await j('POST', '/api/test-cases', { description: 'moves too', library_id: lib, section_id: sec.id })).body;
  assert.equal(tc.module_id, null);

  const mv = await j('POST', '/api/sections/move-module', { ids: [sec.id], library_id: lib, module_id: mod.id });
  assert.equal(mv.status, 200);
  assert.equal(mv.body.moved, 1);

  const tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  const mtree = tree.modules.find((m: any) => m.id === mod.id);
  assert.equal(mtree.sections.length, 1);
  assert.equal(mtree.sections[0].test_cases[0].id, tc.id);
  // The case now reports the module.
  assert.equal(mtree.sections[0].test_cases[0].module_id, mod.id);
  assert.equal(tree.sections.length, 0);
});

test('bulk-move cases to a module unsectioned pile and to a section', async () => {
  const lib = await newLibrary('Bulk lib');
  const mod = (await j('POST', '/api/modules', { name: 'Bucket', library_id: lib })).body;
  const c1 = (await j('POST', '/api/test-cases', { description: 'a', library_id: lib })).body;
  const c2 = (await j('POST', '/api/test-cases', { description: 'b', library_id: lib })).body;

  // Move both into the module's unsectioned pile.
  await j('PATCH', '/api/test-cases/bulk-move', { ids: [c1.id, c2.id], section_id: null, library_id: lib, module_id: mod.id });
  let tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  assert.equal(tree.unsectioned.length, 0);
  assert.equal(tree.modules[0].unsectioned.length, 2);

  // Now move one into a section in that module.
  const sec = (await j('POST', '/api/sections', { name: 'Dest', library_id: lib, module_id: mod.id })).body;
  await j('PATCH', '/api/test-cases/bulk-move', { ids: [c1.id], section_id: sec.id, library_id: lib });
  tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  const mtree = tree.modules[0];
  assert.equal(mtree.unsectioned.length, 1);
  assert.equal(mtree.sections[0].test_cases[0].id, c1.id);
  assert.equal(mtree.sections[0].test_cases[0].module_id, mod.id);
});

test('bulk-copy carries a whole module into another library', async () => {
  const src = await newLibrary('Copy src');
  const dst = await newLibrary('Copy dst');
  const mod = (await j('POST', '/api/modules', { name: 'Auth', library_id: src })).body;
  const sec = (await j('POST', '/api/sections', { name: 'Login', library_id: src, module_id: mod.id, color: 'blue' })).body;
  const cSec = (await j('POST', '/api/test-cases', { description: 'signs in', library_id: src, section_id: sec.id })).body;
  const cUn = (await j('POST', '/api/test-cases', { description: 'module loose', library_id: src, module_id: mod.id })).body;

  // The client includes all descendant ids when a module is ticked.
  const copy = await j('POST', '/api/test-cases/bulk-copy', {
    target_library_id: dst,
    module_ids: [mod.id],
    section_ids: [sec.id],
    case_ids: [cSec.id, cUn.id],
  });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(copy.body.modulesCreated, 1);
  assert.equal(copy.body.sectionsCreated, 1);
  assert.equal(copy.body.copiedCases, 2);

  const tree = (await j('GET', `/api/sections?library_id=${dst}`)).body;
  assert.equal(tree.modules.length, 1);
  const mtree = tree.modules[0];
  assert.equal(mtree.name, 'Auth');
  assert.equal(mtree.sections.length, 1);
  assert.equal(mtree.sections[0].name, 'Login');
  assert.equal(mtree.sections[0].color, 'blue');
  assert.equal(mtree.sections[0].test_cases[0].description, 'signs in');
  assert.equal(mtree.unsectioned[0].description, 'module loose');
  // Source untouched.
  const srcTree = (await j('GET', `/api/sections?library_id=${src}`)).body;
  assert.equal(srcTree.modules[0].sections[0].test_cases.length, 1);
});

test('compose snapshots the module name and orders module-first', async () => {
  const lib = await newLibrary('Run lib');
  const mod = (await j('POST', '/api/modules', { name: 'Core', library_id: lib })).body;
  const secIn = (await j('POST', '/api/sections', { name: 'Flows', library_id: lib, module_id: mod.id })).body;
  const inCase = (await j('POST', '/api/test-cases', { description: 'in module', library_id: lib, section_id: secIn.id })).body;
  const rootCase = (await j('POST', '/api/test-cases', { description: 'at root', library_id: lib })).body;

  const run = await j('POST', '/api/test-runs', { name: 'R1', runner_name: 'tester', case_ids: [rootCase.id, inCase.id] });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const full = (await j('GET', `/api/test-runs/${run.body.id}`)).body;
  // Module content comes first, then root.
  assert.equal(full.items[0].snapshot_module_name, 'Core');
  assert.equal(full.items[0].snapshot_section_name, 'Flows');
  assert.equal(full.items[0].snapshot_description, 'in module');
  assert.equal(full.items[1].snapshot_module_name, null);
  assert.equal(full.items[1].snapshot_description, 'at root');
});

test('backup round-trip preserves modules; replace clears them', async () => {
  const lib = await newLibrary('Backup src');
  const mod = (await j('POST', '/api/modules', { name: 'Reporting', library_id: lib })).body;
  const sec = (await j('POST', '/api/sections', { name: 'Dashboards', library_id: lib, module_id: mod.id })).body;
  await j('POST', '/api/test-cases', { description: 'renders chart', library_id: lib, section_id: sec.id });
  await j('POST', '/api/test-cases', { description: 'mod loose', library_id: lib, module_id: mod.id });
  await j('POST', '/api/test-cases', { description: 'root loose', library_id: lib });

  // Export (admin), inspect backup.json.
  const zipRes = await fetch(`${base}/api/backup/export?library_id=${lib}`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(zipRes.status, 200);
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
  const entries = unzipSync(zipBytes);
  const manifest = JSON.parse(strFromU8(entries['backup.json']));
  assert.equal(manifest.version, 5);
  assert.equal(manifest.modules.length, 1);
  assert.equal(manifest.modules[0].name, 'Reporting');
  assert.equal(manifest.modules[0].sections[0].test_cases[0].description, 'renders chart');
  assert.equal(manifest.modules[0].unsectioned[0].description, 'mod loose');
  assert.equal(manifest.unsectioned[0].description, 'root loose');

  // Import as a new library (round trip) via multipart.
  const form = new FormData();
  form.append('mode', 'new');
  form.append('name', 'Backup restored');
  form.append('backup', new Blob([zipBytes], { type: 'application/zip' }), 'b.zip');
  const imp = await fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'x-test-role': 'admin' }, body: form });
  const impBody = await imp.json();
  assert.equal(imp.status, 200, JSON.stringify(impBody));
  assert.equal(impBody.modulesAdded, 1);

  const restored = (await j('GET', `/api/sections?library_id=${impBody.library.id}`)).body;
  assert.equal(restored.modules.length, 1);
  assert.equal(restored.modules[0].name, 'Reporting');
  assert.equal(restored.modules[0].sections[0].test_cases[0].description, 'renders chart');
  assert.equal(restored.modules[0].unsectioned[0].description, 'mod loose');

  // Replace the restored library with an empty backup wipes its module too.
  const emptyLib = await newLibrary('Empty for backup');
  const emptyZipRes = await fetch(`${base}/api/backup/export?library_id=${emptyLib}`, { headers: { 'x-test-role': 'admin' } });
  const emptyBytes = new Uint8Array(await emptyZipRes.arrayBuffer());
  const form2 = new FormData();
  form2.append('mode', 'replace');
  form2.append('target_library_id', String(impBody.library.id));
  form2.append('backup', new Blob([emptyBytes], { type: 'application/zip' }), 'e.zip');
  const rep = await fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'x-test-role': 'admin' }, body: form2 });
  assert.equal(rep.status, 200);
  const afterReplace = (await j('GET', `/api/sections?library_id=${impBody.library.id}`)).body;
  assert.equal(afterReplace.modules.length, 0);
});

test('test-cases PDF export renders with modules (smoke)', async () => {
  const lib = await newLibrary('PDF lib');
  const mod = (await j('POST', '/api/modules', { name: 'PDF Mod', library_id: lib })).body;
  const sec = (await j('POST', '/api/sections', { name: 'PDF Sec', library_id: lib, module_id: mod.id })).body;
  await j('POST', '/api/test-cases', { description: 'pdf case', library_id: lib, section_id: sec.id });
  const res = await fetch(`${base}/api/export/test-cases?library_id=${lib}`, { headers: { 'x-test-role': 'runner' } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');
});

// ── Sub-module layer (library → module → sub-module → section → case) ─────────

test('sub-module CRUD + delete returns content to the parent module', async () => {
  const lib = await newLibrary('Sub CRUD lib');
  const mod = (await j('POST', '/api/modules', { name: 'M', library_id: lib })).body;
  const sm1 = (await j('POST', '/api/sub-modules', { name: 'Sign-in', library_id: lib, module_id: mod.id, color: 'green' })).body;
  const sm2 = (await j('POST', '/api/sub-modules', { name: 'Sign-out', library_id: lib, module_id: mod.id })).body;
  assert.ok(sm1.id && sm2.id);
  assert.equal(sm1.color, 'green');

  // List (runner+) returns them in order, scoped to the module bucket.
  let list = (await j('GET', `/api/sub-modules?library_id=${lib}`, undefined, 'runner')).body.subModules;
  assert.deepEqual(list.filter((s: any) => s.module_id === mod.id).map((s: any) => s.name), ['Sign-in', 'Sign-out']);

  // Reorder + rename + recolor.
  await j('PUT', '/api/sub-modules/reorder', { ids: [sm2.id, sm1.id], library_id: lib });
  await j('PUT', `/api/sub-modules/${sm1.id}`, { name: 'Auth', color: 'blue' });
  list = (await j('GET', `/api/sub-modules?library_id=${lib}`)).body.subModules;
  const renamed = list.find((s: any) => s.id === sm1.id);
  assert.equal(renamed.name, 'Auth');
  assert.equal(renamed.color, 'blue');

  // Put a section + case inside sm1, then delete sm1 — content survives in the
  // parent module (module_id kept, sub_module_id → NULL).
  const sec = (await j('POST', '/api/sections', { name: 'Login', library_id: lib, sub_module_id: sm1.id })).body;
  assert.equal(sec.module_id, mod.id);
  assert.equal(sec.sub_module_id, sm1.id);
  await j('POST', '/api/test-cases', { description: 'sub loose', library_id: lib, sub_module_id: sm1.id });
  const del = await j('DELETE', `/api/sub-modules/${sm1.id}`);
  assert.equal(del.status, 204);

  const tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  const mtree = tree.modules.find((m: any) => m.id === mod.id);
  assert.ok(mtree.sections.find((s: any) => s.id === sec.id && s.sub_module_id == null && s.module_id === mod.id));
  assert.ok(mtree.unsectioned.find((c: any) => c.description === 'sub loose'));
});

test('GET /sections nests module → sub-module → section', async () => {
  const lib = await newLibrary('Sub tree lib');
  const mod = (await j('POST', '/api/modules', { name: 'Mod', library_id: lib })).body;
  const sm = (await j('POST', '/api/sub-modules', { name: 'Sub', library_id: lib, module_id: mod.id })).body;
  const secInSub = (await j('POST', '/api/sections', { name: 'In sub', library_id: lib, sub_module_id: sm.id })).body;
  await j('POST', '/api/test-cases', { description: 'deep case', library_id: lib, section_id: secInSub.id });
  await j('POST', '/api/test-cases', { description: 'sub unsectioned', library_id: lib, sub_module_id: sm.id });
  // A root sub-module too.
  const rootSub = (await j('POST', '/api/sub-modules', { name: 'Root sub', library_id: lib })).body;
  await j('POST', '/api/sections', { name: 'Root sub sec', library_id: lib, sub_module_id: rootSub.id });

  const tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  assert.equal(tree.modules.length, 1);
  const mtree = tree.modules[0];
  assert.equal(mtree.sub_modules.length, 1);
  const smtree = mtree.sub_modules[0];
  assert.equal(smtree.id, sm.id);
  assert.equal(smtree.sections[0].test_cases[0].description, 'deep case');
  assert.equal(smtree.unsectioned[0].description, 'sub unsectioned');
  assert.equal(tree.sub_modules.length, 1);
  assert.equal(tree.sub_modules[0].id, rootSub.id);
  assert.equal(tree.sub_modules[0].sections[0].name, 'Root sub sec');
});

test('sectioned case inherits its section sub-module + module (invariant)', async () => {
  const lib = await newLibrary('Sub invariant lib');
  const mod = (await j('POST', '/api/modules', { name: 'M', library_id: lib })).body;
  const sm = (await j('POST', '/api/sub-modules', { name: 'S', library_id: lib, module_id: mod.id })).body;
  const sec = (await j('POST', '/api/sections', { name: 'Sec', library_id: lib, sub_module_id: sm.id })).body;
  // Even with bogus ids sent, a sectioned case takes the section's chain.
  const tc = (await j('POST', '/api/test-cases', { description: 'x', library_id: lib, section_id: sec.id, module_id: 99999, sub_module_id: 88888 })).body;
  assert.equal(tc.module_id, mod.id);
  assert.equal(tc.sub_module_id, sm.id);
});

test('move sub-modules into a module cascades module_id onto their content', async () => {
  const lib = await newLibrary('Sub move lib');
  const mod = (await j('POST', '/api/modules', { name: 'Target', library_id: lib })).body;
  const sm = (await j('POST', '/api/sub-modules', { name: 'Root sub', library_id: lib })).body; // at root
  const sec = (await j('POST', '/api/sections', { name: 'Sec', library_id: lib, sub_module_id: sm.id })).body;
  const tc = (await j('POST', '/api/test-cases', { description: 'moves', library_id: lib, section_id: sec.id })).body;
  assert.equal(tc.module_id, null);

  const mv = await j('POST', '/api/sub-modules/move-module', { ids: [sm.id], library_id: lib, module_id: mod.id });
  assert.equal(mv.status, 200);
  assert.equal(mv.body.moved, 1);

  const tree = (await j('GET', `/api/sections?library_id=${lib}`)).body;
  const mtree = tree.modules.find((m: any) => m.id === mod.id);
  assert.equal(mtree.sub_modules.length, 1);
  assert.equal(mtree.sub_modules[0].sections[0].test_cases[0].id, tc.id);
  assert.equal(mtree.sub_modules[0].sections[0].test_cases[0].module_id, mod.id);
  assert.equal(tree.sub_modules.length, 0);
});

test('compose snapshots the sub-module name and orders module → sub → section', async () => {
  const lib = await newLibrary('Sub run lib');
  const mod = (await j('POST', '/api/modules', { name: 'Core', library_id: lib })).body;
  const sm = (await j('POST', '/api/sub-modules', { name: 'Sign-in', library_id: lib, module_id: mod.id })).body;
  const secInSub = (await j('POST', '/api/sections', { name: 'Flows', library_id: lib, sub_module_id: sm.id })).body;
  const subCase = (await j('POST', '/api/test-cases', { description: 'in sub', library_id: lib, section_id: secInSub.id })).body;
  const rootCase = (await j('POST', '/api/test-cases', { description: 'at root', library_id: lib })).body;

  const run = await j('POST', '/api/test-runs', { name: 'R', runner_name: 'tester', case_ids: [rootCase.id, subCase.id] });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const full = (await j('GET', `/api/test-runs/${run.body.id}`)).body;
  assert.equal(full.items[0].snapshot_module_name, 'Core');
  assert.equal(full.items[0].snapshot_sub_module_name, 'Sign-in');
  assert.equal(full.items[0].snapshot_section_name, 'Flows');
  assert.equal(full.items[0].snapshot_description, 'in sub');
  assert.equal(full.items[1].snapshot_module_name, null);
  assert.equal(full.items[1].snapshot_sub_module_name, null);
  assert.equal(full.items[1].snapshot_description, 'at root');
});

test('backup v5 round-trip preserves sub-modules; replace clears them', async () => {
  const lib = await newLibrary('Sub backup src');
  const mod = (await j('POST', '/api/modules', { name: 'Reporting', library_id: lib, color: 'purple' })).body;
  const sm = (await j('POST', '/api/sub-modules', { name: 'Charts', library_id: lib, module_id: mod.id, color: 'orange' })).body;
  const sec = (await j('POST', '/api/sections', { name: 'Dashboards', library_id: lib, sub_module_id: sm.id })).body;
  await j('POST', '/api/test-cases', { description: 'renders chart', library_id: lib, section_id: sec.id });
  await j('POST', '/api/test-cases', { description: 'sub loose', library_id: lib, sub_module_id: sm.id });

  const zipRes = await fetch(`${base}/api/backup/export?library_id=${lib}`, { headers: { 'x-test-role': 'admin' } });
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
  const manifest = JSON.parse(strFromU8(unzipSync(zipBytes)['backup.json']));
  assert.equal(manifest.version, 5);
  assert.equal(manifest.modules[0].color, 'purple');
  assert.equal(manifest.modules[0].sub_modules.length, 1);
  assert.equal(manifest.modules[0].sub_modules[0].name, 'Charts');
  assert.equal(manifest.modules[0].sub_modules[0].color, 'orange');
  assert.equal(manifest.modules[0].sub_modules[0].sections[0].test_cases[0].description, 'renders chart');
  assert.equal(manifest.modules[0].sub_modules[0].unsectioned[0].description, 'sub loose');

  const form = new FormData();
  form.append('mode', 'new');
  form.append('name', 'Sub restored');
  form.append('backup', new Blob([zipBytes], { type: 'application/zip' }), 'b.zip');
  const imp = await fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'x-test-role': 'admin' }, body: form });
  const impBody = await imp.json();
  assert.equal(imp.status, 200, JSON.stringify(impBody));
  assert.equal(impBody.subModulesAdded, 1);

  const restored = (await j('GET', `/api/sections?library_id=${impBody.library.id}`)).body;
  assert.equal(restored.modules[0].sub_modules[0].name, 'Charts');
  assert.equal(restored.modules[0].sub_modules[0].color, 'orange');
  assert.equal(restored.modules[0].sub_modules[0].sections[0].test_cases[0].description, 'renders chart');

  // Replace with an empty backup wipes the sub-module too.
  const emptyLib = await newLibrary('Sub empty');
  const emptyBytes = new Uint8Array(await (await fetch(`${base}/api/backup/export?library_id=${emptyLib}`, { headers: { 'x-test-role': 'admin' } })).arrayBuffer());
  const form2 = new FormData();
  form2.append('mode', 'replace');
  form2.append('target_library_id', String(impBody.library.id));
  form2.append('backup', new Blob([emptyBytes], { type: 'application/zip' }), 'e.zip');
  await fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'x-test-role': 'admin' }, body: form2 });
  const afterReplace = (await j('GET', `/api/sections?library_id=${impBody.library.id}`)).body;
  assert.equal(afterReplace.modules.length, 0);
  assert.equal(afterReplace.sub_modules.length, 0);
});

test('bulk-copy carries a whole module incl. sub-modules to another library', async () => {
  const src = await newLibrary('Deep copy src');
  const dst = await newLibrary('Deep copy dst');
  const mod = (await j('POST', '/api/modules', { name: 'Auth', library_id: src })).body;
  const sm = (await j('POST', '/api/sub-modules', { name: 'Sign-in', library_id: src, module_id: mod.id, color: 'green' })).body;
  const sec = (await j('POST', '/api/sections', { name: 'Login', library_id: src, sub_module_id: sm.id, color: 'blue' })).body;
  const cSec = (await j('POST', '/api/test-cases', { description: 'signs in', library_id: src, section_id: sec.id })).body;
  const cUn = (await j('POST', '/api/test-cases', { description: 'sub loose', library_id: src, sub_module_id: sm.id })).body;

  const copy = await j('POST', '/api/test-cases/bulk-copy', {
    target_library_id: dst,
    module_ids: [mod.id],
    sub_module_ids: [sm.id],
    section_ids: [sec.id],
    case_ids: [cSec.id, cUn.id],
  });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(copy.body.modulesCreated, 1);
  assert.equal(copy.body.subModulesCreated, 1);
  assert.equal(copy.body.sectionsCreated, 1);
  assert.equal(copy.body.copiedCases, 2);

  const tree = (await j('GET', `/api/sections?library_id=${dst}`)).body;
  const mtree = tree.modules[0];
  assert.equal(mtree.name, 'Auth');
  const smtree = mtree.sub_modules[0];
  assert.equal(smtree.name, 'Sign-in');
  assert.equal(smtree.color, 'green');
  assert.equal(smtree.sections[0].name, 'Login');
  assert.equal(smtree.sections[0].color, 'blue');
  assert.equal(smtree.sections[0].test_cases[0].description, 'signs in');
  assert.equal(smtree.unsectioned[0].description, 'sub loose');
});
