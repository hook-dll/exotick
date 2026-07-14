import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useBranding } from '../branding/BrandingContext';
import Action from '../iconmode/Action';
import { formatServerTs } from '../util/serverDate';
import type { AdminUser, Role, SessionSummary } from '../types';

// Roles the admin can assign. Admin itself is bootstrap-only — there is
// deliberately only one admin per install (see auth/bootstrap.ts), so it
// doesn't appear in either picker.
const ASSIGNABLE_ROLES: Role[] = ['editor', 'runner', 'watcher'];

const ROLE_LABELS: Record<Role, string> = {
  admin: 'admin',
  editor: 'editor',
  runner: 'runner',
  watcher: 'watcher',
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'all access, manages users',
  editor: 'edits test cases, deletes only draft runs, runs tests, marks pass/fail',
  runner: 'runs tests, marks pass/fail',
  watcher: 'read-only',
};

const MIN_PASSWORD_LEN = 8;

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border rounded-lg p-5">
      <h2 className="font-semibold text-gray-800">{title}</h2>
      {subtitle && <p className="text-sm text-gray-500 mt-0.5 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-2" />}
      {children}
    </div>
  );
}

function ChangePasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setMessage('');
    if (next.length < MIN_PASSWORD_LEN) { setError(`New password must be at least ${MIN_PASSWORD_LEN} characters.`); return; }
    if (next !== confirm) { setError('New password and confirmation do not match.'); return; }
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      setMessage('Password updated. Your other devices have been signed out.');
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Change my password" subtitle="Updating your password signs out your other devices.">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Current password</label>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">New password</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            placeholder={`At least ${MIN_PASSWORD_LEN} characters`} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Confirm</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
        </div>
        {error && <div className="text-red-600 text-sm">{error}</div>}
        {message && <div className="text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm">{message}</div>}
        <button type="submit" disabled={busy || !current || !next || !confirm}
          className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
          <Action icon="key" label="Update password">{busy ? 'Updating…' : 'Update password'}</Action>
        </button>
      </form>
    </Card>
  );
}

function shortUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const m =
    /Firefox\/([\d.]+)/.exec(ua) ? `Firefox ${/Firefox\/([\d.]+)/.exec(ua)![1]}` :
    /Edg\/([\d.]+)/.exec(ua) ? `Edge ${/Edg\/([\d.]+)/.exec(ua)![1]}` :
    /Chrome\/([\d.]+)/.exec(ua) ? `Chrome ${/Chrome\/([\d.]+)/.exec(ua)![1]}` :
    /Safari\/([\d.]+)/.exec(ua) ? 'Safari' :
    ua.slice(0, 40);
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : '';
  return os ? `${m} · ${os}` : m;
}

function ActiveSessionsSection() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  const reload = async () => {
    setError('');
    try {
      const r = await api.auth.listSessions();
      setSessions(r.sessions);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };

  useEffect(() => { reload(); }, []);

  const revoke = async (s: SessionSummary) => {
    if (s.isCurrent && !confirm('Sign out THIS device? You will need to log in again.')) return;
    setPending(s.id);
    setError('');
    try {
      await api.auth.revokeSession(s.id);
      if (s.isCurrent) { await refresh(); navigate('/login', { replace: true }); return; }
      await reload();
    } catch (e: any) { setError(e.message); } finally { setPending(null); }
  };

  return (
    <Card title="Active sessions" subtitle="Where you're currently signed in. Revoke a session to sign that device out.">
      {loading ? <div className="text-sm text-gray-400">Loading…</div> : (
        <>
          {error && <div className="text-red-600 text-sm mb-3">{error}</div>}
          <div className="border rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2">Device</th>
                  <th className="text-left px-3 py-2">IP</th>
                  <th className="text-left px-3 py-2">Signed in</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sessions.map((s) => (
                  <tr key={s.id} className={s.isCurrent ? 'bg-blue-50' : ''}>
                    <td className="px-3 py-2">
                      <div className="text-gray-800" title={s.user_agent ?? ''}>{shortUserAgent(s.user_agent)}</div>
                      {s.isCurrent && <div className="text-xs text-blue-600">This device</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 font-mono">{s.ip ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{formatServerTs(s.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => revoke(s)} disabled={pending === s.id}
                        className="px-2 py-1 text-xs font-medium border border-red-300 rounded text-red-600 hover:bg-red-50 disabled:opacity-30">
                        <Action icon={s.isCurrent ? 'logout' : 'ban'} label={s.isCurrent ? 'Sign out here' : 'Revoke'}>{pending === s.id ? 'Revoking…' : s.isCurrent ? 'Sign out here' : 'Revoke'}</Action>
                      </button>
                    </td>
                  </tr>
                ))}
                {sessions.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-400">No active sessions.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

interface UsersSectionProps { users: AdminUser[]; reload: () => Promise<void>; }

// Admin adds users (as editor by default), can disable / delete / reset
// their password. The admin manages their own password via Change my
// password — self isn't in this list.
function UsersSection({ users, reload }: UsersSectionProps) {
  const { user: me } = useAuth();
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('editor');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [rowError, setRowError] = useState<Record<number, string>>({});
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState('');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreateError('');
    if (newPassword.length < MIN_PASSWORD_LEN) { setCreateError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`); return; }
    setCreating(true);
    try {
      await api.users.create({ username: newUsername.trim(), password: newPassword, role: newRole });
      setNewUsername(''); setNewPassword(''); setNewRole('editor');
      await reload();
    } catch (e: any) { setCreateError(e.message); } finally { setCreating(false); }
  };

  const changeRole = async (u: AdminUser, role: Role) => {
    setRowError((s) => ({ ...s, [u.id]: '' }));
    try { await api.users.update(u.id, { role }); await reload(); }
    catch (e: any) { setRowError((s) => ({ ...s, [u.id]: e.message })); }
  };

  const toggleDisabled = async (u: AdminUser) => {
    setRowError((s) => ({ ...s, [u.id]: '' }));
    try { await api.users.update(u.id, { disabled: !u.disabled_at }); await reload(); }
    catch (e: any) { setRowError((s) => ({ ...s, [u.id]: e.message })); }
  };

  const remove = async (u: AdminUser) => {
    if (!confirm(`Delete user "${u.username}"? Their run history stays intact.`)) return;
    setRowError((s) => ({ ...s, [u.id]: '' }));
    try { await api.users.delete(u.id); await reload(); }
    catch (e: any) { setRowError((s) => ({ ...s, [u.id]: e.message })); }
  };

  const closeReset = () => { setResetTarget(null); setResetPw(''); setResetConfirm(''); setResetError(''); };

  const doReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    setResetError('');
    if (resetPw.length < MIN_PASSWORD_LEN) { setResetError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`); return; }
    if (resetPw !== resetConfirm) { setResetError('Passwords do not match.'); return; }
    setResetBusy(true);
    try {
      await api.users.resetPassword(resetTarget.id, resetPw);
      closeReset();
    } catch (e: any) { setResetError(e.message); } finally { setResetBusy(false); }
  };

  // Only non-admin users shown in the table. The admin manages themselves
  // through the Change my password card above; no self-row means no
  // accidental "reset/disable/delete yourself" clicks either.
  const nonAdmins = users.filter((u) => u.role !== 'admin');

  return (
    <Card title="Users" subtitle="Pick a role for each teammate. Roles decide what they can do — hover a role name in the picker for a hint.">
      <form onSubmit={create} className="flex flex-wrap items-end gap-2 mb-4">
        <div className="flex-1 min-w-[8rem]">
          <label className="block text-xs font-medium text-gray-700 mb-1">Username</label>
          <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            placeholder="e.g. alice" />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className="block text-xs font-medium text-gray-700 mb-1">Password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            placeholder={`≥ ${MIN_PASSWORD_LEN} characters`} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Role</label>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}
            className="border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400">
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r} title={ROLE_DESCRIPTIONS[r]}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={creating || !newUsername.trim() || !newPassword}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
          <Action icon="userPlus" label="Add user">{creating ? 'Adding…' : 'Add user'}</Action>
        </button>
      </form>
      {createError && <div className="text-red-600 text-sm mb-3">{createError}</div>}
      <p className="text-xs text-gray-500 mb-3">
        <span className="font-medium">editor</span> — {ROLE_DESCRIPTIONS.editor}.{' '}
        <span className="font-medium">runner</span> — {ROLE_DESCRIPTIONS.runner}.{' '}
        <span className="font-medium">watcher</span> — {ROLE_DESCRIPTIONS.watcher}.
      </p>

      <div className="border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">User</th>
              <th className="text-left px-3 py-2">Role</th>
              <th className="text-left px-3 py-2">Last login</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {nonAdmins.map((u) => {
              const isDisabled = !!u.disabled_at;
              return (
                <tr key={u.id} className={isDisabled ? 'bg-gray-50 text-gray-400' : ''}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-800">{u.username}</div>
                    {isDisabled && <div className="text-xs text-red-500">Disabled</div>}
                    {rowError[u.id] && <div className="text-xs text-red-600 mt-0.5">{rowError[u.id]}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}
                      className="border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400">
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r} title={ROLE_DESCRIPTIONS[r]}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {u.last_login_at ? formatServerTs(u.last_login_at) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => setResetTarget(u)}
                        className="px-2 py-1 text-xs border rounded text-gray-600 hover:bg-gray-50">
                        <Action icon="key">Reset password</Action>
                      </button>
                      <button onClick={() => toggleDisabled(u)}
                        className="px-2 py-1 text-xs border rounded text-gray-600 hover:bg-gray-50">
                        <Action icon={isDisabled ? 'check' : 'ban'} label={isDisabled ? 'Enable' : 'Disable'}>{isDisabled ? 'Enable' : 'Disable'}</Action>
                      </button>
                      <button onClick={() => remove(u)}
                        className="px-2 py-1 text-xs border border-red-200 rounded text-red-600 hover:bg-red-50">
                        <Action icon="trash">Delete</Action>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {nonAdmins.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-400">No users yet. Add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {me && <p className="text-xs text-gray-400 mt-3">Signed in as {me.username}. Update your own password from Change my password above.</p>}

      {/* Reset password for a specific user (admin-driven). Requires a
          confirm field so a mistyped password doesn't lock the user out. */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !resetBusy && closeReset()}>
          <form onSubmit={doReset} className="bg-white rounded-lg shadow-xl p-5 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-gray-800 mb-1">Reset password for {resetTarget.username}</h3>
            <p className="text-sm text-gray-500 mb-3">Their active sessions will be signed out.</p>
            <div className="space-y-2">
              <input type="password" autoFocus value={resetPw} onChange={(e) => setResetPw(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                placeholder={`New password (≥ ${MIN_PASSWORD_LEN} chars)`} />
              <input type="password" value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                placeholder="Confirm new password" />
            </div>
            {resetError && <div className="text-red-600 text-sm mt-2">{resetError}</div>}
            <div className="flex gap-2 mt-3">
              <button type="submit" disabled={resetBusy || !resetPw || !resetConfirm}
                className="flex-1 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
                <Action icon="key" label="Reset password">{resetBusy ? 'Resetting…' : 'Reset password'}</Action>
              </button>
              <button type="button" onClick={closeReset} disabled={resetBusy}
                className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded disabled:opacity-50"><Action icon="x">Cancel</Action></button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}

// ── Take over cooldown (admin) ──────────────────────────────────────────
function TakeOverCooldownSection() {
  const [value, setValue] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.settings.getTakeOverCooldown()
      .then((r) => { setValue(r.minutes); setDraft(String(r.minutes)); })
      .catch((e: any) => setError(e.message));
  }, []);

  const dirty = value !== null && String(value) !== draft.trim();
  const parsed = Number(draft);
  const validParsed = Number.isFinite(parsed) && parsed >= 0 && parsed <= 10080 && Number.isInteger(parsed);
  const targetIsZero = validParsed && parsed === 0;
  const currentIsZero = value === 0;

  const save = async () => {
    if (!validParsed) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const r = await api.settings.setTakeOverCooldown(parsed);
      setValue(r.minutes);
      setDraft(String(r.minutes));
      setMessage(`Saved. Take over cooldown is now ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card
      title="Take over cooldown"
      subtitle="After the current runner's last action on a run, how long everyone else must wait before they can take it over. Set 0 for no wait. A typed 10-character reason is always required, either way."
    >
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={10080}
          step={1}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(''); setMessage(''); }}
          className="w-28 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <span className="text-sm text-gray-600">minutes</span>
        <button
          onClick={save}
          disabled={busy || !dirty || !validParsed}
          className="ml-2 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
        >
          <Action icon="save" label="Save">{busy ? 'Saving…' : 'Save'}</Action>
        </button>
        {value !== null && !dirty && (
          <span className="text-xs text-gray-400 ml-1">Current: {value} min</span>
        )}
      </div>

      {(currentIsZero || targetIsZero) && (
        <div className="mt-3 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm text-amber-900">
          <strong>Cooldown is 0.</strong> Any editor or runner can take a run over immediately after
          the current runner's last mark. The 10-character reason still prevents accidental clicks, but
          nothing prevents deliberate abuse (a colleague repeatedly snatching runs). Only set this to 0
          if your team trusts each other and the log is being watched.
        </div>
      )}
      {!validParsed && draft.trim() !== '' && (
        <div className="mt-2 text-sm text-red-600">Enter a whole number between 0 and 10080.</div>
      )}
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
      {message && <div className="mt-2 text-sm text-green-700">{message}</div>}
    </Card>
  );
}

// ── Log (admin) ──────────────────────────────────────────────────────────
// An activity log of key actions (not every keystroke): sign-ins, edits, run
// compose/start/finish, take over, and password changes/resets. Rows survive
// run deletion and are never included in library backups.
function LogLinkSection() {
  return (
    <Card
      title="Log"
      subtitle="Who did what, and when: sign-ins, content edits, run compose/start/finish, take over, and password changes/resets. Take over also records the previous runner and the reason. Rows survive run deletion and are never included in library backups."
    >
      <div className="flex items-center gap-2">
        <Link
          to="/log"
          className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
        >
          <Action icon="list">Browse log</Action>
        </Link>
        <a
          href="/api/log/export.csv"
          className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
        >
          <Action icon="download">Download CSV</Action>
        </a>
      </div>
    </Card>
  );
}

function BrandingSection() {
  const { name, logoUrl, refresh } = useBranding();
  const [draftName, setDraftName] = useState(name === 'exotick' ? '' : name);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [pickedPreview, setPickedPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Keep draftName in sync if branding is refreshed elsewhere (e.g. after save).
  useEffect(() => {
    setDraftName(name === 'exotick' ? '' : name);
  }, [name]);

  useEffect(() => {
    if (!pickedFile) { setPickedPreview(null); return; }
    const url = URL.createObjectURL(pickedFile);
    setPickedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pickedFile]);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setPickedFile(f);
    setError(''); setMessage('');
  };

  const save = async () => {
    setError(''); setMessage('');
    setBusy(true);
    try {
      await api.branding.update({ name: draftName.trim(), logoFile: pickedFile });
      await refresh();
      setPickedFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setMessage('Saved. The sidebar reflects your changes.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeLogo = async () => {
    if (!confirm('Remove the custom logo? The default checkmark tile will show again.')) return;
    setError(''); setMessage('');
    setBusy(true);
    try {
      await api.branding.update({ clearLogo: true });
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const previewSrc = pickedPreview ?? logoUrl;

  return (
    <Card title="Branding" subtitle="Customize the sidebar and login logo + app name. Shown to everyone including on the sign-in screen.">
      <div className="flex items-start gap-4">
        <div className="shrink-0">
          <label className="block text-xs font-medium text-gray-700 mb-1">Logo</label>
          <div className="flex flex-col items-center gap-2">
            {previewSrc ? (
              <img src={previewSrc} alt="" className="w-16 h-16 rounded-lg object-cover border bg-white" />
            ) : (
              <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-3xl font-bold">
                ✓
              </div>
            )}
            <div className="flex gap-1">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
                className="text-xs px-2 py-1 border rounded text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <Action icon="upload" label="Upload logo">{logoUrl || pickedFile ? 'Replace' : 'Upload'}</Action>
              </button>
              {logoUrl && !pickedFile && (
                <button type="button" onClick={removeLogo} disabled={busy}
                  className="text-xs px-2 py-1 border border-red-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50">
                  <Action icon="trash">Remove</Action>
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"
              className="hidden" onChange={onPick} />
            <p className="text-[11px] text-gray-500 text-center leading-tight">PNG, JPG,<br />or WebP<br />≤ 2 MB</p>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <label className="block text-xs font-medium text-gray-700 mb-1">App name</label>
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={40}
            placeholder="exotick"
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" />
          <p className="text-xs text-gray-500 mt-1">Leave blank to fall back to "exotick". Up to 40 characters.</p>
        </div>
      </div>

      {error && <div className="text-red-600 text-sm mt-3">{error}</div>}
      {message && <div className="text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm mt-3">{message}</div>}

      <div className="mt-4">
        <button onClick={save} disabled={busy || (!pickedFile && draftName.trim() === (name === 'exotick' ? '' : name))}
          className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50">
          <Action icon="save" label="Save">{busy ? 'Saving…' : 'Save'}</Action>
        </button>
      </div>
    </Card>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersError, setUsersError] = useState('');

  const isAdmin = user?.role === 'admin';

  const reloadUsers = useMemo(() => async () => {
    setUsersError('');
    try { const { users } = await api.users.list(); setUsers(users); }
    catch (e: any) { setUsersError(e.message); }
  }, []);

  useEffect(() => { if (isAdmin) reloadUsers(); }, [isAdmin, reloadUsers]);

  if (!user) return null;

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold text-gray-800 mb-2">Settings</h1>

      <ChangePasswordSection />
      <ActiveSessionsSection />
      {isAdmin && (
        <>
          <BrandingSection />
          <TakeOverCooldownSection />
          <LogLinkSection />
          {usersError && <div className="text-red-600 text-sm">{usersError}</div>}
          <UsersSection users={users} reload={reloadUsers} />
        </>
      )}
    </div>
  );
}
