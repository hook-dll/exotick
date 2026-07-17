import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import Brand from '../branding/Brand';
import { useBranding } from '../branding/BrandingContext';
import { RateLimitError } from '../api';

interface LocationState { from?: string }

// Human-friendly countdown text. Short lockouts show seconds; medium ones
// show minutes; long ones show hours + minutes. Consistent shape (no "0h",
// no "0m") keeps the login card from wobbling as the timer ticks.
function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function Login() {
  const { user, isLoading, login } = useAuth();
  const { demoMode, demoUsername, demoPassword } = useBranding();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Countdown in seconds when the server rate-limits us (HTTP 429).
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from ?? '/';

  // Tick the lockout countdown once per second.
  useEffect(() => {
    if (lockoutSeconds <= 0) return;
    const t = setTimeout(() => setLockoutSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [lockoutSeconds]);

  // Loading in progress — don't flash the form while we're still resolving /me.
  if (isLoading) return null;

  // Already signed in — skip the form.
  if (user) return <Navigate to={from} replace />;

  const isLocked = lockoutSeconds > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || isLocked) return;
    setError('');
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (e: any) {
      if (e instanceof RateLimitError) {
        setLockoutSeconds(e.retryAfterSeconds);
        setError(''); // countdown UI takes over
      } else {
        setError(e.message || 'Login failed');
      }
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form onSubmit={submit} className="bg-white border rounded-lg shadow-sm p-6 w-full max-w-sm">
        <div className="mb-5">
          <Brand variant="light" />
        </div>
        <h1 className="text-lg font-bold text-gray-800 mb-1">Sign in</h1>
        <p className="text-sm text-gray-500 mb-4">Enter your credentials to continue.</p>

        {demoMode && demoUsername && demoPassword && (
          <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            <p className="font-medium">This is a live demo.</p>
            <p className="mt-0.5">
              Sign in with <span className="font-mono">{demoUsername}</span> /{' '}
              <span className="font-mono">{demoPassword}</span>.
            </p>
            <button
              type="button"
              onClick={() => { setUsername(demoUsername); setPassword(demoPassword); }}
              className="mt-2 text-blue-700 underline hover:text-blue-900"
            >
              Fill demo login
            </button>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Username</label>
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
        </div>

        {error && <div className="text-red-600 text-sm mt-3">{error}</div>}
        {isLocked && (
          <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm mt-3">
            Too many failed attempts. Try again in {formatDuration(lockoutSeconds)}.
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || isLocked || !username.trim() || !password}
          className="w-full mt-4 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : isLocked ? `Wait ${formatDuration(lockoutSeconds)}` : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
