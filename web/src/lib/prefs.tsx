import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Prefs } from '../api';

const DEFAULTS: Prefs = { autoMatch: true, autoplayNext: false, resumePlayback: true, defaultSpeed: 1, skipSeconds: 10, preferOriginal: true, blurThumbs: false, theme: 'dark' };
const Ctx = createContext<{ prefs: Prefs; update: (p: Partial<Prefs>) => void }>({ prefs: DEFAULTS, update: () => {} });

export function PrefsProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['prefs'], queryFn: api.prefs, enabled, staleTime: 60_000 });
  const cached = (() => {
    try {
      return JSON.parse(localStorage.getItem('pulse:prefs') || 'null') as Prefs | null;
    } catch {
      return null;
    }
  })();
  const prefs = { ...DEFAULTS, ...(cached || {}), ...(q.data || {}) };
  const m = useMutation({
    mutationFn: api.setPrefs,
    onMutate: (p) => qc.setQueryData(['prefs'], { ...prefs, ...p }),
    onSuccess: (d) => qc.setQueryData(['prefs'], d),
  });
  useEffect(() => {
    localStorage.setItem('pulse:prefs', JSON.stringify(prefs));
    document.documentElement.dataset.theme = prefs.theme;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', prefs.theme === 'light' ? '#F6F5FA' : '#0A0912');
  }, [JSON.stringify(prefs)]);
  return <Ctx.Provider value={{ prefs, update: (p) => m.mutate(p) }}>{children}</Ctx.Provider>;
}
export const usePrefs = () => useContext(Ctx);
