import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Trash2, ChevronDown, ChevronUp, Magnet, Link2, FileUp, Zap, Pause, PlayCircle, CloudUpload, Settings as Gear, Download } from 'lucide-react';
import { api, caps, type TorboxItem, type TorboxKind } from '../api';
import { EmptyState, ErrorState, Modal, RowSkeletons, Segmented, Sheet } from '../components/ui';
import { useToast } from '../components/Toast';
import { usePlayer } from '../player/PlayerContext';
import { torboxSource } from '../lib/play';
import { fmtBytes, fmtTime } from '../lib/format';

const btih = (m: string) => m.match(/xt=urn:btih:([a-z0-9]{32,40})/i)?.[1]?.toLowerCase() || null;

function AddSheet({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<'magnet' | 'web' | 'nzb'>('magnet');
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const hash = type === 'magnet' ? btih(value) : null;
  const cached = useQuery({ queryKey: ['tb-cached', hash], queryFn: () => api.torboxCached([hash!]), enabled: !!hash, staleTime: 60_000 });
  const add = useMutation({
    mutationFn: async () => {
      if (file) {
        const isTorrent = file.name.endsWith('.torrent');
        const fileBase64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] || '');
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        return api.torboxAdd({ type: isTorrent ? 'torrent-file' : 'nzb-file', fileName: file.name, fileBase64, file } as Parameters<typeof api.torboxAdd>[0]);
      }
      return api.torboxAdd({ type: type === 'magnet' ? 'magnet' : type === 'web' ? 'web' : 'nzb-url', value: value.trim() });
    },
    onSuccess: () => {
      toast('Added to TorBox', 'success');
      qc.invalidateQueries({ queryKey: ['torbox'] });
      onClose();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const valid = file || (type === 'magnet' ? /^magnet:\?/i.test(value.trim()) : /^https?:\/\//i.test(value.trim()));
  return (
    <Sheet
      title="Add to TorBox"
      onClose={onClose}
      footer={
        <button className="btn btn-primary btn-block" disabled={!valid || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? 'Adding…' : 'Add download'}
        </button>
      }
    >
      <div className="stack gap-16">
        <Segmented label="Type" value={type} onChange={(t) => { setType(t); setFile(null); }} options={[{ value: 'magnet', label: 'Magnet' }, { value: 'web', label: 'Web link' }, { value: 'nzb', label: 'Usenet' }]} />
        <div className="field">
          <label htmlFor="tb-in">{type === 'magnet' ? 'Magnet link' : type === 'web' ? 'Direct or hoster link' : 'NZB link'}</label>
          <textarea id="tb-in" className="textarea" placeholder={type === 'magnet' ? 'magnet:?xt=urn:btih:…' : 'https://…'} value={value} onChange={(e) => setValue(e.target.value)} disabled={!!file} />
          {hash && (
            <span className="row gap-8 hint">
              {cached.isLoading ? 'Checking TorBox cache…' : cached.data?.cached[hash] ? <span className="badge ok"><Zap size={11} /> Cached, ready instantly</span> : <span className="badge">Not cached, TorBox will download it</span>}
            </span>
          )}
        </div>
        {type !== 'web' && (
          <div className="stack gap-8">
            <span className="caption">or upload a {type === 'magnet' ? '.torrent' : '.nzb'} file</span>
            <input ref={fileRef} type="file" accept={type === 'magnet' ? '.torrent,application/x-bittorrent' : '.nzb'} hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
              <FileUp size={16} /> {file ? file.name : 'Choose file'}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function FolderSave({ item, fileId, onClose }: { item: TorboxItem; fileId: number; onClose: () => void }) {
  const toast = useToast();
  const st = useQuery({ queryKey: ['pcloud-status'], queryFn: api.pcloudStatus });
  const save = useMutation({
    mutationFn: (folderId: number) => api.torboxSaveToPcloud({ kind: item.kind, id: item.id, fileId, folderId }),
    onSuccess: () => {
      toast('pCloud is fetching the file. It appears after your next scan.', 'success');
      onClose();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <Sheet title="Save to pCloud" onClose={onClose}>
      {!st.data?.connected ? (
        <EmptyState title="pCloud isn’t connected" action={<Link to="/settings/pcloud" className="btn btn-primary">Connect pCloud</Link>} />
      ) : (
        <div className="group">
          {st.data.folders.map((f) => (
            <button key={f.folderId} className="cell" onClick={() => save.mutate(f.folderId)} disabled={save.isPending}>
              <span className="ic cyan"><CloudUpload size={18} /></span>
              <span className="grow stack"><span className="lbl">{f.name}</span><span className="val">{f.path}</span></span>
            </button>
          ))}
          {!st.data.folders.length && <p className="caption" style={{ padding: 16 }}>Add a library folder in pCloud settings first.</p>}
        </div>
      )}
    </Sheet>
  );
}

function Download_({ t }: { t: TorboxItem }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const player = usePlayer();
  const toast = useToast();
  const qc = useQueryClient();
  const ctl = useMutation({
    mutationFn: (op: 'delete' | 'pause' | 'resume') => api.torboxControl(t.kind, t.id, op),
    onSuccess: (_d, op) => {
      toast(op === 'delete' ? 'Removed from TorBox' : op === 'pause' ? 'Paused' : 'Resumed', 'success');
      qc.invalidateQueries({ queryKey: ['torbox'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const playable = t.files.filter((f) => f.playable).sort((a, b) => b.size - a.size);
  const downloading = !t.ready && t.progress < 1;
  return (
    <div className="tb-item">
      <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
        <div className="grow stack gap-4" style={{ minWidth: 0 }}>
          <span className="clamp-2" style={{ fontWeight: 600, fontSize: 14, wordBreak: 'break-word' }}>{t.name}</span>
          <span className="row gap-8 wrap caption">
            <span className="badge">{t.kind === 'webdl' ? 'Web' : t.kind === 'usenet' ? 'Usenet' : 'Torrent'}</span>
            {t.ready ? <span className="badge ok">Ready</span> : <span className="badge warn">{t.state}</span>}
            <span>{fmtBytes(t.size)}</span>
            {playable.length > 0 && <span>{playable.length} video{playable.length > 1 ? 's' : ''}</span>}
          </span>
        </div>
        {playable.length > 0 && t.ready && (
          <button className="icon-btn" style={{ background: 'var(--cta)', borderColor: 'transparent', color: 'var(--cta-text)' }} aria-label={`Play ${t.name}`} onClick={() => player.play(torboxSource(t, playable[0]))}>
            <Play size={18} fill="currentColor" />
          </button>
        )}
      </div>
      {downloading && (
        <div className="stack gap-4">
          <div className="progress-line"><i style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
          <div className="row between mono faint" style={{ fontSize: 11 }}>
            <span>{Math.round(t.progress * 100)}% · {fmtBytes(t.speed)}/s</span>
            <span>{t.eta ? `${fmtTime(t.eta)} left` : t.seeds != null ? `${t.seeds} seeds` : ''}</span>
          </div>
        </div>
      )}
      <div className="row gap-8">
        {t.files.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {t.files.length} file{t.files.length > 1 ? 's' : ''}
          </button>
        )}
        <span className="grow" />
        {caps.pause && t.kind === 'torrents' && downloading && (
          <button className="icon-btn sm" aria-label="Pause" onClick={() => ctl.mutate('pause')}><Pause size={16} /></button>
        )}
        {caps.pause && t.kind === 'torrents' && t.state === 'paused' && (
          <button className="icon-btn sm" aria-label="Resume" onClick={() => ctl.mutate('resume')}><PlayCircle size={16} /></button>
        )}
        <button className="icon-btn sm" aria-label="Delete" onClick={() => setConfirm(true)}><Trash2 size={16} /></button>
      </div>
      {open && (
        <div className="stack">
          {t.files.map((f) => (
            <div key={f.id} className="row gap-8" style={{ padding: '8px 0', borderTop: '1px solid var(--border-subtle)' }}>
              <span className="grow stack" style={{ minWidth: 0 }}>
                <span className="clamp-1 body-s">{f.name}</span>
                <span className="mono faint" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>
              </span>
              {f.playable && t.ready && (
                <button className="icon-btn sm" aria-label={`Play ${f.name}`} onClick={() => player.play(torboxSource(t, f))}><Play size={14} /></button>
              )}
              {caps.saveToPcloud && f.playable && t.ready && (
                <button className="icon-btn sm" aria-label={`Save ${f.name} to pCloud`} onClick={() => setSaving(f.id)}><CloudUpload size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <Modal
          title="Remove from TorBox?"
          icon={<Trash2 size={20} />}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { setConfirm(false); ctl.mutate('delete'); }}><Trash2 size={16} /> Remove</button>
            </>
          }
        >
          “{t.name}” will be deleted from your TorBox account.
        </Modal>
      )}
      {saving != null && <FolderSave item={t} fileId={saving} onClose={() => setSaving(null)} />}
    </div>
  );
}

export default function TorBox() {
  const [kind, setKind] = useState<'all' | TorboxKind>('all');
  const [adding, setAdding] = useState(false);
  const status = useQuery({ queryKey: ['torbox', 'status'], queryFn: api.torboxStatus });
  const list = useQuery({
    queryKey: ['torbox', 'list'],
    queryFn: () => api.torboxList(),
    enabled: !!status.data?.linked,
    refetchInterval: (q) => (q.state.data?.items.some((i) => !i.ready && i.progress < 1) ? 5000 : 30000),
  });
  const items = useMemo(() => (list.data?.items || []).filter((i) => kind === 'all' || i.kind === kind), [list.data, kind]);
  return (
    <main className="page">
      <header className="topbar">
        <div className="grow">
          <div className="overline">{status.data?.account ? `${status.data.account.plan} plan` : 'Cloud downloads'}</div>
          <h1 className="h1">TorBox</h1>
        </div>
        <Link to="/settings/torbox" className="icon-btn" aria-label="TorBox settings"><Gear size={20} /></Link>
        {status.data?.linked && (
          <button className="icon-btn" aria-label="Add download" onClick={() => setAdding(true)}><Plus size={22} /></button>
        )}
      </header>
      {status.isLoading && <RowSkeletons />}
      {status.isError && <ErrorState error={status.error} onRetry={() => status.refetch()} />}
      {status.data && !status.data.linked && (
        <EmptyState icon={<Download size={28} />} title="Link your TorBox account" action={<Link to="/settings/torbox" className="btn btn-primary">Link TorBox</Link>}>
          Stream torrents, Usenet and web downloads from TorBox in the same player.
        </EmptyState>
      )}
      {status.data?.linked && (
        <>
          <Segmented label="Download type" value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'torrents', label: 'Torrents' }, { value: 'usenet', label: 'Usenet' }, { value: 'webdl', label: 'Web' }]} />
          <div className="row gap-8 mt-16 caption">
            <Magnet size={14} /> {list.data?.items.filter((i) => i.kind === 'torrents').length ?? '–'}
            <Link2 size={14} style={{ marginLeft: 8 }} /> {list.data?.items.filter((i) => i.kind !== 'torrents').length ?? '–'}
            <span className="grow" />
            {list.isFetching && <span className="eq" aria-label="Refreshing"><i /><i /><i /></span>}
          </div>
          <div className="stack gap-12 mt-16">
            {list.isLoading && <RowSkeletons />}
            {list.isError && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
            {list.data && !items.length && (
              <EmptyState title="Nothing here yet" action={<button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} /> Add download</button>}>
                Paste a magnet, web link or NZB and TorBox fetches it in the cloud.
              </EmptyState>
            )}
            {items.map((t) => (
              <Download_ key={t.key} t={t} />
            ))}
          </div>
        </>
      )}
      {adding && <AddSheet onClose={() => setAdding(false)} />}
    </main>
  );
}
