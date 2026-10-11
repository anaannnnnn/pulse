import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Horizontal snap rail (Netflix-style row). Native touch scrolling and momentum are untouched;
 * on pointer devices it adds prev/next buttons and edge fades that appear only when there is more to scroll.
 */
export function Rail({ children, col, label }: { children: ReactNode; col?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);
  const go = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * Math.round((ref.current?.clientWidth ?? 320) * 0.86), behavior: 'smooth' });
  const style = col ? ({ ['--col' as string]: col } as CSSProperties) : undefined;
  return (
    <div className="rail-wrap" data-start={edge.start || undefined} data-end={edge.end || undefined}>
      <div className="rail" ref={ref} style={style} aria-label={label}>
        {children}
      </div>
      <button type="button" className="rail-btn prev" aria-label="Scroll back" tabIndex={-1} onClick={() => go(-1)} hidden={edge.start}>
        <ChevronLeft size={22} />
      </button>
      <button type="button" className="rail-btn next" aria-label="Scroll forward" tabIndex={-1} onClick={() => go(1)} hidden={edge.end}>
        <ChevronRight size={22} />
      </button>
    </div>
  );
}
