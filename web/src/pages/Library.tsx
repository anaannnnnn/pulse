import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, Plus, Heart, Bookmark, Wand2, ChevronRight, Sparkles, RotateCw, Search, Pause, Play, X } from 'lucide-react';
import { api, type Item } from '../api';
import { SceneCard, PersonCard, RowItem } from '../components/Cards';
import { CardSkeletons, Chip, EmptyState, ErrorState, SearchField, Segmented, RowSkeletons, Confidence } from '../components/ui';
import { FilterSheet, activeCount, toQuery, type Filters, SORTS } from '../components/FilterSheet';
import { MatchSheet } from '../components/MatchSheet';
import { strategyLabel } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useToast } from '../components/Toast';

type Tab = 'scenes' | 'performers' | 'studios' | 'review';
const num = (s: string | null) => (s ? s.split(',').map(Number).filter(Number.isFinite) : undefined);

function readFilters(sp: URLSearchParams): Filters {
  return {
    tags: num(sp.get('tags')),
    performers: sp.get('performers')?.split(',').filter(Boolean),
    sites: num(sp.get('sites')),
    yearFrom: sp.get('yearFrom') ? Number(sp.get('yearFrom')) : undefined,
    yearTo: sp.get('yearTo') ? Number(sp.get('yearTo')) : undefined,
    dur: sp.get('dur') || undefined,
    status: sp.get('status') || undefined,
    favorites: sp.get('fav') === '1' || undefined,
    watchlist: sp.get('watch') === '1' || undefined,
    sort: (sp.get('sort') as Filters['sort']) || undefined,
    order: (sp.get('order') as Filters['order']) || undefined,
  };
}
function writeFilters(sp: URLSearchParams, f: Filters) {
  const n = new URLSearchParams(sp);
  const set = (k: string, v: unknown) => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? n.delete(k) : n.set(k, Array.isArray(v) ? v.join(',') : String(v)));
  set('tags', f.tags);
  set('performers', f.performers);
  set('sites', f.sites);
  set('yearFrom', f.yearFrom);
  set('yearTo', f.yearTo);
  set('dur', f.dur);
  set('status', f.status);
  set('fav', f.favorites ? 1 : undefined);
  set('watch', f.watchlist ? 1 : undefined);
  set('sort', f.sort);
  set('order', f.order);
  return n;
}

function ScenesTab({ q, filters }: { q: string; filters: Filters }) {
  const query = useMemo(() => ({ ...toQuery(filters), q: q || undefined }), [q, filters]);
  const r = useInfiniteQuery({
    queryKey: ['items', query],
    queryFn: ({ pageParam, signal }) => api.items({ ...query, limit: 30, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((a, p) => a + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && r.hasNextPage && !r.isFetchingNextPage && r.fetchNextPage(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [r.hasNextPage, r.isFetchingNextPage]);
  const items = r.data?.pages.flatMap((p) => p.items) || [];
  const total = r.data?.pages[0]?.total;
  if (r.isLoading) return <CardSkeletons n={8} />;
  if (r.isError) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  if (!items.length)
    return q || activeCount(filters) ? (
      <EmptyState title="Nothing matches">Try removing a filter or searching for a studio or performer.</EmptyState>
    ) : (
      <EmptyState title="No videos yet" action={<Link to="/settings/pcloud" className="btn btn-primary">Choose pCloud folders</Link>}>
        Pick the pCloud folders that hold your videos and Pulse will index them.
      </EmptyState>
    );
  return (
    <>
      <p className="overline" style={{ margin: '0 2px 14px' }}>
        {total} {total === 1 ? 'video' : 'videos'}
      </p>
      <div className="grid">
        {items.map((it) => (
          <SceneCard key={it.id} item={it} queue={items} />
        ))}
      </div>
      <div ref={sentinel} style={{ height: 1 }} />
      {r.isFetchingNextPage && <div className="mt-16"><CardSkeletons n={4} /></div>}
    </>
  );
}

function PerformersTab({ q }: { q: string }) {
  const [sort, setSort] = useState<'scenes' | 'name'>('scenes');
  const r = useQuery({ queryKey: ['performers', q, sort], queryFn: () => api.performers({ q: q || undefined, sort, limit: 300 }) });
  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="caption">{r.data ? `${r.data.length} performers` : ''}</span>
        <div style={{ width: 200 }}>
          <Segmented label="Sort performers" value={sort} onChange={setSort} options={[{ value: 'scenes', label: 'Most' }, { value: 'name', label: 'A–Z' }]} />
        </div>
      </div>
      {r.isLoading && <CardSkeletons n={6} />}
      {r.isError && <ErrorState error={r.error} onRetry={() => r.refetch()} />}
      {r.data && !r.data.length && <EmptyState title="No performers yet">Performers appear as soon as videos are matched with ThePornDB.</EmptyState>}
      <div className="grid people">
        {r.data?.map((p) => (
          <PersonCard key={p.id} p={p} count={p.scenes} />
        ))}
      </div>
    </>
  );
}

function StudiosTab({ q }: { q: string }) {
  const r = useQuery({ queryKey: ['studios'], queryFn: api.studios });
  const list = (r.data || []).filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      {r.isLoading && <RowSkeletons />}
      {r.isError && <ErrorState error={r.error} onRetry={() => r.refetch()} />}
      {r.data && !list.length && <EmptyState title="No studios yet">Studios appear once videos are matched.</EmptyState>}
      <div className="group">
        {list.map((s) => (
          <Link key={s.id} to={`/studio/${s.id}`} className="cell">
            <span className="ic" style={{ width: 52, height: 52, background: '#fff', overflow: 'hidden', padding: 6 }}>
              {s.logo ? <img src={s.logo} alt="" referrerPolicy="no-referrer" style={{ objectFit: 'contain', width: '100%', height: '100%' }} /> : <Sparkles size={18} color="#0a0912" />}
            </span>
            <span className="grow stack">
              <span className="lbl clamp-1">{s.name}</span>
              <span className="val">{s.network && s.network !== s.name ? `${s.network} · ` : ''}{s.scenes} {s.scenes === 1 ? 'video' : 'videos'}</span>
            </span>
            <ChevronRight size={18} className="chev" />
          </Link>
        ))}
      </div>
    </>
  );
}

const ERROR_LABEL: Record<string, string> = {
  tpdb_auth: 'Key rejected', tpdb_blocked: 'Blocked', rate_limited: 'Rate limited', tpdb_network: 'Network', tpdb_http: 'ThePornDB error',
  tpdb_bad_response: 'Bad response', tpdb_not_configured: 'No key', exception: 'Internal error', strategy_error: 'Internal error',
};

function ReviewTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [matching, setMatching] = useState<Item | null>(null);
  const status = useQuery({ queryKey: ['match-queue'], queryFn: api.matchQueue, refetchInterval: (q) => (q.state.data?.running ? 2000 : false) });
  const r = useQuery({ queryKey: ['items', 'review'], queryFn: () => api.items({ status: 'unmatched,pending', limit: 200, sort: 'added' }) });
  const run = useMutation({
    mutationFn: () => api.retryUnmatched(),
    onSuccess: (r) => {
      toast(r.requeued ? `Retrying ${r.requeued} file${r.requeued === 1 ? '' : 's'} with the improved matcher` : 'Nothing to retry', 'success');
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['match-queue'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const control = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel') => (a === 'pause' ? api.pauseMatch() : a === 'resume' ? api.resumeMatch() : api.cancelMatch()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['match-queue'] }); qc.invalidateQueries({ queryKey: ['items'] }); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const s = status.data;
  const eta = (sec: number | null | undefined) => (sec == null ? '' : sec < 90 ? `${Math.max(1, Math.round(sec))} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
  return (
    <>
      <div className="panel stack gap-12">
        <div className="row gap-12 wrap">
          <span className="ic violet" style={{ width: 44, height: 44, borderRadius: 14 }}>
            <Wand2 size={18} />
          </span>
          <div className="grow">
            <div className="h4" style={{ fontSize: 16 }}>{s?.running ? (s.paused ? 'Matching paused' : 'Matching…') : 'Metadata matching'}</div>
            <div className="caption">
              {s?.running ? s.current || 'Working' : `${s?.counts.matched || 0} matched · ${(s?.counts.unmatched || 0) + (s?.counts.pending || 0)} need review`}
            </div>
          </div>
          {s?.running ? (
            <div className="row gap-8">
              <button className="btn btn-secondary btn-sm" onClick={() => control.mutate(s.paused ? 'resume' : 'pause')} disabled={control.isPending}>
                {s.paused ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => control.mutate('cancel')} disabled={control.isPending} aria-label="Cancel matching"><X size={14} /></button>
            </div>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => run.mutate()} disabled={run.isPending}>
              <RotateCw size={14} /> Retry matching
            </button>
          )}
        </div>
        {s?.running && (
          <>
            <div className="progress-line">
              <i style={{ width: `${Math.min(100, (s.processed / Math.max(1, s.total ?? s.processed + (s.counts.pending || 0))) * 100)}%` }} />
            </div>
            <p className="caption" style={{ margin: 0 }}>
              {s.processed} / {s.total ?? s.processed + (s.counts.pending || 0)} files · {s.matched} matched
              {s.rate ? ` · ${Math.round(s.rate)} files/min` : ''}{s.etaSeconds != null && !s.paused ? ` · about ${eta(s.etaSeconds)} left` : ''}
              {s.groups && s.groups.total > 0 ? ` · ${s.groups.done}/${s.groups.total} performer/studio batches` : ''}
            </p>
          </>
        )}
        {s?.strategies && Object.keys(s.strategies).length > 0 && (
          <p className="caption" style={{ margin: 0 }}>
            Matched by: {Object.entries(s.strategies).map(([k, n]) => `${strategyLabel(k)} ${n}`).join(' · ')}
          </p>
        )}
        {s?.errorCounts && Object.keys(s.errorCounts).length > 0 && (
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {Object.entries(s.errorCounts).map(([k, n]) => <span key={k} className="badge warn">{ERROR_LABEL[k] || k} · {n}</span>)}
          </div>
        )}
        {s?.lastError && <p className="error-text" style={{ margin: 0, wordBreak: 'break-word' }}>Last error: {s.lastError}</p>}
        {!s?.running && !!s?.failed && !s?.lastError && <p className="caption" style={{ margin: 0 }}>{s.failed} file(s) failed.</p>}
        {s?.retryAt && <p className="caption" style={{ margin: 0 }}>Failed files retry automatically around {new Date(s.retryAt).toLocaleTimeString()}.</p>}
        {!s?.running && !!s?.unmatched && <p className="caption" style={{ margin: 0 }}>{s.unmatched} file(s) were searched but had no confident match — tap one and use Search.</p>}
      </div>
      <div className="mt-16">
        {r.isLoading && <RowSkeletons />}
        {r.data && !r.data.items.length && <EmptyState title="All matched">Every video in your library has metadata.</EmptyState>}
        <div className="stack gap-4">
          {r.data?.items.map((it) => (
            <RowItem
              key={it.id}
              item={it}
              onClick={() => setMatching(it)}
              sub={it.path ? it.path.split('/').slice(0, -1).join('/') || '/' : it.name}
              below={
                it.matchStatus === 'pending' ? (
                  <span className="badge">Queued</span>
                ) : it.matchError ? (
                  <span className="badge warn" title={it.matchError}>Error · {it.matchError.slice(0, 40)}</span>
                ) : (
                  <Confidence value={it.matchConfidence} />
                )
              }
              right={
                <span className="icon-btn" aria-hidden>
                  <Search size={18} />
                </span>
              }
            />
          ))}
        </div>
      </div>
      {matching && <MatchSheet item={matching} onClose={() => setMatching(null)} />}
    </>
  );
}

export default function Library() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const client = useQueryClient();
  useEffect(() => {
    const on = () => client.invalidateQueries({ queryKey: ['items'] });
    window.addEventListener('pulse-refresh', on);
    return () => window.removeEventListener('pulse-refresh', on);
  }, [client]);
  const tab = (sp.get('tab') as Tab) || 'scenes';
  const [q, setQ] = useState(sp.get('q') || '');
  const dq = useDebounced(q.trim(), 250);
  const filters = useMemo(() => readFilters(sp), [sp]);
  const [sheet, setSheet] = useState(false);
  const n = activeCount(filters);
  useEffect(() => {
    const next = new URLSearchParams(sp);
    dq ? next.set('q', dq) : next.delete('q');
    next.delete('focus');
    if (next.toString() !== sp.toString()) setSp(next, { replace: true });
  }, [dq]);
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(sp);
    t === 'scenes' ? next.delete('tab') : next.set('tab', t);
    setSp(next, { replace: true });
  };
  const quick = (patch: Partial<Filters>) => setSp(writeFilters(sp, { ...filters, ...patch }), { replace: true });
  const sortLabel = SORTS.find((s) => s.value === (filters.sort || 'added'))?.label;

  return (
    <main className="page">
      <header className="topbar">
        <h1 className="h1 clamp-1 grow">Library</h1>
        <button className="btn btn-secondary btn-sm" onClick={() => nav('/settings/pcloud')}>
          <Plus size={16} /> Folders
        </button>
      </header>
      <Segmented
        label="Library sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'scenes', label: 'Scenes' },
          { value: 'performers', label: 'Stars' },
          { value: 'studios', label: 'Studios' },
          { value: 'review', label: 'Review' },
        ]}
      />
      {tab !== 'review' && (
        <div className="mt-16">
          <SearchField value={q} onChange={setQ} placeholder={tab === 'scenes' ? 'Search titles, studios, performers' : tab === 'performers' ? 'Search performers' : 'Search studios'} autoFocus={sp.get('focus') === '1'} />
        </div>
      )}
      {tab === 'scenes' && (
        <div className="chips mt-16">
          <Chip on={n > 0} onClick={() => setSheet(true)}>
            <SlidersHorizontal size={14} /> Filters{n ? ` · ${n}` : ''}
          </Chip>
          <Chip onClick={() => setSheet(true)}>Sort: {sortLabel}</Chip>
          <Chip on={!!filters.favorites} onClick={() => quick({ favorites: !filters.favorites || undefined })}>
            <Heart size={14} /> Favorites
          </Chip>
          <Chip on={!!filters.watchlist} onClick={() => quick({ watchlist: !filters.watchlist || undefined })}>
            <Bookmark size={14} /> Watchlist
          </Chip>
          <Chip on={filters.status === 'unmatched,pending'} onClick={() => quick({ status: filters.status ? undefined : 'unmatched,pending' })}>
            Unmatched
          </Chip>
        </div>
      )}
      <div className="mt-16">
        {tab === 'scenes' && <ScenesTab q={dq} filters={filters} />}
        {tab === 'performers' && <PerformersTab q={dq} />}
        {tab === 'studios' && <StudiosTab q={dq} />}
        {tab === 'review' && <ReviewTab />}
      </div>
      {sheet && (
        <FilterSheet
          q={dq}
          value={filters}
          onClose={() => setSheet(false)}
          onApply={(f) => {
            setSp(writeFilters(sp, f), { replace: true });
            setSheet(false);
          }}
        />
      )}
    </main>
  );
}
