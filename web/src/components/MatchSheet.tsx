import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCw, EyeOff, Unlink, Search } from 'lucide-react';
import { api, type Candidate, type Item } from '../api';
import { Sheet, Segmented, RowSkeletons, EmptyState, Confidence } from './ui';
import { Cover } from './Art';
import { useToast } from './Toast';
import { fmtDate, providerLabel, strategyLabel } from '../lib/format';

type Type = 'scene' | 'movie' | 'jav';

export function MatchSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [type, setType] = useState<Type | 'auto'>('auto');
  /** The query that was actually submitted; null = show the stored alternatives from the last automatic run. */
  const [submitted, setSubmitted] = useState<{ q: string; type: Type | 'auto' } | null>(null);
  const prefilled = useRef(false);

  // Stored info: cleaned query to pre-fill, matched-by strategy and the top-5 alternatives (with scores) from the last automatic run.
  const info = useQuery({ queryKey: ['match-info', item.id], queryFn: () => api.matchInfo(item.id), staleTime: 30_000 });
  useEffect(() => {
    if (info.data && !prefilled.current) {
      prefilled.current = true;
      setQ(info.data.query);
    }
  }, [info.data]);
  const hasStored = !!info.data?.alternatives.length;
  // Without stored alternatives (never tried / matched long ago) run the automatic cascade once so the sheet is never empty.
  const needAuto = info.isSuccess && !hasStored && !submitted;
  const search = useQuery({
    queryKey: ['match-search', item.id, submitted?.q ?? '', submitted?.type ?? 'auto'],
    queryFn: () => api.matchSearch({ itemId: item.id, q: submitted?.q || undefined, type: submitted && submitted.type !== 'auto' ? submitted.type : undefined }),
    enabled: !!submitted || needAuto,
    staleTime: 5 * 60_000,
  });
  const submit = () => setSubmitted({ q: q.trim(), type });

  const done = (msg: string) => {
    qc.invalidateQueries();
    toast(msg, 'success');
    onClose();
  };
  const apply = useMutation({ mutationFn: (c: { id: string; type: string; source?: string }) => api.applyMatch(item.id, c.id, c.type, c.source === 'stashdb' ? 'stashdb' : 'tpdb'), onSuccess: () => done('Matched. Metadata updated.'), onError: (e) => toast((e as Error).message, 'error') });
  const other = useMutation({
    mutationFn: async (a: 'unmatch' | 'ignore' | 'rematch') => (a === 'unmatch' ? api.unmatch(item.id) : a === 'ignore' ? api.ignore(item.id) : api.rematch(item.id)),
    onSuccess: (_d, a) => done(a === 'rematch' ? 'Re-matching in the background' : a === 'ignore' ? 'Hidden from the unmatched queue' : 'Match removed'),
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const showSearch = !!submitted || needAuto;
  const candidates: Candidate[] = showSearch ? search.data?.candidates ?? [] : info.data?.alternatives ?? [];
  const loading = showSearch ? search.isFetching : info.isLoading;
  const err = (showSearch ? search.error : info.error) as Error | null;
  const strategy = item.matchStrategy || (showSearch ? search.data?.strategy : info.data?.strategy);
  const parsed = search.data?.parsed;

  return (
    <Sheet title="Match metadata" onClose={onClose}>
      <div className="stack gap-12">
        <div className="panel" style={{ padding: 12 }}>
          <div className="overline">File</div>
          <div className="mono" style={{ wordBreak: 'break-all', marginTop: 4 }}>{item.name}</div>
          <div className="row gap-8 wrap mt-8">
            {item.matchStatus === 'matched' && item.provider && <span className="badge violet" title="Metadata provider">Matched via {providerLabel(item.provider)}</span>}
            {item.matchStatus === 'matched' && strategy && <span className="badge ok" title="Strategy that found this match">Matched by {strategyLabel(strategy)}</span>}
            {parsed?.site && <span className="badge violet">{parsed.site}</span>}
            {parsed?.date && <span className="badge cyan">{parsed.date}</span>}
            {parsed?.jav && <span className="badge brand">{parsed.jav}</span>}
            {parsed?.resolution && <span className="badge">{parsed.resolution}</span>}
          </div>
        </div>

        <form
          className="stack gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="overline" htmlFor="match-q">Search query</label>
          <div className="row gap-8">
            <input
              id="match-q"
              className="input grow"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={info.isLoading ? 'Cleaning file name…' : 'Studio, performer, title words'}
              enterKeyHint="search"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button type="submit" className="btn btn-primary" disabled={!q.trim() || search.isFetching}>
              <Search size={16} /> Search
            </button>
          </div>
          <p className="caption" style={{ margin: 0 }}>Pre-filled from the file name with extension, resolution and release tags removed. Edit it, then tap Search.</p>
        </form>
        <Segmented
          label="Type"
          value={type}
          onChange={(v) => {
            setType(v);
            if (submitted) setSubmitted({ q: submitted.q, type: v });
          }}
          options={[{ value: 'auto', label: 'All' }, { value: 'scene', label: 'Scenes' }, { value: 'movie', label: 'Movies' }, { value: 'jav', label: 'JAV' }]}
        />

        {!showSearch && hasStored && <div className="overline">Best guesses from the last automatic run</div>}
        <div className="stack gap-4" style={{ minHeight: 200 }}>
          {loading && <RowSkeletons n={4} />}
          {err && <p className="error-text">{err.message}</p>}
          {!loading && !err && !candidates.length && <EmptyState title="No results">Try fewer words, or just the studio and a performer name.</EmptyState>}
          {!loading &&
            candidates.map((c) => (
              <button key={`${c.source || 'tpdb'}:${c.type}:${c.id}`} className="row-item" onClick={() => apply.mutate(c)} disabled={apply.isPending} style={{ alignItems: 'flex-start' }}>
                <span className="thumb" style={{ width: 64, height: 92 }}>
                  <Cover src={c.poster} alt="" seed={c.id} />
                </span>
                <span className="grow stack gap-4" style={{ minWidth: 0 }}>
                  <span className="t clamp-2">{c.title}</span>
                  <span className="s clamp-1">{[c.site, fmtDate(c.date)].filter(Boolean).join(' · ')}</span>
                  {c.performers.length > 0 && <span className="s clamp-1">{c.performers.slice(0, 3).join(', ')}</span>}
                  <span className="row gap-8 wrap">
                    <Confidence value={c.confidence} />
                    <span className="badge violet" title={c.alsoOn?.length ? 'Also found on ' + c.alsoOn.map((a) => providerLabel(a.source)).join(', ') : 'Metadata provider'}>{providerLabel(c.source || 'tpdb')}{c.alsoOn?.length ? ' + ' + c.alsoOn.map((a) => providerLabel(a.source)).join(', ') : ''}</span>
                    {c.matchedBy && <span className="badge" title="Matching strategy that surfaced this result">{strategyLabel(c.matchedBy)}</span>}
                  </span>
                </span>
                {item.scene?.id === c.id ? <Check size={18} color="var(--success)" /> : null}
              </button>
            ))}
        </div>
        <div className="row gap-8 wrap">
          <button className="btn btn-secondary btn-sm" onClick={() => other.mutate('rematch')}>
            <RotateCw size={14} /> Auto-match again
          </button>
          {item.scene && (
            <button className="btn btn-secondary btn-sm" onClick={() => other.mutate('unmatch')}>
              <Unlink size={14} /> Remove match
            </button>
          )}
          {item.matchStatus !== 'ignored' && (
            <button className="btn btn-ghost btn-sm" onClick={() => other.mutate('ignore')}>
              <EyeOff size={14} /> Not a scene, ignore
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
