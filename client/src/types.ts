export type SectionColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface Section {
  id: number;
  name: string;
  order_index: number;
  color: SectionColor | null;
  test_cases: TestCase[];
}

export interface TestCase {
  id: number;
  section_id: number | null;
  description: string;
  notes: string | null;
  order_index: number;
}

export interface Library {
  id: number;
  name: string;
  order_index: number;
  created_at: string;
}

export interface TestRun {
  id: number;
  name: string;
  runner_name: string | null;
  status: 'composing' | 'active' | 'completed';
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  // Every run belongs to exactly one library (server enforces at compose).
  library_id: number;
  library_name: string | null;
  // Server-computed: true while the take over cooldown still applies to
  // THIS run. Replaces the previous `last_activity_at` timestamp so the
  // wire doesn't leak when the current runner last acted.
  cooldown_active?: boolean;
}

export interface TestRunWithItems extends TestRun {
  items: TestRunItem[];
}

export interface TestRunItem {
  id: number;
  test_run_id: number;
  test_case_id: number | null;
  snapshot_description: string;
  snapshot_notes: string | null;
  snapshot_section_name: string | null;
  order_index: number;
  status: 'pass' | 'fail' | 'skip' | null;
  // Username of whoever last marked this item. `updated_at` used to live
  // on this type but the server no longer returns it — the timestamp
  // revealed when the current runner last acted, which is surveillance.
  updated_by: string | null;
}

export interface LogEvent {
  id: number;
  created_at: string;
  event_type: string;              // login / edit / compose / start / finish / take_over / password_change / password_reset
  actor_username: string;
  test_run_id: number | null;      // null if the run was later deleted
  test_run_name: string | null;    // snapshot — readable post-delete
  library_id: number | null;       // null if the library was later deleted
  library_name: string | null;     // snapshot — readable post-delete
  previous_runner: string | null;
  reason: string | null;
}

export type Role = 'admin' | 'editor' | 'runner' | 'watcher';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface AuthMe {
  user: User | null;
}

export interface AdminUser extends User {
  created_at: string;
  disabled_at: string | null;
  last_login_at: string | null;
}

export interface SessionSummary {
  id: string;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  isCurrent: boolean;
}

export interface Branding {
  // Custom display name; null falls back to the default "exotick".
  name: string | null;
  // URL of the custom logo image; null renders the default checkmark tile.
  logoUrl: string | null;
}
