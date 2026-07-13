import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { api } from '../api';

interface BrandingContextValue {
  name: string;         // Resolved display name, always non-empty (default 'exotick').
  logoUrl: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const DEFAULT_NAME = 'exotick';

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<string>(DEFAULT_NAME);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const b = await api.branding.get();
      setName(b.name && b.name.trim() ? b.name : DEFAULT_NAME);
      // Add a cache-busting query so a freshly-uploaded logo replaces any
      // prior cached image without needing a hard reload.
      setLogoUrl(b.logoUrl ? `${b.logoUrl}?v=${Date.now()}` : null);
    } catch {
      setName(DEFAULT_NAME);
      setLogoUrl(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the browser tab title in sync with the branded name.
  useEffect(() => {
    document.title = name;
  }, [name]);

  const value = useMemo(() => ({ name, logoUrl, isLoading, refresh }), [name, logoUrl, isLoading, refresh]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used inside BrandingProvider');
  return ctx;
}
