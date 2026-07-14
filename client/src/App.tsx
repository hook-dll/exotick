import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { ReactNode } from 'react';
import Dashboard from './pages/Dashboard';
import EditMode from './pages/EditMode';
import ComposeTestRun from './pages/ComposeTestRun';
import ActiveTestRun from './pages/ActiveTestRun';
import History from './pages/History';
import HistoryDetail from './pages/HistoryDetail';
import Settings from './pages/Settings';
import Log from './pages/Log';
import Login from './pages/Login';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { BrandingProvider } from './branding/BrandingContext';
import { LibraryProvider } from './library/LibraryContext';
import { IconModeProvider, useIconMode } from './iconmode/IconMode';
import Action from './iconmode/Action';
import Brand from './branding/Brand';
import { useTheme } from './theme';

function NavItem({ to, label, icon, end, onClick }: { to: string; label: string; icon: string; end?: boolean; onClick?: () => void }) {
  const { enabled } = useIconMode();
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      title={label}
      className={({ isActive }) =>
        `relative block px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          enabled ? 'text-center' : ''
        } ${
          isActive
            ? 'bg-white/10 text-white'
            : 'text-gray-300 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      <Action icon={icon}>{label}</Action>
    </NavLink>
  );
}

function UserBadge() {
  const { user, logout } = useAuth();
  if (!user) return null;
  // Sits at the bottom of the sidebar, below the theme toggle. `break-all`
  // wraps long usernames (64-char emails are allowed) instead of truncating.
  // Thin top divider gives a subtle visual break from the theme controls.
  return (
    <div className="px-3 pt-3 border-t border-white/10">
      <div className="text-sm text-gray-200 break-all leading-tight" title={user.username}>
        {user.username}
      </div>
      <button
        onClick={() => logout()}
        className="mt-1 block text-left text-xs text-gray-400 hover:text-gray-200 transition-colors"
      >
        <Action icon="logout">Sign out</Action>
      </button>
    </div>
  );
}

// Vertical positioning is handled by the parent (bottom stack in AppShell);
// this component just renders the toggle(s).
function ThemeToggle() {
  const { theme, toggle, reset } = useTheme();
  const { enabled: iconMode } = useIconMode();

  if (theme === 'pastel') {
    return (
      <div className="flex flex-col gap-1">
        <button
          onClick={reset}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
          title="Return to the light theme"
        >
          <span>☀️</span>
          {!iconMode && <span>Back to light</span>}
        </button>
        <button
          onClick={toggle}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
          title="Paint a new random pastel"
        >
          <span>🎨</span>
          {!iconMode && <span>New color</span>}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
      {!iconMode && <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
    </button>
  );
}

// Redirects to /login when no user is signed in.
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <div className="text-gray-400 text-sm p-6">Loading…</div>;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function AppShell() {
  const { user, isLoading } = useAuth();
  const { ping } = useIconMode();

  if (isLoading) return <div className="text-gray-400 text-sm p-6">Loading…</div>;

  // Nav visibility per role. Admin doesn't act on test runs — see
  // requireCanRun in server/src/auth/middleware.ts — so /compose is hidden
  // for admins even though the account has full management power elsewhere.
  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  const canRun = user?.role === 'editor' || user?.role === 'runner';

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          user ? (
            <div className="app-shell flex h-screen bg-gray-50 overflow-hidden">
              <nav className="w-52 bg-gradient-to-b from-slate-900 to-slate-950 flex flex-col p-4 gap-1 shrink-0">
                <div className="mb-4 px-1">
                  <Brand variant="dark" />
                </div>
                <NavItem to="/" label="Dashboard" icon="home" end onClick={ping} />
                {canEdit && <NavItem to="/edit" label="Edit Mode" icon="pencil" />}
                {canRun && <NavItem to="/compose" label="New Test Run" icon="flask" />}
                <NavItem to="/history" label="History" icon="clock" />
                <NavItem to="/settings" label="Settings" icon="gear" />
                {/* Bottom stack: theme toggle sits above the user badge.
                    `mt-auto` on the wrapper pushes both to the bottom of
                    the sidebar as a single unit. */}
                <div className="mt-auto flex flex-col gap-2">
                  <ThemeToggle />
                  <UserBadge />
                </div>
              </nav>
              <main className="flex-1 overflow-auto">
                <div className="max-w-[1600px] mx-auto px-6 pt-6 pb-16 min-h-full">
                  <Routes>
                    <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
                    <Route path="/edit" element={<RequireAuth><EditMode /></RequireAuth>} />
                    <Route path="/compose" element={<RequireAuth><ComposeTestRun /></RequireAuth>} />
                    <Route path="/run/:id" element={<RequireAuth><ActiveTestRun /></RequireAuth>} />
                    <Route path="/history" element={<RequireAuth><History /></RequireAuth>} />
                    <Route path="/history/:id" element={<RequireAuth><HistoryDetail /></RequireAuth>} />
                    <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
                    <Route path="/log" element={<RequireAuth><Log /></RequireAuth>} />
                  </Routes>
                </div>
              </main>
            </div>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <BrandingProvider>
        <AuthProvider>
          <LibraryProvider>
            <IconModeProvider>
              <AppShell />
            </IconModeProvider>
          </LibraryProvider>
        </AuthProvider>
      </BrandingProvider>
    </BrowserRouter>
  );
}
