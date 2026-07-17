import { Router } from 'express';
import db, { transaction } from '../db';
import { requireRole } from '../auth/middleware';

const router = Router();

// Seed loader creates a new library — editor+ only.
router.use(requireRole('editor'));

type SampleCase = { description: string; notes?: string | null };
type SampleSection = { name: string; color: string | null; cases: SampleCase[] };

// Realistic QA-flavored seed data — shows off sections, colors, markdown notes,
// and enough cases to demonstrate the split-view preview and Compose flow.
const SAMPLES: SampleSection[] = [
  {
    name: 'Auth',
    color: 'blue',
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
  const insertSection = db.prepare('INSERT INTO sections (name, order_index, color, library_id) VALUES (?, ?, ?, ?)');
  const insertCase = db.prepare(
    'INSERT INTO test_cases (section_id, description, notes, order_index, library_id) VALUES (?, ?, ?, ?, ?)'
  );

  let libraryId = 0;
  let sectionsAdded = 0;
  let casesAdded = 0;
  transaction(() => {
    const maxOrder = (db.prepare('SELECT MAX(order_index) as max FROM libraries').get() as any)?.max ?? -1;
    const libInfo = insertLibrary.run(name, maxOrder + 1);
    libraryId = Number(libInfo.lastInsertRowid);

    SAMPLES.forEach((s, sIdx) => {
      const info = insertSection.run(s.name, sIdx, s.color, libraryId);
      const sectionId = Number(info.lastInsertRowid);
      sectionsAdded++;
      s.cases.forEach((c, cIdx) => {
        insertCase.run(sectionId, c.description, c.notes ?? null, cIdx, libraryId);
        casesAdded++;
      });
    });

    // Unsectioned cases live with section_id = NULL.
    SAMPLE_UNSECTIONED.forEach((c, cIdx) => {
      insertCase.run(null, c.description, c.notes ?? null, cIdx, libraryId);
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
