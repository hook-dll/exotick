import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';

const router = Router();

// Seed loader creates a new library — editor+ only.
router.use(requireRole('editor'));

type SampleCase = { description: string; notes?: string | null };
// `module` groups a section under a module; `sub_module` nests it one level
// deeper (library → module → sub-module → section). Sections without either
// stay at the library root — the seed shows off every level.
type SampleSection = { name: string; color: string | null; module?: string; sub_module?: string; cases: SampleCase[] };

// Container colors keyed by name, so the seed demonstrates colored modules +
// sub-modules alongside colored sections.
const MODULE_COLORS: Record<string, string | null> = { 'Core Flows': 'blue' };
const SUB_MODULE_COLORS: Record<string, string | null> = { 'Sign-in': 'green' };

// Realistic QA-flavored seed data — shows off sections, colors, markdown notes,
// and enough cases to demonstrate the split-view preview and Compose flow.
const SAMPLES: SampleSection[] = [
  {
    name: 'Auth',
    color: 'blue',
    module: 'Core Flows',
    sub_module: 'Sign-in',
    cases: [
      { description: 'Sign up with valid email creates an account', notes: 'Use a fresh email that isn\'t already registered.\n\n**Expected:** confirmation banner + redirect to onboarding.' },
      { description: 'Sign in with correct password lands on Dashboard' },
      { description: 'Sign in with wrong password shows a clear error', notes: 'Try 3 wrong attempts; message should not leak whether the email exists.' },
      { description: 'Password reset link arrives within 1 minute' },
      { description: 'Logout clears the session and returns to /login' },
    ],
  },
  {
    name: 'Checkout',
    color: 'green',
    module: 'Core Flows',
    cases: [
      { description: 'Add an item to the cart from the product page' },
      { description: 'Remove an item from the cart updates the total' },
      { description: 'Apply a valid discount code reduces the total', notes: 'Test codes:\n- `WELCOME10` — 10% off\n- `FREESHIP` — free shipping\n\n**Watch:** total refreshes without a full page reload.' },
      { description: 'Apply an invalid discount code shows an inline error' },
      { description: 'Complete payment with a test card and land on the receipt' },
      { description: 'Order confirmation email arrives within 30 seconds' },
    ],
  },
  {
    name: 'Admin',
    color: 'purple',
    cases: [
      { description: 'Admin can view the full user list' },
      { description: 'Admin can suspend a user; user is logged out immediately' },
      { description: 'Non-admin visiting /admin gets a 403, not a redirect loop' },
    ],
  },
  {
    name: 'Search & Filters',
    color: 'orange',
    cases: [
      { description: 'Keyword search returns relevant results', notes: 'Search for a known product name.\n\n**Expected:** the top result is an exact match.' },
      { description: 'Empty search shows a friendly prompt, not an error' },
      { description: 'Combining filters (category + price) narrows results' },
      { description: 'Clearing all filters restores the full list' },
      { description: 'Search handles special characters without crashing', notes: 'Try inputs like `%`, `"`, `<script>`, and a very long string.' },
    ],
  },
  {
    name: 'Notifications',
    color: 'yellow',
    cases: [
      { description: 'In-app bell shows the correct unread count' },
      { description: 'Marking one notification as read decrements the count' },
      { description: 'Email notification respects the user\'s opt-out setting' },
      { description: 'Push notification deep-links to the right screen' },
    ],
  },
];

// Unsectioned demo cases — cross-cutting checks that don't belong to a single
// feature area. Shown to demonstrate the "Unsectioned" pile and its ordering.
const SAMPLE_UNSECTIONED: SampleCase[] = [
  { description: 'Mobile layout renders without horizontal scroll' },
  { description: 'Dark mode preference persists across reloads' },
  { description: '404 page offers a link back home' },
  { description: 'Session times out after 30 days of inactivity' },
  { description: 'Large file upload shows a progress bar', notes: 'Upload a ~50 MB file on a throttled connection.\n\n**Watch:** progress advances and a cancel button is available.' },
  { description: 'Keyboard-only user can complete checkout end to end' },
  { description: 'Copy-to-clipboard button confirms with a toast' },
  { description: 'Slow network shows skeleton loaders, not a blank screen' },
];

// Create a fresh "Samples" library (or "Samples (n)" if the name is taken) and
// seed it. Never touches existing libraries. Exported so the demo bootstrap
// (server/src/demo.ts) can populate an empty demo instance on boot without
// going through the HTTP route.
export function seedSamplesLibrary(): { library: unknown; sectionsAdded: number; casesAdded: number } {
  // Pick a unique library name.
  const existingNames = new Set(
    (db.prepare('SELECT name FROM libraries').all() as any[]).map((r) => r.name)
  );
  let name = 'Samples';
  let n = 2;
  while (existingNames.has(name)) name = `Samples (${n++})`;

  const insertLibrary = db.prepare('INSERT INTO libraries (name, order_index) VALUES (?, ?)');
  const insertModule = db.prepare('INSERT INTO modules (name, order_index, color, library_id) VALUES (?, ?, ?, ?)');
  const insertSubModule = db.prepare('INSERT INTO sub_modules (name, order_index, color, module_id, library_id) VALUES (?, ?, ?, ?, ?)');
  const insertSection = db.prepare('INSERT INTO sections (name, order_index, color, library_id, module_id, sub_module_id) VALUES (?, ?, ?, ?, ?, ?)');
  const insertCase = db.prepare(
    'INSERT INTO test_cases (section_id, description, notes, order_index, library_id, module_id, sub_module_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  let libraryId = 0;
  let sectionsAdded = 0;
  let casesAdded = 0;
  transaction(() => {
    const maxOrder = (db.prepare('SELECT MAX(order_index) as max FROM libraries').get() as any)?.max ?? -1;
    const libInfo = insertLibrary.run(name, maxOrder + 1);
    libraryId = Number(libInfo.lastInsertRowid);

    // Create the modules referenced by the seed sections (in first-seen order).
    const moduleIdByName = new Map<string, number>();
    let moduleOrder = 0;
    for (const s of SAMPLES) {
      if (s.module && !moduleIdByName.has(s.module)) {
        const info = insertModule.run(s.module, moduleOrder++, MODULE_COLORS[s.module] ?? null, libraryId);
        moduleIdByName.set(s.module, Number(info.lastInsertRowid));
      }
    }

    // Create the sub-modules referenced by the seed (keyed within their module).
    const subModuleIdByKey = new Map<string, number>();
    const subOrderByModule = new Map<string, number>();
    for (const s of SAMPLES) {
      if (!s.sub_module) continue;
      const moduleId = s.module ? moduleIdByName.get(s.module)! : null;
      const key = `${s.module ?? 'root'}:${s.sub_module}`;
      if (subModuleIdByKey.has(key)) continue;
      const bucket = s.module ?? 'root';
      const smIdx = subOrderByModule.get(bucket) ?? 0;
      subOrderByModule.set(bucket, smIdx + 1);
      const info = insertSubModule.run(s.sub_module, smIdx, SUB_MODULE_COLORS[s.sub_module] ?? null, moduleId, libraryId);
      subModuleIdByKey.set(key, Number(info.lastInsertRowid));
    }

    // Section order_index is per-bucket (module, sub-module, or root).
    const nextSectionOrder = new Map<string, number>();
    SAMPLES.forEach((s) => {
      const moduleId = s.module ? moduleIdByName.get(s.module)! : null;
      const subModuleId = s.sub_module ? subModuleIdByKey.get(`${s.module ?? 'root'}:${s.sub_module}`)! : null;
      const bucket = `${s.module ?? 'root'}:${s.sub_module ?? 'root'}`;
      const sIdx = nextSectionOrder.get(bucket) ?? 0;
      nextSectionOrder.set(bucket, sIdx + 1);
      const info = insertSection.run(s.name, sIdx, s.color, libraryId, moduleId, subModuleId);
      const sectionId = Number(info.lastInsertRowid);
      sectionsAdded++;
      s.cases.forEach((c, cIdx) => {
        insertCase.run(sectionId, c.description, c.notes ?? null, cIdx, libraryId, moduleId, subModuleId);
        casesAdded++;
      });
    });

    // Unsectioned cases live at the library root (section/module/sub all NULL).
    SAMPLE_UNSECTIONED.forEach((c, cIdx) => {
      insertCase.run(null, c.description, c.notes ?? null, cIdx, libraryId, null, null);
      casesAdded++;
    });
  });

  const library = db.prepare('SELECT id, name, order_index, created_at FROM libraries WHERE id = ?').get(libraryId);
  return { library, sectionsAdded, casesAdded };
}

// POST /api/samples/load — always creates a NEW library called "Samples"
// (or "Samples (n)" if that name is taken) and seeds it. Never touches
// existing libraries.
router.post('/load', (_req, res) => {
  res.json({ ok: true, ...seedSamplesLibrary() });
});

export default router;
