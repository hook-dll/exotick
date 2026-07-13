// Standalone entry point that runs the admin bootstrap and exits. Wired up
// from the root `predev` hook so `npm run dev` prompts once (if needed)
// before Vite + tsx watch spin up and start clobbering the terminal.
//
// If an admin already exists, this is a fast no-op.

import { bootstrapAdmin, BootstrapError } from './auth/bootstrap';

(async () => {
  try {
    await bootstrapAdmin();
    process.exit(0);
  } catch (e) {
    if (e instanceof BootstrapError) {
      console.error('\n[exotick] Bootstrap failed.\n' + e.message + '\n');
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  }
})();
