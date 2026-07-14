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

  const sections = db.prepare(
    'SELECT * FROM sections WHERE library_id = ? ORDER BY order_index, id'
  ).all(libraryId) as any[];
  const unsectioned = keep(db.prepare(
    'SELECT * FROM test_cases WHERE library_id = ? AND section_id IS NULL ORDER BY order_index, id'
  ).all(libraryId) as any[]);

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

  for (const section of sections) {
    const cases = keep(db.prepare(
      'SELECT * FROM test_cases WHERE section_id = ? ORDER BY order_index, id'
    ).all(section.id) as any[]);
    if (cases.length === 0) continue;

    doc.fontSize(13).font(FONT.bold).text(section.name);
    doc.moveDown(0.3);

    for (let i = 0; i < cases.length; i++) {
      doc.fontSize(11).font(FONT.regular).text(`${i + 1}.  ${cases[i].description}`, { indent: 12 });
    }

    doc.moveDown(0.8);
  }

  if (unsectioned.length > 0) {
    doc.fontSize(13).font(FONT.bold).text('Unsectioned');
    doc.moveDown(0.3);
    for (let i = 0; i < unsectioned.length; i++) {
      doc.fontSize(11).font(FONT.regular).text(`${i + 1}.  ${unsectioned[i].description}`, { indent: 12 });
    }
  }

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

  // Group by section
  const sectionMap = new Map<string, any[]>();
  for (const item of items) {
    const key = item.snapshot_section_name || 'Unsectioned';
    if (!sectionMap.has(key)) sectionMap.set(key, []);
    sectionMap.get(key)!.push(item);
  }

  for (const [sectionName, sectionItems] of sectionMap) {
    doc.fontSize(13).font(FONT.bold).text(sectionName);
    doc.moveDown(0.3);

    for (const item of sectionItems) {
      const label =
        item.status === 'pass' ? '[PASS]' :
        item.status === 'fail' ? '[FAIL]' :
        item.status === 'skip' ? '[SKIP]' : '[----]';

      doc.fontSize(11).font(FONT.bold).text(label, { continued: true });
      doc.font(FONT.regular).text(`  ${item.snapshot_description}`);
    }

    doc.moveDown(0.8);
  }

  doc.end();
});

export default router;
