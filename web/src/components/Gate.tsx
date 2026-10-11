import { useEffect, useState } from 'react';
import { Delete, Lock } from 'lucide-react';
import { api } from '../api';

export function LockScreen({ onUnlocked }: { onUnlocked: () => void | Promise<void> }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const submit = async (p: string) => {
    setBusy(true);
    try {
      await api.unlock(p);
      await onUnlocked();
    } catch (e) {
      setErr((e as Error).message || 'Wrong passcode');
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => {
    if (busy) return;
    setErr(null);
    setPin((p) => (p.length >= 8 ? p : p + d));
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter' && pin.length >= 4) submit(pin);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  return (
    <main className="gate" aria-label="Pulse is locked">
      <div className="aurora" aria-hidden><i /><i /><i /></div>
      <img className="logo" src="/icons/icon-192.png" alt="" />
      <div className="stack gap-4">
        <h1 className="h2 row gap-8" style={{ justifyContent: 'center' }}><Lock size={20} /> Pulse is locked</h1>
        <p className="muted body-s" style={{ margin: 0 }}>Enter your passcode</p>
      </div>
      <div className={`pin-dots ${shake ? 'shake' : ''}`} role="status" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      <p className="error-text" style={{ minHeight: 20, margin: 0 }} aria-live="assertive">{err}</p>
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} aria-label={d}>{d}</button>
        ))}
        <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete digit"><Delete size={22} style={{ margin: 'auto' }} /></button>
        <button onClick={() => press('0')} aria-label="0">0</button>
        <button onClick={() => submit(pin)} disabled={pin.length < 4 || busy} aria-label="Unlock" style={{ fontSize: 14, fontFamily: 'var(--font-sans)', fontWeight: 600 }}>OK</button>
      </div>
    </main>
  );
}
