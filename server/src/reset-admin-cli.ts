// Standalone entry point for host-side admin password recovery.
//
//   Local:   npm run reset-admin
//   Docker:  docker compose exec exotick node server/dist/reset-admin-cli.js
//
// Prompts for a new password (or reads EXOTICK_RESET_PASSWORD), then revokes
// that admin's sessions. Requires host / container access — there is no
// web-facing reset by design (see readme > Forgot the admin password?).

import { resetAdmin, ResetError } from './auth/bootstrap';

(async () => {
  try {
    await resetAdmin();
    process.exit(0);
  } catch (e) {
    if (e instanceof ResetError) {
      console.error('\n[exotick] Cannot reset admin.\n' + e.message + '\n');
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  }
})();
