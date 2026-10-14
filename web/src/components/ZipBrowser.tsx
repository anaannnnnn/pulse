import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Download, CloudUpload, Library as LibraryIcon } from 'lucide-react';
import { api, type TorboxFile, type TorboxItem } from '../api';
import { EmptyState, ErrorState, RowSkeletons, SearchField, Sheet } from './ui';
import { PcloudFolderPicker } from './PcloudFolderPicker';
import { useToast } from './Toast';
import { usePlayer } from '../player/PlayerContext';
import { zipEntrySource } from '../lib/play';
import { fmtBytes } from '../lib/format';

const PAGE = 100;

/**
 * The files inside a zip that sits in TorBox. The archive is never downloaded or unpacked: the server reads its table of
 * contents with a couple of Range requests and streams single files out of it, so each one can be played, saved to the
 * device, copied to pCloud or added to the library on its own.
 */
export function ZipBrowser({ item, file, onClose }: { item: TorboxItem; file: TorboxFile; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState(false);
  const player = usePlayer();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['tb-zip', item.kind, item.id, file.id],
    queryFn: () => api.torboxZipEntries(item.kind, item.id, file.id),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  useEffect(() => setShown(PAGE), [q]);
  const entries = list.data?.entries ?? [];
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? entries.filter((e) => e.name.toLowerCase().includes(n)) : entries;
  }, [entries, q]);
  const playable = filtered.filter((e) => e.playable);
  const allSelected = playable.length > 0 && playable.every((e) => sel.has(e.name));
  const toggle = (name: string) => setSel((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const toggleAll = () => setSel((s) => { const n = new Set(s); for (const e of playable) { if (allSelected) n.delete(e.name); else n.add(e.name); } return n; });
  const target: string[] | 'videos' = sel.size ? [...sel] : 'videos';
  const count = sel.size || list.data?.videos || 0;
  const hasSlowSeek = entries.some((e) => e.playable && !e.seekable);
  const zipBase = file.name.replace(/\.zip$/i, '');

  const toPcloud = useMutation({
    mutationFn: (folderId: number) => api.torboxSaveToPcloud({ kind: item.kind, id: item.id, fileId: file.id, folderId, entries: target, subfolder: zipBase }),
    onSuccess: (r) => {
      toast(r.message, 'success');
      setPicking(false);
      setSel(new Set());
      qc.invalidateQueries({ queryKey: ['torbox', 'transfers'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const toLibrary = useMutation({
    mutationFn: () => api.torboxImportZip({ kind: item.kind, id: item.id, fileId: file.id, entries: sel.size ? [...sel] : undefined }),
    onSuccess: (r) => {
      toast(r.added ? `${r.added} video${r.added === 1 ? '' : 's'} added to your library` : 'Already in your library', 'success');
      setSel(new Set());
      qc.invalidateQueries();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  return (
    <>
      <Sheet
        title={<span className="clamp-1">{file.name}</span>}
        onClose={onClose}
        footer={list.data && list.data.videos > 0 ? (
          <div className="row gap-8">
            <button className="btn btn-secondary grow" disabled={toLibrary.isPending} onClick={() => toLibrary.mutate()}>
              <LibraryIcon size={16} /> {toLibrary.isPending ? 'Adding…' : `Add ${count} to library`}
            </button>
            <button className="btn btn-primary grow" onClick={() => setPicking(true)}>
              <CloudUpload size={16} /> Save {count} to pCloud
            </button>
          </div>
        ) : undefined}
      >
        <div className="stack gap-12">
          {list.isLoading && (
            <>
              <p className="caption">Reading the archive’s table of contents…</p>
              <RowSkeletons n={6} />
            </>
          )}
          {list.isError && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
          {list.data && !list.data.videos && (
            <EmptyState title="No videos in this archive">
              {list.data.total ? `${list.data.total} other file${list.data.total === 1 ? '' : 's'} inside.` : 'The archive looks empty.'}
            </EmptyState>
          )}
          {list.data && list.data.videos > 0 && (
            <>
              <SearchField value={q} onChange={setQ} placeholder={`Search ${list.data.videos} videos`} />
              <div className="row gap-8 caption">
                <label className="row gap-8" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all shown videos" />
                  {sel.size ? `${sel.size} selected` : `${filtered.length} of ${list.data.videos} videos`}
                </label>
                <span className="grow" />
                <span className="mono faint">{fmtBytes(list.data.archiveSize)}</span>
              </div>
              {list.data.truncated && <p className="hint">Showing the first {entries.length} files. Use search to narrow it down.</p>}
              {hasSlowSeek && <p className="hint">Some files are compressed inside the zip. They play fine, but jumping ahead in those can take a few seconds.</p>}
              <div className="stack">
                {filtered.slice(0, shown).map((e) => (
                  <div key={e.name} className="row gap-8" style={{ padding: '8px 0', borderTop: '1px solid var(--border-subtle)' }}>
                    <input type="checkbox" checked={sel.has(e.name)} onChange={() => toggle(e.name)} disabled={!e.playable} aria-label={`Select ${e.shortName}`} />
                    <span className="grow stack" style={{ minWidth: 0 }}>
                      <span className="clamp-1 body-s">{e.shortName}</span>
                      <span className="mono faint clamp-1" style={{ fontSize: 11 }}>{[e.dir, fmtBytes(e.size), e.encrypted ? 'password protected' : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    {e.playable && (
                      <>
                        <button className="icon-btn sm" aria-label={`Play ${e.shortName}`} onClick={() => player.play(zipEntrySource(item, file, e))}><Play size={14} /></button>
                        <a className="icon-btn sm" aria-label={`Download ${e.shortName}`} href={api.torboxZipUrl(item.kind, item.id, file.id, e.name, true)} download={e.shortName}><Download size={14} /></a>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {filtered.length > shown && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</button>
              )}
              {!filtered.length && <p className="caption">Nothing matches “{q}”.</p>}
            </>
          )}
        </div>
      </Sheet>
      {picking && (
        <PcloudFolderPicker
          title="Save to pCloud"
          confirmLabel={`Save ${count} file${count === 1 ? '' : 's'} here`}
          busy={toPcloud.isPending}
          onPick={(f) => toPcloud.mutate(f.folderId)}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
