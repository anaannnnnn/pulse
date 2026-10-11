import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { api } from '../api';
import { Switch } from './ui';
import { useToast } from './Toast';

export const PATH_LABEL = { direct: 'direct', doh: 'DNS-over-HTTPS fallback', proxy: 'Cloudflare Worker proxy' } as const;

/** Settings > Sources: StashDB status + Test button, and the on/off switches for both metadata providers. */
export function MetadataSources() {
  const toast = useToast();
  const qc = useQueryClient();
  const src = useQuery({ queryKey: ['metadata-sources'], queryFn: () => api.metadataSources() });
  const test = useMutation({ mutationFn: () => api.stashdbTest(), onError: (e) => toast((e as Error).message, 'error') });
  const toggle = useMutation({
    mutationFn: (v: { id: 'tpdb' | 'stashdb'; enabled: boolean }) => api.setMetadataSource(v.id, v.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['metadata-sources'] }),
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const stash = src.data?.find((s) => s.id === 'stashdb');
  const state = !stash ? 'off' : !stash.configured ? 'err' : stash.enabled ? 'ok' : 'warn';
  return (
    <>
      <div className="cell">
        <span className="ic violet"><Database size={18} /></span>
        <span className="grow stack">
          <span className="lbl">StashDB</span>
          <span className="val">{src.isLoading ? 'Checking…' : !stash?.configured ? 'API key missing on server (STASHDB_API_KEY)' : stash.enabled ? 'Key set · second metadata source' : 'Key set · switched off'}</span>
        </span>
        <button className="btn btn-secondary btn-sm" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? 'Testing…' : 'Test StashDB'}</button>
        <span className={`dot ${state === 'off' ? '' : state}`} aria-hidden />
      </div>
      {test.data && (
        <div className="cell" role="status" aria-live="polite">
          <span className="grow stack">
            <span className="lbl">{test.data.ok ? 'StashDB works' : `StashDB problem: ${test.data.status.replace('_', ' ')}`}</span>
            <span className="val" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{test.data.hint}</span>
            {test.data.path && <span className="val">Network path: {PATH_LABEL[test.data.path]}</span>}
          </span>
        </div>
      )}
      {src.data?.map((s) => (
        <div className="cell" key={s.id}>
          <span className="grow stack">
            <span className="lbl">Use {s.label} for matching</span>
            <span className="val">{!s.configured ? 'No API key on the server' : s.enabled ? 'On · queried in parallel' : 'Off'}</span>
          </span>
          <Switch label={`Use ${s.label}`} checked={s.enabled} disabled={!s.configured || toggle.isPending} onChange={(v) => toggle.mutate({ id: s.id, enabled: v })} />
        </div>
      ))}
    </>
  );
}
