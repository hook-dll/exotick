import { Router } from 'express';
import PDFDocument from 'pdfkit';
import db from '../db';
import { setupFonts, FONT } from '../pdfFonts';
import { requireRole } from '../auth/middleware';

const router = Router();

// SQLite's CURRENT_TIMESTAMP emits UTC as "YYYY-MM-DD HH:MM:SS" with no zone
// marker, which Node parses as LOCAL time (silently offsetting it). Mark it UTC
// so the true instant is read, then render in the SERVER machine's timezone.
function fmtServerTs(s: string): string {
  const iso = /T/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

// GET /test-cases?library_id=N — full library, or subset via ?ids=1,2,3.
// library_id is required so PDFs always represent a single library. Gated to
// runner+ because this exports library CONTENT. Watchers can still export a
// run's RESULTS (see the /test-runs/:id route below) — that's history, not
// the library catalog.
router.get('/test-cases', requireRole('runner'), (req, res) => {
  const libraryId = Number(req.query.library_id);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'library_id query param is required' });
  }
  const library = db.prepare('SELECT id, name FROM libraries WHERE id = ?').get(libraryId) as any;
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const idList = idsParam.split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
  const idSet = idList.length ? new Set(idList) : null;
  const keep = (cases: any[]) => (idSet ? cases.filter((c) => idSet.has(c.id)) : cases);

  const allSections = db.prepare(
    'SELECT * FROM sections WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];
  const caseStmt = db.prepare('SELECT * FROM test_cases WHERE section_id = ? ORDER BY order_index, id');
  const casesForSection = new Map<number, any[]>();
  for (const s of allSections) casesForSection.set(s.id, keep(caseStmt.all(s.id) as any[]));
  const unsecFor = (moduleId: number | null, subModuleId: number | null): any[] => keep(db.prepare(
    'SELECT * FROM test_cases WHERE library_id = ? AND module_id IS ? AND sub_module_id IS ? AND section_id IS NULL ORDER BY order_index, id'
  ).all(libraryId, moduleId, subModuleId) as any[]);

  const modules = db.prepare(
    'SELECT * FROM modules WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];
  const subModules = db.prepare(
    'SELECT * FROM sub_modules WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/pdf');
  const safeName = library.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) || 'library';
  res.setHeader('Content-Disposition', `attachment; filename="${idSet ? 'test-cases-selected' : `test-cases-${safeName}`}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  setupFonts(doc);
  doc.pipe(res);

  doc.fontSize(18).font(FONT.bold).text(idSet ? 'Selected Test Cases' : library.name, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font(FONT.regular).fillColor('#666666')
    .text(`Exported: ${new Date().toLocaleString()}`, { align: 'center' });
  doc.fillColor('black');
  doc.moveDown(1.5);

  const renderSection = (section: any, indent: number) => {
    const cases = casesForSection.get(section.id) ?? [];
    if (cases.length === 0) return;
    doc.fontSize(13).font(FONT.bold).text(section.name, { indent });
    doc.moveDown(0.3);
    for (let i = 0; i < cases.length; i++) {
      doc.fontSize(11).font(FONT.regular).text(`${i + 1}.  ${cases[i].description}`, { indent: indent + 12 });
    }
    doc.moveDown(0.8);
  };
  const renderUnsectioned = (cases: any[], indent: number, label = 'Unsectioned') => {
    if (cases.length === 0) return;
    doc.fontSize(13).font(FONT.bold).text(label, { indent });
    doc.moveDown(0.3);
    for (let i = 0; i < cases.length; i++) {
      doc.fontSize(11).font(FONT.regular).text(`${i + 1}.  ${cases[i].description}`, { indent: indent + 12 });
    }
    doc.moveDown(0.8);
  };

  const subHasContent = (sm: any): boolean =>
    unsecFor(sm.module_id ?? null, sm.id).length > 0 ||
    allSections.filter((s) => s.sub_module_id === sm.id).some((s) => (casesForSection.get(s.id) ?? []).length > 0);

  // Render a sub-module: its heading, then its sections + unsectioned pile,
  // indented one level deeper than the sub-module heading.
  const renderSubModule = (sm: any, headingIndent: number, childIndent: number) => {
    if (!subHasContent(sm)) return;
    doc.fontSize(14).font(FONT.bold).fillColor('#334155').text(sm.name, { indent: headingIndent });
    doc.fillColor('black');
    doc.moveDown(0.3);
    for (const s of allSections.filter((sec) => sec.sub_module_id === sm.id)) renderSection(s, childIndent);
    renderUnsectioned(unsecFor(sm.module_id ?? null, sm.id), childIndent);
    doc.moveDown(0.3);
  };

  // Modules first (each a top-level heading), then library-root content. Within
  // a module: its sub-modules, then module-direct sections, then its pile.
  for (const m of modules) {
    const moduleSubs = subModules.filter((sm) => sm.module_id === m.id);
    const moduleSections = allSections.filter((s) => s.module_id === m.id && s.sub_module_id == null);
    const moduleUnsec = unsecFor(m.id, null);
    const hasContent = moduleUnsec.length > 0
      || moduleSections.some((s) => (casesForSection.get(s.id) ?? []).length > 0)
      || moduleSubs.some(subHasContent);
    if (!hasContent) continue;
    doc.fontSize(15).font(FONT.bold).fillColor('#1e293b').text(m.name.toUpperCase());
    doc.fillColor('black');
    doc.moveDown(0.4);
    for (const sm of moduleSubs) renderSubModule(sm, 16, 32);
    for (const s of moduleSections) renderSection(s, 16);
    renderUnsectioned(moduleUnsec, 16);
    doc.moveDown(0.4);
  }

  // Library root: root sub-modules, then root sections, then root unsectioned.
  for (const sm of subModules.filter((x) => x.module_id == null)) renderSubModule(sm, 0, 16);
  for (const s of allSections.filter((sec) => sec.module_id == null && sec.sub_module_id == null)) renderSection(s, 0);
  renderUnsectioned(unsecFor(null, null), 0);

  doc.end();
});

router.get('/test-runs/:id', (req, res) => {
  const run = db.prepare(
    `SELECT tr.*, l.name AS library_name
     FROM test_runs tr LEFT JOIN libraries l ON l.id = tr.library_id
     WHERE tr.id = ?`
  ).get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: 'Not found' });

  const items = db.prepare(
    'SELECT * FROM test_run_items WHERE test_run_id = ? ORDER BY order_index, id'
  ).all(req.params.id) as any[];

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="test-run-${run.id}-${run.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`
  );

  const doc = new PDFDocument({ margin: 50 });
  setupFonts(doc);
  doc.pipe(res);

  // Title block
  doc.fontSize(18).font(FONT.bold).text(`Test Run: ${run.name}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(11).font(FONT.regular).fillColor('#444444');
  if (run.library_name) doc.text(`Library: ${run.library_name}`, { align: 'center' });
  if (run.runner_name) doc.text(`Runner: ${run.runner_name}`, { align: 'center' });
  doc.text(`Status: ${run.status.toUpperCase()}`, { align: 'center' });
  if (run.started_at) doc.text(`Started:  ${fmtServerTs(run.started_at)}`, { align: 'center' });
  if (run.finished_at) doc.text(`Finished: ${fmtServerTs(run.finished_at)}`, { align: 'center' });
  doc.fillColor('black');
  doc.moveDown(1.2);

  // Summary
  const passed = items.filter((i) => i.status === 'pass').length;
  const failed = items.filter((i) => i.status === 'fail').length;
  const skipped = items.filter((i) => i.status === 'skip').length;
  const total = items.length;

  doc.fontSize(12).font(FONT.bold).text('Summary');
  doc.moveDown(0.2);
  doc.fontSize(11).font(FONT.regular)
    .text(`Total: ${total}   Pass: ${passed}   Fail: ${failed}   Skip: ${skipped}`);
  doc.moveDown(1);

  // Contributors — appears only when at least one item has a recorded actor.
  const contributorCounts = new Map<string, number>();
  for (const item of items) {
    if (item.updated_by) {
      contributorCounts.set(item.updated_by, (contributorCounts.get(item.updated_by) ?? 0) + 1);
    }
  }
  if (contributorCounts.size > 0) {
    const contributors = [...contributorCounts.entries()].sort((a, b) => b[1] - a[1]);
    doc.fontSize(12).font(FONT.bold).text('Contributors');
    doc.moveDown(0.2);
    for (const [username, count] of contributors) {
      doc.fontSize(11).font(FONT.regular).text(`${username} — ${count} item${count === 1 ? '' : 's'}`);
    }
    doc.moveDown(1);
  }

  // Group by module → sub-module → section. Items arrive in compose order
  // (module, then sub-module, then section, then case), so walking them in
  // order and printing a heading whenever a level's name changes preserves the
  // grouping. Indent deepens one step per present level.
  let currentModule: string | null | undefined = undefined;
  let currentSubModule: string | null | undefined = undefined;
  let currentSection: string | null | undefined = undefined;
  for (const item of items) {
    const moduleName: string | null = item.snapshot_module_name ?? null;
    const subModuleName: string | null = item.snapshot_sub_module_name ?? null;
    const sectionName = item.snapshot_section_name || 'Unsectioned';
    if (moduleName !== currentModule) {
      currentModule = moduleName;
      currentSubModule = undefined; // force sub-module + section headings to reprint
      currentSection = undefined;
      if (moduleName) {
        doc.moveDown(0.2);
        doc.fontSize(15).font(FONT.bold).fillColor('#1e293b').text(moduleName.toUpperCase());
        doc.fillColor('black');
        doc.moveDown(0.3);
      }
    }
    if (subModuleName !== currentSubModule) {
      currentSubModule = subModuleName;
      currentSection = undefined; // force the section heading to reprint under the new sub-module
      if (subModuleName) {
        doc.fontSize(14).font(FONT.bold).fillColor('#334155').text(subModuleName, { indent: moduleName ? 16 : 0 });
        doc.fillColor('black');
        doc.moveDown(0.3);
      }
    }
    const level = (moduleName ? 1 : 0) + (subModuleName ? 1 : 0);
    const indent = level * 16;
    if (sectionName !== currentSection) {
      currentSection = sectionName;
      doc.fontSize(13).font(FONT.bold).text(sectionName, { indent });
      doc.moveDown(0.3);
    }

    const label =
      item.status === 'pass' ? '[PASS]' :
      item.status === 'fail' ? '[FAIL]' :
      item.status === 'skip' ? '[SKIP]' : '[----]';
    doc.fontSize(11).font(FONT.bold).text(label, { continued: true, indent });
    doc.font(FONT.regular).text(`  ${item.snapshot_description}`);
  }

  doc.end();
});

export default router;
