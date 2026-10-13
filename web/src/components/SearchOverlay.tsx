import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, X, History, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
import { useDebounced } from '../lib/useDebounced';
import { Cover } from './Art';
import { initials } from '../lib/format';

const RECENT_KEY = 'pulse:recent-searches';
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 6);
  } catch {
    return [];
  }
};
const saveRecent = (q: string) => {
  try {
    const next = [q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
};

/** Highlights the first case-insensitive occurrence of q in text. */
function Hl({ text, q }: { text: string; q: string }): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Full-screen search across scenes, stars and studios. Results update as you type; two letters are enough. */
export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const dq = useDebounced(q.trim(), 160);
  const nav = useNavigate();
  const on = dq.length >= 2;
  const scenes = useQuery({ queryKey: ['search-overlay', dq], queryFn: ({ signal }) => api.items({ q: dq, limit: 8 }, signal), enabled: on });
  const people = useQuery({ queryKey: ['search-people', dq], queryFn: () => api.performers({ q: dq, limit: 6 }), enabled: on });
  const studiosAll = useQuery({ queryKey: ['studios'], queryFn: api.studios, enabled: on, staleTime: 60_000 });
  const studios = useMemo(() => (studiosAll.data || []).filter((s) => s.name.toLowerCase().includes(dq.toLowerCase())).slice(0, 4), [studiosAll.data, dq]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const go = (to: string) => {
    if (dq) saveRecent(dq);
    nav(to);
    onClose();
  };
  const loading = on && (scenes.isFetching || people.isFetching) && !scenes.data;
  const none = on && scenes.data && !scenes.data.items.length && !(people.data || []).length && !studios.length;
  return createPortal(
    <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search library">
      <div className="search-panel">
        <label className="search">
          <Search size={18} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titles, stars, studios" aria-label="Search titles, stars and studios" enterKeyHint="search" onKeyDown={(e) => e.key === 'Enter' && dq && go(`/library?q=${encodeURIComponent(dq)}`)} />
          {q && (
            <button type="button" className="icon-btn sm ghost" aria-label="Clear search" onClick={() => setQ('')}>
              <X size={16} />
            </button>
          )}
        </label>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
      <ul className="search-results">
        {!on && recent.length > 0 && (
          <>
            <li className="overline group-label row between">
              Recent
              <button
                className="link-btn"
                onClick={() => {
                  localStorage.removeItem(RECENT_KEY);
                  setRecent([]);
                }}
              >
                Clear
              </button>
            </li>
            {recent.map((r) => (
              <li key={r}>
                <button type="button" onClick={() => setQ(r)}>
                  <span className="ic">
                    <History size={18} />
                  </span>
                  <span className="copy grow">
                    <strong className="clamp-1">{r}</strong>
                  </span>
                  <ArrowUpRight size={18} className="faint" />
                </button>
              </li>
            ))}
          </>
        )}
        {!on && !recent.length && <li className="hint">Search your whole library — titles, stars and studios.</li>}
        {loading && <li className="hint">Searching…</li>}
        {none && <li className="hint">Nothing matches “{dq}”. Try a studio or a star’s name.</li>}
        {on && (people.data || []).length > 0 && <li className="overline group-label">Stars</li>}
        {on &&
          (people.data || []).map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => go(`/performer/${p.id}`)}>
                <span className="thumb round">{p.image ? <Cover src={p.image} alt="" seed={p.id} /> : <span className="avatar" style={{ width: '100%', height: '100%' }}>{initials(p.name)}</span>}</span>
                <span className="copy">
                  <strong className="clamp-1">
                    <Hl text={p.name} q={dq} />
                  </strong>
                  <em>{p.scenes} {p.scenes === 1 ? 'scene' : 'scenes'}</em>
                </span>
              </button>
            </li>
          ))}
        {on && studios.length > 0 && <li className="overline group-label">Studios</li>}
        {on &&
          studios.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => go(`/studio/${s.id}`)}>
                <span className="thumb round" style={s.logo ? { background: '#fff', padding: 8 } : undefined}>
                  {s.logo ? <img src={s.logo} alt="" referrerPolicy="no-referrer" style={{ position: 'static', objectFit: 'contain', width: '100%', height: '100%' }} /> : <span className="avatar" style={{ width: '100%', height: '100%' }}>{initials(s.name)}</span>}
                </span>
                <span className="copy">
                  <strong className="clamp-1">
                    <Hl text={s.name} q={dq} />
                  </strong>
                  <em>{s.scenes} {s.scenes === 1 ? 'video' : 'videos'}</em>
                </span>
              </button>
            </li>
          ))}
        {on && scenes.data && scenes.data.items.length > 0 && <li className="overline group-label">Scenes</li>}
        {on &&
          scenes.data?.items.map((it) => (
            <li key={it.id}>
              <button type="button" onClick={() => go(`/scene/${it.id}`)}>
                <span className="thumb">
                  <Cover src={it.scene?.poster || it.thumb} alt="" seed={it.id} />
                </span>
                <span className="copy">
                  <strong className="clamp-1">
                    <Hl text={it.title} q={dq} />
                  </strong>
                  <em>{[it.scene?.site?.name, it.scene?.performers.slice(0, 2).map((p) => p.name).join(', ')].filter(Boolean).join(' · ') || (it.matchStatus === 'unmatched' ? 'Unmatched' : 'Library')}</em>
                </span>
              </button>
            </li>
          ))}
        {on && scenes.data && scenes.data.total > scenes.data.items.length && (
          <li>
            <button type="button" onClick={() => go(`/library?q=${encodeURIComponent(dq)}`)} className="row between">
              <strong>See all {scenes.data.total} results</strong>
              <ArrowUpRight size={18} />
            </button>
          </li>
        )}
      </ul>
    </div>,
    document.body,
  );
}
