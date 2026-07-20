export type SectionColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface Section {
  id: number;
  name: string;
  order_index: number;
  color: SectionColor | null;
  // Module the section lives in; null = library root (no module).
  module_id: number | null;
  // Sub-module the section lives in; null = not in a sub-module. When set, the
  // section's module_id equals the sub-module's module_id (server invariant).
  sub_module_id: number | null;
  test_cases: TestCase[];
}

export interface TestCase {
  id: number;
  section_id: number | null;
  description: string;
  notes: string | null;
  order_index: number;
  // Module the case lives in; null = library root. For a sectioned case this
  // always mirrors its section's module_id (server-enforced invariant).
  module_id: number | null;
  // Sub-module the case lives in; null = not in a sub-module. Mirrors its
  // section's sub_module_id for a sectioned case.
  sub_module_id: number | null;
}

// A sub-module is an optional container one level below a module and one above a
// section (library → module → sub-module → section → case). Nested shape as
// returned by GET /api/sections.
export interface SubModule {
  id: number;
  name: string;
  order_index: number;
  color: SectionColor | null;
  // Parent module; null = the sub-module sits at the library root.
  module_id: number | null;
  library_id: number;
  created_at: string;
  sections: Section[];
  unsectioned: TestCase[];
}

// A module is an optional container inside a library that groups sub-modules,
// sections + unsectioned cases. Nested shape as returned by GET /api/sections.
export interface Module {
  id: number;
  name: string;
  order_index: number;
  color: SectionColor | null;
  library_id: number;
  created_at: string;
  sub_modules: SubModule[];
  sections: Section[];
  unsectioned: TestCase[];
}

// Full content tree of one library. `modules` come first; `sub_modules` /
// `sections` / `unsectioned` are the library-root content that sits outside any
// module.
export interface LibraryContent {
  modules: Module[];
  sub_modules: SubModule[];
  sections: Section[];
  unsectioned: TestCase[];
}

// Flat module row (GET /api/modules, POST /api/modules).
export interface ModuleSummary {
  id: number;
  name: string;
  order_index: number;
  color: SectionColor | null;
  library_id: number;
  created_at: string;
}

// Flat sub-module row (GET /api/sub-modules, POST /api/sub-modules).
export interface SubModuleSummary {
  id: number;
  name: string;
  order_index: number;
  color: SectionColor | null;
  module_id: number | null;
  library_id: number;
  created_at: string;
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
  // Sub-module the case belonged to at compose time; null = not in a sub-module.
  snapshot_sub_module_name: string | null;
  // Module the case belonged to at compose time; null = library root.
  snapshot_module_name: string | null;
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
  // Public demo instance? When true the server seeds a shared login and blocks
  // password changes; the login screen surfaces the credentials below.
  demoMode?: boolean;
  demoUsername?: string;
  demoPassword?: string;
}
