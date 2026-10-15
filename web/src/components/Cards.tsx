import { useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Play, Heart, Bookmark } from 'lucide-react';
import type { Item, PerformerRef } from '../api';
import { Cover } from './Art';
import { cx, fmtDuration, hash, initials } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';
import { useTilt } from '../motion/hooks';
import { rememberPoster } from '../motion/transition';
import { haptic } from '../motion/gsap';

export function itemSub(it: Item) {
  const parts = [it.scene?.site?.name, it.scene?.date?.slice(0, 4)].filter(Boolean);
  if (!parts.length) parts.push(it.matchStatus === 'unmatched' ? 'Unmatched' : it.matchStatus === 'pending' ? 'Matching…' : 'pCloud');
  return parts.join(' · ');
}

export function itemPoster(it: Item) {
  return it.scene?.poster || it.scene?.background || (it.thumb ? it.thumb : null);
}

export function SceneCard({ item, wide, queue }: { item: Item; wide?: boolean; queue?: Item[] }) {
  const { prefs } = usePrefs();
  const player = usePlayer();
  const pct = item.progress && item.progress.duration ? Math.min(100, (item.progress.position / item.progress.duration) * 100) : 0;
  const img = wide ? item.scene?.background || item.scene?.poster || item.thumb || null : itemPoster(item);
  const ref = useRef<HTMLAnchorElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  useTilt(artRef, { max: 8, scale: 1.04 });
  const fresh = Date.now() - (item.addedAt || 0) < 7 * 864e5 && item.matchStatus !== 'unmatched';
  return (
    <Link ref={ref} to={`/scene/${item.id}`} onClick={() => rememberPoster(ref.current)} className={cx('card poster-card', wide && 'wide', prefs.blurThumbs && 'blur')} aria-label={`${item.title}, ${itemSub(item)}`}>
      <div className="art" ref={artRef}>
        <Cover src={img} alt="" seed={item.id} label={!item.scene ? item.name : undefined} />
        <span className="glare" aria-hidden />
        <div className="scrim">
          <span className="title clamp-2">{item.title}</span>
          <span className="sub clamp-1">{item.path?.startsWith('/TorBox') ? 'Download · ' : ''}{item.duration ? fmtDuration(item.duration) : itemSub(item)}</span>
        </div>
        <div className="corner">
          {fresh && <span className="badge new">New</span>}
          {item.resolution && /2160|4k/i.test(item.resolution) && <span className="badge brand">4K</span>}
          {item.matchStatus === 'unmatched' && <span className="badge warn">Unmatched</span>}
        </div>
        {(item.favorite || item.watchlist) && (
          <span className="corner-r">{item.favorite ? <Heart size={16} fill="var(--brand-bright)" color="var(--brand-bright)" /> : <Bookmark size={16} fill="#fff" color="#fff" />}</span>
        )}
        {pct > 0 && (
          <span className="bar">
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
        <span
          className="play-fab"
          role="button"
          aria-label={`Play ${item.title}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            haptic(10);
            player.play(itemSource(item, queue));
          }}
        >
          <Play size={16} fill="currentColor" />
        </span>
      </div>
    </Link>
  );
}

export function ContinueCard({ item }: { item: Item }) {
  const { prefs } = usePrefs();
  const player = usePlayer();
  const pct = item.progress?.duration ? Math.min(100, (item.progress.position / item.progress.duration) * 100) : 0;
  const left = item.progress?.duration ? fmtDuration(item.progress.duration - item.progress.position) : null;
  const C = 2 * Math.PI * 26;
  return (
    <button className={cx('cw-card', prefs.blurThumbs && 'blur')} onClick={() => player.play(itemSource(item))} aria-label={`Resume ${item.title}`} style={{ textAlign: 'left' }}>
      <div className="art">
        <Cover src={item.scene?.background || item.scene?.poster || item.thumb || null} alt="" seed={item.id} className="blurable" />
        <div className="overlay">
          <span className="ring" aria-hidden>
            <svg viewBox="0 0 60 60">
              <circle cx="30" cy="30" r="26" className="trk" />
              <circle cx="30" cy="30" r="26" className="val" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} />
            </svg>
            <Play size={16} fill="currentColor" />
          </span>
          <span className="pc mono">{Math.round(pct)}%</span>
        </div>
      </div>
      <div className="stack" style={{ padding: '0 2px', gap: 2 }}>
        <span className="clamp-1 cw-t">{item.title}</span>
        <span className="cw-s">{left ? `${left} remaining` : itemSub(item)}</span>
      </div>
    </button>
  );
}

const MOODS = [
  ['#7c4dff', '#2a1458'],
  ['#c04fd8', '#3a1450'],
  ['#4f7cff', '#162358'],
  ['#9a6bff', '#241049'],
  ['#d05cae', '#40143a'],
  ['#5fb0ff', '#10304f'],
];

/** Category card: glass tile with a glowing initial, used for tags. */
export function CatCard({ tag, index }: { tag: { id: number; name: string; c?: number }; index: number }) {
  const nav = useNavigate();
  const [a, b] = MOODS[(hash(String(tag.id)) + index) % MOODS.length];
  return (
    <button className="cat-card" style={{ ['--a' as string]: a, ['--b' as string]: b }} onClick={() => nav(`/library?tags=${tag.id}`)}>
      <span className="ci" aria-hidden>{tag.name.slice(0, 1)}</span>
      <span className="cn clamp-2">{tag.name}</span>
      {tag.c != null && <span className="cc">{tag.c} {tag.c === 1 ? 'video' : 'videos'}</span>}
    </button>
  );
}

export function PersonCard({ p, count }: { p: PerformerRef; count?: number }) {
  const { prefs } = usePrefs();
  return (
    <Link to={`/performer/${p.id}`} className={cx('person', prefs.blurThumbs && 'blur')}>
      <span className="halo"><span className="ph">
        {p.image ? <Cover src={p.image} alt="" seed={p.id} className="blurable" /> : <span className="avatar" style={{ width: '100%', height: '100%', fontSize: 22 }}>{initials(p.name)}</span>}
      </span></span>
      <span className="cast-meta">
        <span className="nm clamp-2">{p.name}</span>
        {count != null && <span className="ct">{count} {count === 1 ? 'scene' : 'scenes'}</span>}
      </span>
    </Link>
  );
}

export function RowItem({ item, onClick, right, active, below, sub }: { item: Item; onClick?: () => void; right?: React.ReactNode; active?: boolean; below?: React.ReactNode; sub?: React.ReactNode }) {
  const nav = useNavigate();
  const { prefs } = usePrefs();
  return (
    <button className={cx('row-item', active && 'active', prefs.blurThumbs && 'blur')} onClick={onClick || (() => nav(`/scene/${item.id}`))}>
      <span className="thumb wide">
        <Cover src={item.scene?.background || item.scene?.poster || item.thumb || null} alt="" seed={item.id} className="blurable" />
      </span>
      <span className="grow stack" style={{ minWidth: 0 }}>
        <span className="t clamp-1">{item.title}</span>
        <span className="s clamp-1">{sub ?? (item.scene ? itemSub(item) : item.path || item.name)}</span>
        {below && <span className="below">{below}</span>}
      </span>
      {right ?? <span className="r">{fmtDuration(item.duration) || ''}</span>}
    </button>
  );
}
