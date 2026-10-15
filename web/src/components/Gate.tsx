import { useCallback, useEffect, useRef, useState } from 'react';
import { Delete } from 'lucide-react';
import { api } from '../api';
import { cx } from '../lib/format';
import { AuroraCanvas } from '../fx/AuroraCanvas';
import { gsap, reduced } from '../motion/gsap';
import { setAmbient } from '../motion/ambient';

const LETTERS: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ' };
const buzz = (ms: number | number[]) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

/**
 * Passcode lock. When the server tells us how many digits the PIN has, the code is submitted the moment the last digit is
 * typed (no OK button). Wrong code: shake + haptic + tries left. Rate limited: the keypad sleeps with a live countdown.
 */
export function LockScreen({ onUnlocked, pinLength }: { onUnlocked: () => void | Promise<void>; pinLength?: number | null }) {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [shake, setShake] = useState(false);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [hit, setHit] = useState<string | null>(null);
  const len = pinLength && pinLength >= 4 && pinLength <= 8 ? pinLength : null;
  const max = len ?? 8;
  const cooling = waitUntil > now;
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    if (!cooling) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [cooling]);

  const submit = useCallback(
    async (p: string) => {
      if (busy || p.length < 4) return;
      setBusy(true);
      setMsg(null);
      try {
        await api.unlock(p);
        setOk(true);
        buzz(12);
        await new Promise((r) => setTimeout(r, 160));
        await onUnlocked();
      } catch (e) {
        const text = (e as Error).message || 'Wrong passcode';
        const secs = Number(text.match(/(\d+)\s*second/)?.[1] ?? 0) || Number(text.match(/(\d+)\s*minute/)?.[1] ?? 0) * 60;
        if (/too many/i.test(text) && secs) setWaitUntil(Date.now() + secs * 1000);
        setNow(Date.now());
        setOk(false);
        setMsg(text);
        setShake(true);
        buzz([40, 50, 40]);
        setTimeout(() => setShake(false), 450);
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [busy, onUnlocked],
  );

  const press = useCallback(
    (d: string) => {
      if (busy || cooling || ok) return;
      setHit(d);
      setTimeout(() => setHit((h) => (h === d ? null : h)), 120);
      const next = (pinRef.current + d).slice(0, max);
      if (next === pinRef.current) return;
      setMsg(null);
      setPin(next);
      buzz(6);
      if (len && next.length === len) void submit(next);
    },
    [busy, cooling, ok, max, len, submit],
  );
  const back = useCallback(() => {
    if (busy || ok) return;
    setPin((p) => p.slice(0, -1));
  }, [busy, ok]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
      else if (e.key === 'Enter') void submit(pinRef.current);
    };
    const paste = (e: ClipboardEvent) => {
      const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, max);
      if (!digits) return;
      e.preventDefault();
      setPin(digits);
      if ((len && digits.length === len) || (!len && digits.length >= 4)) void submit(digits);
    };
    window.addEventListener('keydown', k);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('keydown', k);
      window.removeEventListener('paste', paste);
    };
  }, [press, back, submit, max, len]);

  const gateRef = useRef<HTMLElement>(null);
  // entrance: logo pops with pulse rings, copy and keys cascade in
  useEffect(() => {
    void setAmbient(null, 'pulse-lock');
    const g = gateRef.current;
    if (!g || reduced()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from('.lock-card .brand-mark', { scale: 0.3, rotate: -40, opacity: 0, duration: 1.1, ease: 'back.out(2)' })
        .from('.lock-card h1, .lock-card .body-s', { y: 22, opacity: 0, duration: 0.8, stagger: 0.08 }, 0.2)
        .from('.keypad button', { y: 36, opacity: 0, duration: 0.7, stagger: 0.035, clearProps: 'transform,opacity' }, 0.4);
      gsap.to('.lock-card .brand-mark', { y: -4, duration: 2.4, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    }, g);
    return () => ctx.revert();
  }, []);

  const dots = len ?? Math.max(4, pin.length);
  const left = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  return (
    <main className="gate" aria-label="Pulse is locked" ref={gateRef}>
      <AuroraCanvas className="gate-aurora" intensity={1.05} scale={0.55} />
      <div className="aurora" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <div className="lock-card">
        <span className="brand-mark" aria-hidden />
        <div className="stack gap-8">
          <h1>Welcome back</h1>
          <p className="body-s">{cooling ? 'Too many tries. Take a breath.' : len ? `Enter your ${len}-digit passcode` : 'Enter your passcode'}</p>
        </div>
        <div className={cx('pin-dots', shake && 'shake', busy && 'busy', ok && 'ok')} role="status" aria-live="polite" aria-label={`${pin.length} of ${len ?? 'up to 8'} digits entered`}>
          {Array.from({ length: dots }, (_, i) => (
            <i key={i} className={i < pin.length ? 'on' : ''} />
          ))}
        </div>
        <p className="lock-msg" aria-live="assertive">
          {cooling ? `Try again in ${left < 90 ? `${left}s` : `${Math.ceil(left / 60)} min`}` : msg}
        </p>
        <div className="keypad" aria-label="Keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" className={cx(hit === d && 'hit')} onClick={() => press(d)} disabled={cooling} aria-label={d}>
              {d}
              <small aria-hidden>{LETTERS[d] || ' '}</small>
            </button>
          ))}
          {len ? (
            <span aria-hidden />
          ) : (
            <button type="button" className="flat" onClick={() => void submit(pin)} disabled={pin.length < 4 || busy || cooling} aria-label="Unlock">
              OK
            </button>
          )}
          <button type="button" className={cx(hit === '0' && 'hit')} onClick={() => press('0')} disabled={cooling} aria-label="0">
            0<small aria-hidden>{' '}</small>
          </button>
          <button type="button" className="flat" onClick={back} disabled={!pin.length || busy} aria-label="Delete digit">
            <Delete size={24} />
          </button>
        </div>
        <p className="lock-foot">Locked by your Pulse server. Every device needs the passcode.</p>
      </div>
    </main>
  );
}
