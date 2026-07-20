import type {
  Section, SectionColor, TestCase, TestRun, TestRunWithItems, TestRunItem,
  AuthMe, User, AdminUser, Role, SessionSummary, Branding, Library, LogEvent,
  LibraryContent, ModuleSummary, SubModuleSummary,
} from './types';

// Error class the login page reads for its retry-after countdown.
export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message: string) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Called when the server returns 401 mid-session. Bound by AuthProvider at boot.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn; }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch() rejects (a TypeError, message "Failed to fetch") only when the
    // request never reached the server — offline / server down. Rename it to
    // something the user can act on; behaviour is unchanged (still throws).
    throw new Error('Failed to fetch. Server seems to be offline');
  }
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    const message = (err as any).error || `Request failed: ${res.status}`;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 60;
      throw new RateLimitError(retryAfter, message);
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function reqMultipart<T>(method: string, path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      body: form,
    });
  } catch {
    throw new Error('Failed to fetch. Server seems to be offline');
  }
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error((err as any).error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Build a download URL for the backup / PDF endpoints. These are hit via
// plain <a href> or window.open, not fetch — the browser handles the file
// download itself and Cookie is sent automatically.
export function backupExportUrl(library_id: number): string {
  return `/api/backup/export?library_id=${library_id}`;
}
export function testCasesPdfUrl(library_id: number, ids?: number[]): string {
  const q = new URLSearchParams({ library_id: String(library_id) });
  if (ids && ids.length) q.set('ids', ids.join(','));
  return `/api/export/test-cases?${q.toString()}`;
}
// Streamed CSV of the full event log — hit via <a href> so the browser
// handles the file download (cookie is sent automatically).
export const logCsvUrl = '/api/log/export.csv';

export const api = {
  libraries: {
    list: () => req<{ libraries: Library[] }>('GET', '/libraries'),
    create: (name: string) => req<Library>('POST', '/libraries', { name }),
    rename: (id: number, name: string) => req<Library>('PUT', `/libraries/${id}`, { name }),
    delete: (id: number) => req<void>('DELETE', `/libraries/${id}`),
    reorder: (ids: number[]) => req<void>('PUT', '/libraries/reorder', { ids }),
  },

  modules: {
    list: (library_id: number) =>
      req<{ modules: ModuleSummary[] }>('GET', `/modules?library_id=${library_id}`),
    create: (name: string, library_id: number, opts?: { after_id?: number | null; color?: SectionColor | null }) =>
      req<ModuleSummary>('POST', '/modules', { name, library_id, ...(opts ?? {}) }),
    // Rename and/or recolor (either field alone is fine).
    update: (id: number, data: { name?: string; color?: SectionColor | null }) =>
      req<ModuleSummary>('PUT', `/modules/${id}`, data),
    delete: (id: number) => req<void>('DELETE', `/modules/${id}`),
    reorder: (ids: number[], library_id: number) =>
      req<void>('PUT', '/modules/reorder', { ids, library_id }),
  },

  subModules: {
    list: (library_id: number) =>
      req<{ subModules: SubModuleSummary[] }>('GET', `/sub-modules?library_id=${library_id}`),
    create: (name: string, library_id: number, opts?: { after_id?: number | null; module_id?: number | null; color?: SectionColor | null }) =>
      req<SubModuleSummary>('POST', '/sub-modules', { name, library_id, ...(opts ?? {}) }),
    update: (id: number, data: { name?: string; color?: SectionColor | null }) =>
      req<SubModuleSummary>('PUT', `/sub-modules/${id}`, data),
    delete: (id: number) => req<void>('DELETE', `/sub-modules/${id}`),
    reorder: (ids: number[], library_id: number) =>
      req<void>('PUT', '/sub-modules/reorder', { ids, library_id }),
    // Move whole sub-modules (with their sections + cases) into a module, or to
    // the library root (module_id null).
    moveModule: (ids: number[], library_id: number, module_id: number | null) =>
      req<{ ok: boolean; moved: number }>('POST', '/sub-modules/move-module', { ids, library_id, module_id }),
  },

  sections: {
    // Returns the library's full tree: modules first (each with sub_modules),
    // then library-root sub_modules / sections / unsectioned cases.
    list: (library_id: number) =>
      req<LibraryContent>('GET', `/sections?library_id=${library_id}`),
    create: (name: string, library_id: number, opts?: { after_id?: number | null; module_id?: number | null; sub_module_id?: number | null }) =>
      req<Section>('POST', '/sections', { name, library_id, ...(opts ?? {}) }),
    update: (id: number, data: { name?: string; color?: SectionColor | null }) =>
      req<Section>('PUT', `/sections/${id}`, data),
    delete: (id: number) => req<void>('DELETE', `/sections/${id}`),
    reorder: (ids: number[], library_id: number) =>
      req<void>('PUT', '/sections/reorder', { ids, library_id }),
    bulkDelete: (ids: number[]) =>
      req<{ ok: boolean; deleted: number }>('POST', '/sections/bulk-delete', { ids }),
    merge: (source_ids: number[], target_id: number) =>
      req<{ ok: boolean; movedCases: number; mergedSections: number }>('POST', '/sections/merge', { source_ids, target_id }),
    // Move whole sections (with their cases) into a target container — a module,
    // a sub-module (module derived), or the library root (both null).
    moveModule: (ids: number[], library_id: number, module_id: number | null, sub_module_id?: number | null) =>
      req<{ ok: boolean; moved: number }>('POST', '/sections/move-module', { ids, library_id, module_id, sub_module_id }),
  },

  testCases: {
    create: (data: { section_id?: number | null; description: string; notes?: string | null; library_id: number; module_id?: number | null; sub_module_id?: number | null }) =>
      req<TestCase>('POST', '/test-cases', data),
    update: (id: number, data: { description: string; section_id?: number | null; notes?: string | null }) =>
      req<TestCase>('PUT', `/test-cases/${id}`, data),
    delete: (id: number) => req<void>('DELETE', `/test-cases/${id}`),
    reorder: (ids: number[], library_id: number) =>
      req<void>('PATCH', '/test-cases/reorder', { ids, library_id }),
    bulkCreate: (section_id: number | null, descriptions: string[], library_id: number, module_id?: number | null, sub_module_id?: number | null) =>
      req<{ created: number; cases: TestCase[] }>('POST', '/test-cases/bulk', { section_id, descriptions, library_id, module_id, sub_module_id }),
    // Move to a section (module + sub-module derived) or to a container's
    // unsectioned pile (section_id null + module_id / sub_module_id; both null =
    // library root).
    bulkMove: (ids: number[], section_id: number | null, library_id: number, module_id?: number | null, sub_module_id?: number | null) =>
      req<{ ok: boolean; moved: number }>('PATCH', '/test-cases/bulk-move', { ids, section_id, library_id, module_id, sub_module_id }),
    bulkDelete: (ids: number[]) =>
      req<{ ok: boolean; deleted: number }>('POST', '/test-cases/bulk-delete', { ids }),
    bulkDuplicate: (ids: number[]) =>
      req<{ created: number; cases: TestCase[] }>('POST', '/test-cases/bulk-duplicate', { ids }),
    // Copy selected modules + sub-modules + sections + cases into ANOTHER
    // library, non-destructively. Structure (containers by name+color, nested)
    // is recreated in the target.
    bulkCopy: (target_library_id: number, case_ids: number[], section_ids: number[], module_ids: number[], sub_module_ids: number[]) =>
      req<{ ok: boolean; copiedCases: number; sectionsCreated: number; subModulesCreated: number; modulesCreated: number; library: Library }>(
        'POST', '/test-cases/bulk-copy', { target_library_id, case_ids, section_ids, module_ids, sub_module_ids }),
  },

  testRuns: {
    list: (opts?: { status?: string; library_id?: number }) => {
      const q = new URLSearchParams();
      if (opts?.status) q.set('status', opts.status);
      if (opts?.library_id != null) q.set('library_id', String(opts.library_id));
      const suffix = q.toString();
      return req<TestRun[]>('GET', `/test-runs${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: number) => req<TestRunWithItems>('GET', `/test-runs/${id}`),
    create: (data: {
      name: string;
      runner_name?: string;
      case_ids: number[];
    }) => req<TestRun>('POST', '/test-runs', data),
    start: (id: number) => req<TestRun>('POST', `/test-runs/${id}/start`),
    updateItem: (itemId: number, status: 'pass' | 'fail' | null) =>
      req<TestRunItem>('PATCH', `/test-runs/items/${itemId}`, { status }),
    finish: (id: number) => req<TestRunWithItems>('POST', `/test-runs/${id}/finish`),
    takeOver: (id: number, reason: string) =>
      req<TestRun>('POST', `/test-runs/${id}/take-over`, { reason }),
    delete: (id: number) => req<void>('DELETE', `/test-runs/${id}`),
  },

  auth: {
    me: () => req<AuthMe>('GET', '/auth/me'),
    login: (username: string, password: string) =>
      req<{ user: User }>('POST', '/auth/login', { username, password }),
    logout: () => req<{ ok: boolean }>('POST', '/auth/logout'),
    changePassword: (currentPassword: string, newPassword: string) =>
      req<{ ok: boolean }>('POST', '/auth/change-password', { currentPassword, newPassword }),
    listSessions: () => req<{ sessions: SessionSummary[] }>('GET', '/auth/sessions'),
    revokeSession: (id: string) => req<{ ok: boolean }>('DELETE', `/auth/sessions/${encodeURIComponent(id)}`),
  },

  users: {
    roster: () => req<{ usernames: string[] }>('GET', '/users/roster'),
    list: () => req<{ users: AdminUser[] }>('GET', '/users'),
    create: (data: { username: string; password: string; role: Role }) =>
      req<{ user: AdminUser }>('POST', '/users', data),
    update: (id: number, data: { role?: Role; disabled?: boolean }) =>
      req<{ user: AdminUser }>('PATCH', `/users/${id}`, data),
    resetPassword: (id: number, newPassword: string) =>
      req<{ ok: boolean }>('POST', `/users/${id}/reset-password`, { newPassword }),
    delete: (id: number) => req<void>('DELETE', `/users/${id}`),
  },

  samples: {
    // Server creates a NEW "Samples" library (or "Samples (2)" if taken).
    load: () => req<{ ok: boolean; library: Library; sectionsAdded: number; casesAdded: number }>('POST', '/samples/load'),
  },

  settings: {
    // Any authed user can read the current value (Compose / Dashboard show
    // a hint about the cooldown). Only admins can write it.
    getTakeOverCooldown: () => req<{ minutes: number }>('GET', '/settings/take-over-cooldown'),
    setTakeOverCooldown: (minutes: number) =>
      req<{ ok: boolean; minutes: number }>('PUT', '/settings/take-over-cooldown', { minutes }),
  },

  log: {
    // Admin only. Returns the latest 200 events by default; use the CSV
    // export (see logCsvUrl) for full history.
    list: () => req<{ events: LogEvent[]; total: number; limit: number }>('GET', '/log'),
  },

  branding: {
    get: () => req<Branding>('GET', '/branding'),
    update: (data: { name?: string; logoFile?: File | null; clearLogo?: boolean }): Promise<Branding> => {
      const form = new FormData();
      if (data.name !== undefined) form.append('name', data.name);
      if (data.logoFile) form.append('logo', data.logoFile);
      if (data.clearLogo) form.append('clearLogo', 'true');
      return reqMultipart<Branding>('POST', '/branding', form);
    },
  },

  upload: {
    image: (file: File): Promise<{ url: string }> => {
      const form = new FormData();
      form.append('image', file);
      return reqMultipart<{ url: string }>('POST', '/upload', form);
    },
  },

  backup: {
    // mode: 'new'     → create a fresh library from the zip
    //       'merge'   → target_library_id required; append into it
    //       'replace' → target_library_id required; wipe + restore
    import: (opts: {
      file: File;
      mode: 'new' | 'merge' | 'replace';
      target_library_id?: number;
      name?: string;
    }) => {
      const form = new FormData();
      form.append('mode', opts.mode);
      form.append('backup', opts.file);
      if (opts.target_library_id != null) form.append('target_library_id', String(opts.target_library_id));
      if (opts.name) form.append('name', opts.name);
      return reqMultipart<{ ok: boolean; mode: string; library: Library; sectionsAdded: number; casesAdded: number; imagesWritten: number }>(
        'POST', '/backup/import', form
      );
    },
  },
};
