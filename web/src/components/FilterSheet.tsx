import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ItemQuery } from '../api';
import { Chip, SearchField, Segmented, Sheet, Switch, Skeleton } from './ui';
import { Cover } from './Art';

export type Filters = Omit<ItemQuery, 'q' | 'limit' | 'offset'> & { dur?: string };
export const DURATIONS: { id: string; label: string; min?: number; max?: number }[] = [
  { id: 'short', label: 'Under 15 min', max: 15 },
  { id: 'mid', label: '15–30 min', min: 15, max: 30 },
  { id: 'long', label: '30–60 min', min: 30, max: 60 },
  { id: 'feature', label: 'Over 1 hour', min: 60 },
];
export const SORTS = [
  { value: 'added', label: 'Added' },
  { value: 'date', label: 'Released' },
  { value: 'title', label: 'A–Z' },
  { value: 'duration', label: 'Length' },
  { value: 'random', label: 'Shuffle' },
] as const;

export function toQuery(f: Filters): ItemQuery {
  const d = DURATIONS.find((x) => x.id === f.dur);
  const { dur: _d, ...rest } = f;
  return { ...rest, minDuration: d?.min, maxDuration: d?.max };
}
export function activeCount(f: Filters) {
  return (f.tags?.length || 0) + (f.performers?.length || 0) + (f.sites?.length || 0) + (f.yearFrom || f.yearTo ? 1 : 0) + (f.dur ? 1 : 0) + (f.status ? 1 : 0) + (f.favorites ? 1 : 0) + (f.watchlist ? 1 : 0);
}

const toggle = <T,>(arr: T[] | undefined, v: T) => (arr?.includes(v) ? arr.filter((x) => x !== v) : [...(arr || []), v]);

export function FilterSheet({ value, onApply, onClose, q }: { value: Filters; onApply: (f: Filters) => void; onClose: () => void; q?: string }) {
  const [f, setF] = useState<Filters>(value);
  const [tagQ, setTagQ] = useState('');
  const [perfQ, setPerfQ] = useState('');
  const facets = useQuery({ queryKey: ['facets'], queryFn: api.facets, staleTime: 60_000 });
  const count = useQuery({ queryKey: ['count', q, f], queryFn: () => api.items({ ...toQuery(f), q, limit: 1 }), placeholderData: (p) => p });
  const fx = facets.data;
  const tags = useMemo(() => (fx?.tags || []).filter((t) => !tagQ || t.name.toLowerCase().includes(tagQ.toLowerCase())).slice(0, tagQ ? 60 : 30), [fx, tagQ]);
  const perfs = useMemo(() => (fx?.performers || []).filter((p) => !perfQ || p.name.toLowerCase().includes(perfQ.toLowerCase())).slice(0, 24), [fx, perfQ]);
  const years = fx?.years.min && fx.years.max ? Array.from({ length: fx.years.max - fx.years.min + 1 }, (_, i) => fx.years.max! - i) : [];

  return (
    <Sheet
      title="Filter & sort"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => setF({ sort: f.sort, order: f.order })}>
            Reset
          </button>
          <button className="btn btn-primary grow" onClick={() => onApply(f)}>
            Show {count.data ? count.data.total : '…'} {count.data?.total === 1 ? 'video' : 'videos'}
          </button>
        </>
      }
    >
      <div className="stack gap-24">
        <section className="stack gap-12">
          <h3 className="overline">Sort by</h3>
          <div className="chips wrap">
            {SORTS.map((s) => (
              <Chip key={s.value} on={(f.sort || 'added') === s.value} onClick={() => setF({ ...f, sort: s.value })}>
                {s.label}
              </Chip>
            ))}
          </div>
          {f.sort !== 'random' && (
            <Segmented
              label="Order"
              value={f.order || (f.sort === 'title' ? 'asc' : 'desc')}
              onChange={(o) => setF({ ...f, order: o })}
              options={[
                { value: 'desc', label: f.sort === 'title' ? 'Z → A' : f.sort === 'duration' ? 'Longest first' : 'Newest first' },
                { value: 'asc', label: f.sort === 'title' ? 'A → Z' : f.sort === 'duration' ? 'Shortest first' : 'Oldest first' },
              ]}
            />
          )}
        </section>

        <section className="stack gap-12">
          <h3 className="overline">Show</h3>
          <div className="row between">
            <span>Favorites only</span>
            <Switch label="Favorites only" checked={!!f.favorites} onChange={(v) => setF({ ...f, favorites: v })} />
          </div>
          <div className="row between">
            <span>On my watchlist</span>
            <Switch label="Watchlist only" checked={!!f.watchlist} onChange={(v) => setF({ ...f, watchlist: v })} />
          </div>
          <div className="chips wrap">
            {[
              { v: undefined, l: 'Everything' },
              { v: 'matched', l: 'Matched' },
              { v: 'unmatched,pending', l: 'Unmatched' },
            ].map((o) => (
              <Chip key={o.l} on={f.status === o.v} onClick={() => setF({ ...f, status: o.v })}>
                {o.l}
              </Chip>
            ))}
          </div>
        </section>

        <section className="stack gap-12">
          <h3 className="overline">Length</h3>
          <div className="chips wrap">
            {DURATIONS.map((d) => (
              <Chip key={d.id} on={f.dur === d.id} onClick={() => setF({ ...f, dur: f.dur === d.id ? undefined : d.id })}>
                {d.label}
              </Chip>
            ))}
          </div>
        </section>

        <section className="stack gap-12">
          <div className="row between">
            <h3 className="overline">Categories</h3>
            {!!f.tags?.length && <button className="link-btn" onClick={() => setF({ ...f, tags: [] })}>Clear {f.tags.length}</button>}
          </div>
          <SearchField value={tagQ} onChange={setTagQ} placeholder="Find a category" />
          {facets.isLoading ? (
            <Skeleton h={80} />
          ) : (
            <div className="chips wrap">
              {[...(fx?.tags.filter((t) => f.tags?.includes(t.id) && !tags.includes(t)) || []), ...tags].map((t) => (
                <Chip small key={t.id} on={f.tags?.includes(t.id)} count={t.count} onClick={() => setF({ ...f, tags: toggle(f.tags, t.id) })}>
                  {t.name}
                </Chip>
              ))}
              {!tags.length && <span className="hint">No categories yet. They appear once files are matched.</span>}
            </div>
          )}
        </section>

        <section className="stack gap-12">
          <div className="row between">
            <h3 className="overline">Performers</h3>
            {!!f.performers?.length && <button className="link-btn" onClick={() => setF({ ...f, performers: [] })}>Clear {f.performers.length}</button>}
          </div>
          <SearchField value={perfQ} onChange={setPerfQ} placeholder="Find a performer" />
          <div className="chips wrap">
            {perfs.map((p) => (
              <button key={p.id} className={`chip sm ${f.performers?.includes(p.id) ? 'on' : ''}`} style={{ paddingLeft: 4 }} aria-pressed={f.performers?.includes(p.id)} onClick={() => setF({ ...f, performers: toggle(f.performers, p.id) })}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', overflow: 'hidden', position: 'relative', flex: 'none' }}>
                  <Cover src={p.image} alt="" seed={p.id} />
                </span>
                {p.name}
                <span className="count">{p.count}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="stack gap-12">
          <h3 className="overline">Studios</h3>
          <div className="chips wrap">
            {(fx?.sites || []).slice(0, 30).map((s) => (
              <Chip small key={s.id} on={f.sites?.includes(s.id)} count={s.count} onClick={() => setF({ ...f, sites: toggle(f.sites, s.id) })}>
                {s.name}
              </Chip>
            ))}
          </div>
        </section>

        {years.length > 0 && (
          <section className="stack gap-12">
            <h3 className="overline">Release year</h3>
            <div className="row gap-12">
              <select className="select" aria-label="From year" value={f.yearFrom || ''} onChange={(e) => setF({ ...f, yearFrom: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">Any year</option>
                {years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
              <span className="faint">to</span>
              <select className="select" aria-label="To year" value={f.yearTo || ''} onChange={(e) => setF({ ...f, yearTo: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">Any year</option>
                {years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
