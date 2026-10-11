import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Database, Download, ChevronRight, Lock, EyeOff, Play, Gauge, Wand2, Moon, Trash2, Smartphone, Info, FolderOpen, RotateCcw, Heart } from 'lucide-react';
import { api, authEvents, caps, isMock } from '../api';
import { Modal, Segmented, Sheet, Switch } from '../components/ui';
import { useToast } from '../components/Toast';
import { usePrefs } from '../lib/prefs';
import { MetadataSources, PATH_LABEL } from '../components/MetadataSources';
import { fmtRelative } from '../lib/format';

function Dot({ s }: { s: 'ok' | 'warn' | 'err' | 'off' }) {
  return <span className={`dot ${s === 'off' ? '' : s}`} aria-hidden />;
}

function PinSheet({ timeout, onClose }: { timeout: number; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [current, setCurrent] = useState('');
  const [mins, setMins] = useState(timeout);
  const toast = useToast();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.setLock({ pin: pin || undefined, currentPin: current || undefined, timeoutMin: mins }),
    onSuccess: () => {
      toast(pin ? 'Passcode changed' : 'Lock settings saved', 'success');
      qc.invalidateQueries({ queryKey: ['session'] });
      onClose();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const changing = pin.length > 0;
  return (
    <Sheet title="Passcode lock" onClose={onClose}>
      <div className="stack gap-16">
        <p className="muted body-s" style={{ margin: 0 }}>
          Pulse is always locked until the passcode is entered. It is checked on the server, so it protects every device. The default passcode is 6442 — change it here.
        </p>
        <div className="field">
          <label htmlFor="cur">Current passcode</label>
          <input id="cur" className="input" inputMode="numeric" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value.replace(/\D/g, '').slice(0, 8))} />
        </div>
        <div className="field">
          <label htmlFor="new">New passcode (4–8 digits, leave empty to keep)</label>
          <input id="new" className="input" inputMode="numeric" type="password" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
        </div>
        <div className="field">
          <label>Lock after being idle</label>
          <Segmented label="Auto-lock" value={String(mins)} onChange={(v) => setMins(Number(v))} options={[{ value: '0', label: 'Never' }, { value: '5', label: '5 min' }, { value: '15', label: '15 min' }, { value: '60', label: '1 h' }]} />
        </div>
        <div className="row gap-8">
          <button className="btn btn-primary grow" onClick={() => m.mutate()} disabled={(changing && (pin.length < 4 || current.length < 4)) || m.isPending}>
            {changing ? 'Change passcode' : 'Save'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export default function Settings() {
  const { prefs, update } = usePrefs();
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [pinOpen, setPinOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'cache' | 'library' | 'progress' | 'metadata'>(null);
  const session = useQuery({ queryKey: ['session'], queryFn: api.session });
  const pc = useQuery({ queryKey: ['pcloud-status'], queryFn: api.pcloudStatus });
  const tp = useQuery({ queryKey: ['tpdb-status'], queryFn: () => api.tpdbStatus() });
  const tpTest = useMutation({ mutationFn: () => api.tpdbTest(), onError: (e) => toast((e as Error).message, 'error') });
  const tb = useQuery({ queryKey: ['torbox', 'status'], queryFn: api.torboxStatus });
  const q = useQuery({ queryKey: ['match-queue'], queryFn: api.matchQueue });
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices, enabled: caps.devices });

  useEffect(() => {
    const r = sp.get('pcloud');
    if (!r) return;
    if (r === 'connected') {
      toast('pCloud connected. Choose folders to index.', 'success');
      nav('/settings/pcloud', { replace: true });
    } else {
      toast(sp.get('message') || 'pCloud authorization failed', 'error');
      setSp({}, { replace: true });
    }
  }, []);

  const clear = useMutation({
    mutationFn: async (what: 'cache' | 'library' | 'progress' | 'metadata') => {
      if (what === 'cache') {
        if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
        localStorage.removeItem('pulse:tbprogress');
        localStorage.removeItem('pulse:prefs');
        qc.clear();
        return;
      }
      await api.clearData(what);
    },
    onSuccess: () => {
      toast('Done', 'success');
      qc.invalidateQueries();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const pcState = pc.data?.connected ? (pc.data.tokenInvalid ? 'err' : 'ok') : pc.data?.configured === false ? 'err' : 'warn';
  return (
    <main className="page">
      <header className="topbar">
        <h1 className="h1">Settings</h1>
      </header>

      <h2 className="overline group-title">Sources</h2>
      <div className="group">
        <Link to="/settings/pcloud" className="cell">
          <span className="ic cyan"><Cloud size={18} /></span>
          <span className="grow stack">
            <span className="lbl">pCloud</span>
            <span className="val clamp-1">{pc.isLoading ? 'Checking…' : pc.data?.connected ? `${pc.data.account?.email || 'Connected'} · ${pc.data.region}` : pc.data?.configured === false ? 'App keys missing on server' : 'Not connected'}</span>
          </span>
          <Dot s={pc.isLoading ? 'off' : pcState} />
          <ChevronRight size={18} className="chev" />
        </Link>
        <div className="cell">
          <span className="ic violet"><Database size={18} /></span>
          <span className="grow stack">
            <span className="lbl">ThePornDB</span>
            <span className="val">{tp.isLoading ? 'Checking…' : tp.data?.ok ? 'API key valid · metadata enabled' : tp.data?.configured ? tp.data.error || 'Key rejected' : 'API key missing on server'}</span>
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => tpTest.mutate()} disabled={tpTest.isPending}>{tpTest.isPending ? 'Testing…' : 'Test'}</button>
          <Dot s={tp.isLoading ? 'off' : tp.data?.ok ? 'ok' : 'err'} />
        </div>
        {tpTest.data && (
          <div className="cell" role="status" aria-live="polite">
            <span className="grow stack">
              <span className="lbl">{tpTest.data.ok ? 'ThePornDB works' : `ThePornDB problem: ${tpTest.data.status.replace('_', ' ')}`}</span>
              <span className="val" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{tpTest.data.hint}</span>
              {tpTest.data.path && <span className="val">Network path: {PATH_LABEL[tpTest.data.path]}</span>}
              {tpTest.data.sample && <span className="val">Sample “{tpTest.data.sample.query}” → {tpTest.data.sample.results} result(s){tpTest.data.sample.first ? `, first: ${tpTest.data.sample.first}` : ''}</span>}
              {tpTest.data.steps.map((st) => <span key={st.name} className="val">{st.name}: {st.httpStatus ?? 'no response'} {st.ok ? '✓' : `✗ ${st.detail}`}</span>)}
            </span>
          </div>
        )}
        <MetadataSources />
        <Link to="/settings/torbox" className="cell">
          <span className="ic brand"><Download size={18} /></span>
          <span className="grow stack">
            <span className="lbl">TorBox</span>
            <span className="val clamp-1">{tb.isLoading ? 'Checking…' : tb.data?.linked ? `${tb.data.account?.plan || 'Linked'}${tb.data.source === 'env' ? ' · server key' : ' · your key'}` : 'Not linked'}</span>
          </span>
          <Dot s={tb.isLoading ? 'off' : tb.data?.linked ? (tb.data.error ? 'err' : 'ok') : 'warn'} />
          <ChevronRight size={18} className="chev" />
        </Link>
      </div>

      <h2 className="overline group-title">Library</h2>
      <div className="group">
        <Link to="/settings/pcloud" className="cell">
          <span className="ic"><FolderOpen size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Folders & scanning</span>
            <span className="val">{pc.data ? `${pc.data.folders.length} folder${pc.data.folders.length === 1 ? '' : 's'} · last scan ${fmtRelative(pc.data.scan.finishedAt)}` : '—'}</span>
          </span>
          <ChevronRight size={18} className="chev" />
        </Link>
        <Link to="/library?tab=review" className="cell">
          <span className="ic"><Wand2 size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Unmatched videos</span>
            <span className="val">{q.data ? `${(q.data.counts.unmatched || 0) + (q.data.counts.pending || 0)} to review · ${q.data.counts.matched || 0} matched` : '—'}</span>
          </span>
          <ChevronRight size={18} className="chev" />
        </Link>
        <div className="cell">
          <span className="ic"><Database size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Match new files automatically</span>
            <span className="val">Uses ThePornDB in the background</span>
          </span>
          <Switch label="Auto-match" checked={prefs.autoMatch} onChange={(v) => update({ autoMatch: v })} />
        </div>
      </div>

      <h2 className="overline group-title">Playback</h2>
      <div className="group">
        <div className="cell">
          <span className="ic"><RotateCcw size={18} /></span>
          <span className="grow lbl">Resume where I left off</span>
          <Switch label="Resume playback" checked={prefs.resumePlayback} onChange={(v) => update({ resumePlayback: v })} />
        </div>
        <div className="cell">
          <span className="ic"><Play size={18} /></span>
          <span className="grow lbl">Autoplay next video</span>
          <Switch label="Autoplay next" checked={prefs.autoplayNext} onChange={(v) => update({ autoplayNext: v })} />
        </div>
        <div className="cell">
          <span className="ic"><Cloud size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Prefer original quality</span>
            <span className="val">Off uses pCloud’s transcoded stream (smaller, plays everywhere)</span>
          </span>
          <Switch label="Prefer original" checked={prefs.preferOriginal} onChange={(v) => update({ preferOriginal: v })} />
        </div>
        <div className="cell" style={{ flexWrap: 'wrap' }}>
          <span className="ic"><Gauge size={18} /></span>
          <span className="grow lbl">Default speed</span>
          <div style={{ width: '100%' }}>
            <Segmented label="Default speed" value={String(prefs.defaultSpeed)} onChange={(v) => update({ defaultSpeed: Number(v) })} options={['0.75', '1', '1.25', '1.5', '2'].map((x) => ({ value: x, label: `${x}×` }))} />
          </div>
        </div>
        <div className="cell" style={{ flexWrap: 'wrap' }}>
          <span className="ic"><RotateCcw size={18} /></span>
          <span className="grow lbl">Skip buttons</span>
          <div style={{ width: '100%' }}>
            <Segmented label="Skip seconds" value={String(prefs.skipSeconds)} onChange={(v) => update({ skipSeconds: Number(v) })} options={['5', '10', '15', '30'].map((x) => ({ value: x, label: `${x}s` }))} />
          </div>
        </div>
      </div>

      <h2 className="overline group-title">Privacy</h2>
      <div className="group">
        <button className="cell" onClick={() => setPinOpen(true)}>
          <span className="ic brand"><Lock size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Passcode lock</span>
            <span className="val">{session.data?.lockTimeoutMin ? `Always on · idle lock after ${session.data.lockTimeoutMin} min` : 'Always on · change passcode'}</span>
          </span>
          <ChevronRight size={18} className="chev" />
        </button>
        <button className="cell" onClick={() => api.lock().then(() => authEvents.dispatchEvent(new Event('locked')))}>
          <span className="ic"><Lock size={18} /></span>
          <span className="grow lbl">Lock now</span>
        </button>
        <div className="cell">
          <span className="ic"><EyeOff size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Blur thumbnails</span>
            <span className="val">Hide artwork until you open a video</span>
          </span>
          <Switch label="Blur thumbnails" checked={prefs.blurThumbs} onChange={(v) => update({ blurThumbs: v })} />
        </div>
        {caps.devices &&
          devices.data?.map((d) => (
            <div key={d.id} className="cell">
              <span className="ic"><Smartphone size={18} /></span>
              <span className="grow stack">
                <span className="lbl clamp-1">{/iPhone|iPad/.test(d.label) ? 'iPhone / iPad' : /Android/.test(d.label) ? 'Android' : /Mac/.test(d.label) ? 'Mac' : 'Browser'}{d.current ? ' · this device' : ''}</span>
                <span className="val">Active {fmtRelative(d.lastSeen)}</span>
              </span>
            </div>
          ))}
      </div>

      <h2 className="overline group-title">Appearance</h2>
      <div className="group">
        <div className="cell" style={{ flexWrap: 'wrap' }}>
          <span className="ic"><Moon size={18} /></span>
          <span className="grow lbl">Theme</span>
          <div style={{ width: '100%' }}>
            <Segmented label="Theme" value={prefs.theme} onChange={(v) => update({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
          </div>
        </div>
        <Link to="/favorites" className="cell">
          <span className="ic"><Heart size={18} /></span>
          <span className="grow lbl">Favorites{caps.watchlist ? ' & watchlist' : ''}</span>
          <ChevronRight size={18} className="chev" />
        </Link>
      </div>

      <h2 className="overline group-title">Data</h2>
      <div className="group">
        <button className="cell" onClick={() => setConfirm('cache')}>
          <span className="ic"><Trash2 size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Clear this device’s cache</span>
            <span className="val">Offline files and local settings. Your library stays.</span>
          </span>
        </button>
        {caps.clearServerData && (
          <>
            <button className="cell" onClick={() => setConfirm('progress')}>
              <span className="ic"><RotateCcw size={18} /></span>
              <span className="grow lbl">Clear watch history</span>
            </button>
            <button className="cell" onClick={() => setConfirm('metadata')}>
              <span className="ic"><Wand2 size={18} /></span>
              <span className="grow lbl">Reset all metadata matches</span>
            </button>
          </>
        )}
        <button className="cell" onClick={() => setConfirm('library')}>
          <span className="ic brand"><Trash2 size={18} /></span>
          <span className="grow stack">
            <span className="lbl" style={{ color: 'var(--danger)' }}>Remove library & disconnect pCloud</span>
            <span className="val">Files in pCloud are never touched</span>
          </span>
        </button>
      </div>

      <h2 className="overline group-title">About</h2>
      <div className="group">
        <div className="cell">
          <span className="ic"><Info size={18} /></span>
          <span className="grow stack">
            <span className="lbl">Pulse 1.0</span>
            <span className="val">{isMock ? 'Demo data mode (open with ?mock=0 to use the server)' : 'Connected to your Pulse server'}</span>
          </span>
        </div>
      </div>

      {pinOpen && <PinSheet timeout={session.data?.lockTimeoutMin ?? 0} onClose={() => setPinOpen(false)} />}
      {confirm && (
        <Modal
          title={confirm === 'cache' ? 'Clear device cache?' : confirm === 'library' ? 'Remove the library?' : confirm === 'progress' ? 'Clear watch history?' : 'Reset metadata?'}
          icon={<Trash2 size={20} />}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  clear.mutate(confirm);
                  setConfirm(null);
                }}
              >
                {confirm === 'library' ? 'Remove' : 'Clear'}
              </button>
            </>
          }
        >
          {confirm === 'library'
            ? 'This disconnects pCloud and deletes the index, matches and history from the Pulse server. Your videos in pCloud are not deleted.'
            : confirm === 'cache'
              ? 'This removes offline data and local preferences on this device only.'
              : 'This can’t be undone.'}
        </Modal>
      )}
    </main>
  );
}
