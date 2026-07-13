import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { api, setOnUnauthorized } from '../api';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Coalesce concurrent refresh() calls onto the same in-flight promise so a
  // caller (e.g. login()) can await the pending refresh instead of silently
  // returning early and observing stale state.
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const p = (async () => {
      try {
        const me = await api.auth.me();
        setUser(me.user);
      } catch {
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    })();
    inFlight.current = p;
    p.finally(() => { if (inFlight.current === p) inFlight.current = null; });
    return p;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A 401 from anywhere in the app (e.g. session expired mid-session) should
  // clear the user so the route guard redirects to /login.
  useEffect(() => {
    setOnUnauthorized(() => {
      setUser(null);
    });
    return () => setOnUnauthorized(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    await api.auth.login(username, password);
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* ignore — still clear locally */ }
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, login, logout, refresh }),
    [user, isLoading, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
