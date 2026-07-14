import { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react';

// ── "Icon mode" easter egg ──────────────────────────────────────────────
// A sibling to the pastel theme egg (see theme.ts). Clicking the Dashboard
// nav item 7 times in quick succession toggles a mode where every text button
// collapses to just its line icon (see Action.tsx / Glyph.tsx). Ephemeral —
// it lives only in memory, so a reload restores the words. Dropdowns are left
// alone (native <select> can't hold an icon, and it isn't needed).

const RAPID_WINDOW_MS = 1500;
const THRESHOLD = 7;

interface IconModeValue {
  enabled: boolean;
  /** Register one Dashboard-nav click; 7 rapid ones flip the mode. */
  ping: () => void;
}

const IconModeContext = createContext<IconModeValue | null>(null);

export function IconModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const clicks = useRef({ count: 0, last: 0 });

  const ping = useCallback(() => {
    const now = Date.now();
    const c = clicks.current;
    c.count = now - c.last < RAPID_WINDOW_MS ? c.count + 1 : 1;
    c.last = now;
    if (c.count >= THRESHOLD) {
      c.count = 0;
      setEnabled((e) => !e);
    }
  }, []);

  return <IconModeContext.Provider value={{ enabled, ping }}>{children}</IconModeContext.Provider>;
}

export function useIconMode(): IconModeValue {
  const ctx = useContext(IconModeContext);
  if (!ctx) throw new Error('useIconMode must be used inside IconModeProvider');
  return ctx;
}
