import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import type { Library } from '../types';

interface LibraryContextValue {
  libraries: Library[];
  activeLibraryId: number | null;
  activeLibrary: Library | null;
  isLoading: boolean;
  setActiveLibrary: (id: number) => void;
  refresh: () => Promise<void>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);
const STORAGE_KEY = 'exotick.activeLibraryId';

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [activeLibraryId, setActiveLibraryIdState] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { libraries: libs } = await api.libraries.list();
      setLibraries(libs);
      // Reconcile the active id: honor localStorage if that library still
      // exists, otherwise fall back to the first library (the server keeps
      // at least one alive at all times).
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      const validActive = libs.find((l) => l.id === stored)?.id ?? libs[0]?.id ?? null;
      setActiveLibraryIdState(validActive);
      if (validActive != null) localStorage.setItem(STORAGE_KEY, String(validActive));
    } catch {
      setLibraries([]);
      setActiveLibraryIdState(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch only when signed in. Watchers are skipped — the server blocks them
  // from reading the library catalog (they see runs + history only), so firing
  // the request would just 403. Clears on sign-out.
  useEffect(() => {
    if (!user || user.role === 'watcher') {
      setLibraries([]);
      setActiveLibraryIdState(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    refresh();
  }, [user, refresh]);

  const setActiveLibrary = useCallback((id: number) => {
    setActiveLibraryIdState(id);
    localStorage.setItem(STORAGE_KEY, String(id));
  }, []);

  const activeLibrary = libraries.find((l) => l.id === activeLibraryId) ?? null;

  const value = useMemo<LibraryContextValue>(
    () => ({ libraries, activeLibraryId, activeLibrary, isLoading, setActiveLibrary, refresh }),
    [libraries, activeLibraryId, activeLibrary, isLoading, setActiveLibrary, refresh]
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside LibraryProvider');
  return ctx;
}
