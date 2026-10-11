import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Cloud, Copy, ExternalLink, Folder, FolderCheck, ChevronRight, RefreshCw, Trash2, Plus, ClipboardPaste, LogOut, Check } from 'lucide-react';
import { api, type Folder as F, type FolderListing } from '../api';
import { ErrorState, Modal, RowSkeletons, Sheet, Skeleton } from '../components/ui';
import { useToast } from '../components/Toast';
import { fmtBytes, fmtRelative } from '../lib/format';

function FolderPicker({ initial, onClose, onSave }: { initial: F[]; onClose: () => void; onSave: (f: F[]) => void }) {
  const [stack, setStack] = useState<{ id: number; name: string; path: string }[]>([{ id: 0, name: 'pCloud Drive', path: '' }]);
  const [sel, setSel] = useState<F[]>(initial);
  const cur = stack[stack.length - 1];
  const q = useQuery<FolderListing>({ queryKey: ['pc-folders', cur.id], queryFn: () => api.pcloudFolders(cur.id) });
  const isSel = (id: number) => sel.some((f) => f.folderId === id);
  const toggle = (f: { folderId: number; name: string }, path: string) =>
    setSel((s) => (s.some((x) => x.folderId === f.folderId) ? s.filter((x) => x.folderId !== f.folderId) : [...s, { folderId: f.folderId, name: f.name, path }]));
  return (
    <Sheet
      title="Choose folders"
      onClose={onClose}
      footer={
        <button className="btn btn-primary btn-block" onClick={() => onSave(sel)}>
          Use {sel.length} folder{sel.length === 1 ? '' : 's'}
        </button>
      }
    >
      <nav className="row gap-4 wrap caption" aria-label="Breadcrumb" style={{ marginBottom: 12 }}>
        {stack.map((s, i) => (
          <span key={s.id} className="row gap-4">
            {i > 0 && <ChevronRight size={12} />}
            <button className="link-btn" onClick={() => setStack(stack.slice(0, i + 1))} aria-current={i === stack.length - 1}>
              {s.name}
            </button>
          </span>
        ))}
      </nav>
      {cur.id !== 0 && (
        <button className="btn btn-secondary btn-sm" style={{ marginBottom: 12 }} onClick={() => toggle({ folderId: cur.id, name: cur.name }, cur.path)}>
          {isSel(cur.id) ? <Check size={14} /> : <Plus size={14} />} {isSel(cur.id) ? 'Selected' : 'Select this folder'}
          {q.data?.videoCount ? ` · ${q.data.videoCount} videos here` : ''}
        </button>
      )}
      {q.isLoading && <RowSkeletons n={4} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <div className="group">
        {q.data?.folders.map((f) => {
          const path = `${cur.path}/${f.name}`;
          const on = isSel(f.folderId);
          return (
            <div key={f.folderId} className="cell" style={{ padding: '8px 8px 8px 16px' }}>
              <button className="row gap-12 grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={() => setStack([...stack, { id: f.folderId, name: f.name, path }])}>
                <span className={`ic ${on ? 'brand' : ''}`}>{on ? <FolderCheck size={18} /> : <Folder size={18} />}</span>
                <span className="lbl clamp-1 grow">{f.name}</span>
                <ChevronRight size={16} className="chev" />
              </button>
              <button className={`chip sm ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(f, path)}>
                {on ? 'Added' : 'Add'}
              </button>
            </div>
          );
        })}
        {q.data && !q.data.folders.length && <p className="caption" style={{ padding: 16, margin: 0 }}>No subfolders here.</p>}
      </div>
    </Sheet>
  );
}

export default function PcloudSettings() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [paste, setPaste] = useState('');
  const [picker, setPicker] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const st = useQuery({ queryKey: ['pcloud-status'], queryFn: api.pcloudStatus, refetchInterval: (q) => (q.state.data?.scan.running ? 1500 : false) });
  const d = st.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pcloud-status'] });

  const start = useMutation({
    mutationFn: (mode: 'redirect' | 'manual') => api.pcloudStart(mode),
    onSuccess: (r) => {
      if (r.mode === 'redirect') location.href = r.url;
      else window.open(r.url, '_blank', 'noopener');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const complete = useMutation({
    mutationFn: () => api.pcloudComplete({ input: paste }),
    onSuccess: (r) => {
      toast(`pCloud connected${r.email ? ` as ${r.email}` : ''}`, 'success');
      setPaste('');
      refresh();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const save = useMutation({
    mutationFn: api.setFolders,
    onSuccess: () => {
      setPicker(false);
      refresh();
      toast('Folders saved. Scanning…', 'success');
      scan.mutate();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const scan = useMutation({
    mutationFn: () => api.scan(),
    onSuccess: refresh,
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const off = useMutation({
    mutationFn: api.pcloudDisconnect,
    onSuccess: () => {
      refresh();
      toast('pCloud disconnected', 'success');
    },
  });
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied', 'success'));

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => nav('/settings')} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <h1 className="h2 grow">pCloud</h1>
      </header>
      {st.isLoading && <Skeleton h={200} r={24} />}
      {st.isError && <ErrorState error={st.error} onRetry={() => st.refetch()} />}
      {d && !d.configured && (
        <div className="banner warn">The server is missing PCLOUD_CLIENT_ID / PCLOUD_CLIENT_SECRET. Add them to the server environment and restart.</div>
      )}

      {d && d.configured && !d.connected && (
        <div className="stack gap-16">
          <div className="panel stack gap-12" style={{ position: 'relative', overflow: 'hidden', isolation: 'isolate' }}>
            <div className="aurora" aria-hidden style={{ opacity: 0.35 }}><i /><i /><i /></div>
            <span className="ic" style={{ width: 52, height: 52, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'var(--grad-brand)', boxShadow: 'var(--glow-magenta)' }}>
              <Cloud size={24} color="#fff" />
            </span>
            <h2 className="h3">Connect your pCloud</h2>
            <p className="muted body-s" style={{ margin: 0 }}>
              Pulse needs your one-time permission to read your pCloud files. Your app secret stays on the server; videos stream straight from pCloud.
            </p>
            <button className="btn btn-primary btn-block" onClick={() => start.mutate('redirect')} disabled={start.isPending}>
              <ExternalLink size={16} /> Connect with pCloud
            </button>
          </div>

          <div className="panel stack gap-12">
            <div className="overline">Redirect URI to register</div>
            <p className="caption" style={{ margin: 0 }}>
              In the pCloud developer console (My apps → your app → Redirect URIs) add exactly this address, or the Connect button will fail:
            </p>
            <div className="row gap-8">
              <code className="mono grow" style={{ wordBreak: 'break-all', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                {d.redirectUri}
              </code>
              <button className="icon-btn sm" onClick={() => copy(d.redirectUri)} aria-label="Copy redirect URI">
                <Copy size={16} />
              </button>
            </div>
          </div>

          <div className="panel stack gap-12">
            <div className="overline">No redirect URI? Use a code</div>
            <ol className="body-s muted" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
              <li>Open the pCloud approval page and sign in.</li>
              <li>Approve Pulse. pCloud shows a code (or sends you to a page whose address contains <span className="mono">code=</span>).</li>
              <li>Paste the code or that whole address below.</li>
            </ol>
            <button className="btn btn-secondary" onClick={() => start.mutate('manual')}>
              <ExternalLink size={16} /> Open pCloud approval page
            </button>
            <div className="field">
              <label htmlFor="paste">Code or address from pCloud</label>
              <textarea id="paste" className="textarea" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the code, or https://…?code=…&hostname=…" />
            </div>
            <div className="row gap-8">
              <button className="btn btn-secondary btn-sm" onClick={async () => setPaste((await navigator.clipboard?.readText?.()) || paste)}>
                <ClipboardPaste size={14} /> Paste
              </button>
              <button className="btn btn-primary grow" disabled={!paste.trim() || complete.isPending} onClick={() => complete.mutate()}>
                {complete.isPending ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {d?.connected && (
        <div className="stack gap-16">
          <div className="panel stack gap-12">
            <div className="row gap-12">
              <span className="ic" style={{ width: 44, height: 44, borderRadius: 14, display: 'grid', placeItems: 'center', background: '#0b4049', color: 'var(--cyan)' }}>
                <Cloud size={20} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="h4 clamp-1" style={{ fontSize: 16 }}>{d.account?.email || 'Connected'}</div>
                <div className="caption">{d.region === 'EU' ? 'Europe data region' : 'US data region'} · {d.apiHost}</div>
              </div>
              <span className="badge ok">Connected</span>
            </div>
            {d.account && d.account.quota > 0 && (
              <div className="stack gap-4">
                <div className="progress-line"><i style={{ width: `${(d.account.usedQuota / d.account.quota) * 100}%` }} /></div>
                <span className="mono faint" style={{ fontSize: 11 }}>{fmtBytes(d.account.usedQuota)} of {fmtBytes(d.account.quota)} used</span>
              </div>
            )}
            {d.cache && (
              <div className="stack gap-4">
                <div className="row between">
                  <span className="lbl">Metadata cache</span>
                  <span className="badge ok">{d.cache.cloud ? 'On pCloud' : 'On this device'}</span>
                </div>
                <p className="caption" style={{ margin: 0 }}>
                  {d.cache.cloud
                    ? `Recent answers stay on this device (${fmtBytes(d.cache.localBytes)}). The rest, ${fmtBytes(d.cache.cloudBytes)}${d.cache.entries ? ` · ${d.cache.entries.toLocaleString()} saved` : ''}, is in your pCloud folder “Pulse Cache”, so matching does not fill this device.`
                    : 'Connect pCloud and the metadata cache moves off this device into a “Pulse Cache” folder.'}
                </p>
              </div>
            )}
            {d.error && <p className="error-text" style={{ margin: 0 }}>{d.error}</p>}
          </div>

          <div>
            <div className="row between group-title" style={{ marginTop: 8 }}>
              <h2 className="overline">Library folders</h2>
              <button className="link-btn row gap-4" onClick={() => setPicker(true)}><Plus size={14} /> Add</button>
            </div>
            <div className="group">
              {d.folders.map((f) => (
                <div key={f.folderId} className="cell">
                  <span className="ic brand"><FolderCheck size={18} /></span>
                  <span className="grow stack" style={{ minWidth: 0 }}>
                    <span className="lbl clamp-1">{f.name}</span>
                    <span className="val clamp-1">{f.path || ''}{f.fileCount != null ? ` · ${f.fileCount} videos` : ''}</span>
                  </span>
                  <button className="icon-btn sm ghost" aria-label={`Remove ${f.name}`} onClick={() => save.mutate(d.folders.filter((x) => x.folderId !== f.folderId))}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {!d.folders.length && (
                <button className="cell" onClick={() => setPicker(true)}>
                  <span className="ic"><Plus size={18} /></span>
                  <span className="grow stack"><span className="lbl">Choose folders</span><span className="val">Pick where your videos live. Nothing selected scans the whole drive.</span></span>
                </button>
              )}
            </div>
          </div>

          <div className="panel stack gap-12">
            <div className="row gap-12">
              <div className="grow">
                <div className="h4" style={{ fontSize: 16 }}>{d.scan.running ? 'Scanning…' : 'Library scan'}</div>
                <div className="caption clamp-1">
                  {d.scan.running ? d.scan.folder || 'Reading folders' : d.scan.error ? d.scan.error : `${d.scan.found} videos · last scan ${fmtRelative(d.scan.finishedAt)}${d.scan.added ? ` · ${d.scan.added} new` : ''}`}
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => scan.mutate()} disabled={d.scan.running || scan.isPending}>
                <RefreshCw size={14} className={d.scan.running ? 'spin' : ''} /> Rescan
              </button>
            </div>
            {d.scan.running && <div className="progress-line"><i style={{ width: '60%', animation: 'shimmer 1.4s infinite' }} /></div>}
          </div>

          <button className="btn btn-danger" onClick={() => setConfirmOff(true)}>
            <LogOut size={16} /> Disconnect pCloud
          </button>
        </div>
      )}
      {picker && d && <FolderPicker initial={d.folders} onClose={() => setPicker(false)} onSave={(f) => save.mutate(f)} />}
      {confirmOff && (
        <Modal
          title="Disconnect pCloud?"
          icon={<LogOut size={20} />}
          onClose={() => setConfirmOff(false)}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmOff(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { setConfirmOff(false); off.mutate(); }}>Disconnect</button>
            </>
          }
        >
          Streaming stops until you connect again. Your library index and metadata are kept.
        </Modal>
      )}
    </main>
  );
}
