import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, AlertTriangle, Sparkles, RotateCw } from 'lucide-react';
import { cx } from '../lib/format';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!checked)} />;
}

export function Chip({ on, children, onClick, small, count }: { on?: boolean; children: ReactNode; onClick?: () => void; small?: boolean; count?: number }) {
  return (
    <button type="button" className={cx('chip', on && 'on', small && 'sm')} aria-pressed={!!on} onClick={onClick}>
      {children}
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}

export function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ x: 4, w: 0 });
  useLayoutEffect(() => {
    const root = ref.current;
    const el = root?.querySelector('button.on') as HTMLElement | null;
    if (!root || !el) return;
    setBox({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, options.length]);
  return (
    <div className="segmented" role="radiogroup" aria-label={label} ref={ref}>
      <span className="seg-indicator" style={{ transform: `translateX(${box.x}px)`, width: box.w || undefined, opacity: box.w ? 1 : 0 }} />
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="search">
      <Search size={18} color="var(--icon-muted)" aria-hidden />
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} aria-label={placeholder} enterKeyHint="search" />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="icon-btn sm ghost">
          <X size={16} />
        </button>
      )}
    </label>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
}

/** Bottom sheet (Pulse "Drawer"). */
export function Sheet({ title, onClose, children, footer, label }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; label?: string }) {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  const dragY = useRef(0);
  const origin = useRef(0);
  const dragging = useRef(false);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const onGrabDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    origin.current = e.clientY;
    dragY.current = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGrabMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !ref.current) return;
    const dy = Math.max(0, e.clientY - origin.current);
    dragY.current = dy;
    ref.current.style.transform = `translateY(${dy}px)`;
  };
  const onGrabUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (dragY.current > 96) {
      onClose();
      return;
    }
    if (ref.current) {
      ref.current.style.transition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)';
      ref.current.style.transform = '';
      window.setTimeout(() => {
        if (ref.current) ref.current.style.transition = '';
      }, 300);
    }
  };
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label || (typeof title === 'string' ? title : 'Sheet')} ref={ref} tabIndex={-1}>
        <div className="grab" onPointerDown={onGrabDown} onPointerMove={onGrabMove} onPointerUp={onGrabUp} onPointerCancel={onGrabUp} />
        <header>
          <h2 className="h3">{title}</h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </>,
    document.body,
  );
}

export function Modal({ title, children, onClose, icon, actions }: { title: string; children: ReactNode; onClose: () => void; icon?: ReactNode; actions: ReactNode }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="icon-tile">{icon || <Sparkles size={20} />}</div>
        <h2 className="h3" style={{ marginBottom: 8 }}>
          {title}
        </h2>
        <div className="muted body-s">{children}</div>
        <div className="row gap-8 mt-24" style={{ justifyContent: 'flex-end' }}>
          {actions}
        </div>
      </div>
    </>,
    document.body,
  );
}

export const Skeleton = ({ w, h, r, style }: { w?: number | string; h?: number | string; r?: number; style?: React.CSSProperties }) => (
  <div className="sk" style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden />
);

export function CardSkeletons({ n = 6, rail }: { n?: number; rail?: boolean }) {
  return (
    <div className={rail ? 'rail' : 'grid'} aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card" style={{ pointerEvents: 'none' }}>
          <div className="sk" style={{ aspectRatio: '2/3' }} />
          <div className="stack gap-8" style={{ padding: '0 4px' }}>
            <div className="sk sk-line" style={{ width: '85%' }} />
            <div className="sk sk-line" style={{ width: '55%', height: 10 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RowSkeletons({ n = 5 }: { n?: number }) {
  return (
    <div className="stack gap-4" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="row-item">
          <div className="sk" style={{ width: 56, height: 56, borderRadius: 8 }} />
          <div className="grow stack gap-8">
            <div className="sk sk-line" style={{ width: '70%' }} />
            <div className="sk sk-line" style={{ width: '40%', height: 10 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <div className="orb">{icon || <Sparkles size={28} />}</div>
      <h3 className="h4">{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="state err" role="alert">
      <div className="orb">
        <AlertTriangle size={28} />
      </div>
      <h3 className="h4">Couldn’t load this</h3>
      <p>{msg}</p>
      {onRetry && (
        <button className="btn btn-secondary btn-sm" onClick={onRetry}>
          <RotateCw size={14} /> Try again
        </button>
      )}
    </div>
  );
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  return (
    <span className="confidence" title="Match confidence">
      <span className="meter">
        <i style={{ width: `${pct}%` }} />
      </span>
      {pct}% match
    </span>
  );
}

export function SectionHead({ title, action, kicker }: { title: string; action?: ReactNode; kicker?: string }) {
  return (
    <div className="section-head">
      <div className="sh-t">
        {kicker && <span className="sh-k">{kicker}</span>}
        <h2 className="h3 clamp-1">{title}</h2>
      </div>
      {action}
    </div>
  );
}
