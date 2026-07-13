import { useCallback, useEffect, useRef, useState } from 'react';

export type Theme = 'light' | 'dark' | 'pastel';

const STORAGE_KEY = 'exotick-theme';

/** Rapid-toggle easter egg: this many toggle clicks within RAPID_WINDOW_MS of
 *  each other flips the app into "pastel" mode, where each further click paints
 *  a new random soft pastel wash. */
const PASTEL_THRESHOLD = 7;
const RAPID_WINDOW_MS = 1500;

export function getStoredTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** A soft, readable pastel — high lightness, gentle saturation. */
function randomPastel(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 65%, 90%)`;
}

function applyTheme(theme: Theme, pastelColor: string | null) {
  const el = document.documentElement;
  el.classList.toggle('dark', theme === 'dark');
  el.classList.toggle('pastel', theme === 'pastel');
  if (theme === 'pastel' && pastelColor) {
    el.style.setProperty('--tc-pastel', pastelColor);
  } else {
    el.style.removeProperty('--tc-pastel');
  }
}

/**
 * App-wide theme. Normal use toggles light ↔ dark (persisted to localStorage).
 * Toggling rapidly (PASTEL_THRESHOLD clicks within RAPID_WINDOW_MS of each
 * other) unlocks "pastel" mode: every subsequent toggle click paints a new
 * random pastel background. `reset()` always returns to the light theme.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [pastelColor, setPastelColor] = useState<string | null>(null);
  const clicks = useRef({ count: 0, last: 0 });

  useEffect(() => {
    applyTheme(theme, pastelColor);
    // Pastel is an ephemeral easter egg — only persist real light/dark.
    if (theme !== 'pastel') localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, pastelColor]);

  const toggle = useCallback(() => {
    // Already in pastel mode → each click is a fresh random color.
    if (theme === 'pastel') {
      setPastelColor(randomPastel());
      return;
    }

    // Track how fast the button is being clicked.
    const now = Date.now();
    const c = clicks.current;
    c.count = now - c.last < RAPID_WINDOW_MS ? c.count + 1 : 1;
    c.last = now;

    if (c.count >= PASTEL_THRESHOLD) {
      setPastelColor(randomPastel());
      setTheme('pastel');
      return;
    }

    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, [theme]);

  /** Always escapes pastel mode back to the light theme. */
  const reset = useCallback(() => {
    clicks.current = { count: 0, last: 0 };
    setPastelColor(null);
    setTheme('light');
  }, []);

  return { theme, pastelColor, toggle, reset };
}
