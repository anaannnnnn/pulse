import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Key, Unlink, Server } from 'lucide-react';
import { api } from '../api';
import { ErrorState, Skeleton } from '../components/ui';
import { useToast } from '../components/Toast';
import { fmtDate } from '../lib/format';

export default function TorboxSettings() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const st = useQuery({ queryKey: ['torbox', 'status'], queryFn: api.torboxStatus });
  const done = (msg: string) => {
    qc.invalidateQueries({ queryKey: ['torbox'] });
    toast(msg, 'success');
  };
  const link = useMutation({ mutationFn: () => api.torboxLink(key.trim()), onSuccess: () => { setKey(''); done('TorBox linked'); }, onError: (e) => toast((e as Error).message, 'error') });
  const unlink = useMutation({ mutationFn: (useDefault: boolean) => api.torboxUnlink(useDefault), onSuccess: (_d, u) => done(u ? 'Using the server’s TorBox account' : 'TorBox unlinked'), onError: (e) => toast((e as Error).message, 'error') });
  const d = st.data;
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => nav('/settings')} aria-label="Back"><ArrowLeft size={20} /></button>
        <h1 className="h2 grow">TorBox</h1>
      </header>
      {st.isLoading && <Skeleton h={160} r={24} />}
      {st.isError && <ErrorState error={st.error} onRetry={() => st.refetch()} />}
      {d && (
        <div className="stack gap-16">
          <div className="panel stack gap-12">
            <div className="row gap-12">
              <span className="ic" style={{ width: 44, height: 44, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'var(--brand-soft)', color: 'var(--text-accent)' }}><Download size={20} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="h4 clamp-1" style={{ fontSize: 16 }}>{d.linked ? d.account?.email || 'Linked' : 'Not linked'}</div>
                <div className="caption">{d.linked ? (d.source === 'env' ? 'Using the server’s default key' : 'Using your own API key') : 'Paste an API key to link an account'}</div>
              </div>
              {d.linked && <span className={`badge ${d.error ? 'warn' : 'ok'}`}>{d.error ? 'Error' : 'Active'}</span>}
            </div>
            {d.account && (
              <dl className="kv">
                <dt>Plan</dt>
                <dd>{d.account.plan}</dd>
                {d.account.premiumExpiresAt && (
                  <>
                    <dt>Renews</dt>
                    <dd>{fmtDate(d.account.premiumExpiresAt)}</dd>
                  </>
                )}
              </dl>
            )}
            {d.error && <p className="error-text" style={{ margin: 0 }}>{d.error}</p>}
          </div>

          <div className="panel stack gap-12">
            <div className="overline">{d.linked ? 'Switch account' : 'Link account'}</div>
            <div className="field">
              <label htmlFor="tbkey">TorBox API key</label>
              <input id="tbkey" className="input mono" autoComplete="off" spellCheck={false} placeholder="Find it at torbox.app → Settings → API" value={key} onChange={(e) => setKey(e.target.value)} />
              <span className="hint">The key is checked with TorBox, then stored encrypted on your Pulse server only.</span>
            </div>
            <button className="btn btn-primary" disabled={key.trim().length < 10 || link.isPending} onClick={() => link.mutate()}>
              <Key size={16} /> {link.isPending ? 'Checking…' : 'Link TorBox'}
            </button>
          </div>

          <div className="row gap-8 wrap">
            {d.source !== 'env' && d.envAvailable && (
              <button className="btn btn-secondary" onClick={() => unlink.mutate(true)}><Server size={16} /> Use server account</button>
            )}
            {d.linked && (
              <button className="btn btn-danger" onClick={() => unlink.mutate(false)}><Unlink size={16} /> Unlink</button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
