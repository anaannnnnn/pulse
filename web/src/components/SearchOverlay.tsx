import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import { useDebounced } from '../lib/useDebounced';
import { Cover } from './Art';

/** Full-screen search. Results update as you type; two letters are enough to ask the library. */
export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 180);
  const nav = useNavigate();
  const r = useQuery({
    queryKey: ['search-overlay', dq],
    queryFn: ({ signal }) => api.items({ q: dq, limit: 8 }, signal),
    enabled: dq.length >= 2,
  });
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
  const open = (id: string) => {
    nav(`/scene/${id}`);
    onClose();
  };
  return (
    <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search library">
      <div className="search-panel">
        <label className="search">
          <Search size={18} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titles, stars, studios" aria-label="Search titles, stars, studios" enterKeyHint="search" />
        </label>
        <button className="icon-btn" type="button" aria-label="Close search" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <ul className="search-results">
        {dq.length < 2 && <li className="hint">Type at least two letters</li>}
        {r.isFetching && dq.length >= 2 && <li className="hint">Searching…</li>}
        {r.data?.items.map((it) => (
          <li key={it.id}>
            <button type="button" onClick={() => open(it.id)}>
              <span className="thumb">
                <Cover src={it.scene?.poster || it.thumb} alt="" seed={it.id} />
              </span>
              <span className="copy">
                <strong className="clamp-1">{it.title}</strong>
                <em>{it.scene?.site?.name || (it.matchStatus === 'unmatched' ? 'Unmatched' : 'Library')}</em>
              </span>
            </button>
          </li>
        ))}
        {dq.length >= 2 && r.data && r.data.items.length === 0 && !r.isFetching && <li className="hint">Nothing matches that</li>}
      </ul>
    </div>
  );
}
