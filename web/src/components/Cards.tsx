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

/** Ranked "Top ten" card: an oversized outlined numeral tucked behind the poster. */
export function RankCard({ item, rank }: { item: Item; rank: number }) {
  const { prefs } = usePrefs();
  const ref = useRef<HTMLAnchorElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  useTilt(artRef, { max: 7, scale: 1.04 });
  return (
    <Link ref={ref} to={`/scene/${item.id}`} onClick={() => rememberPoster(ref.current)} className={cx('rank-card', prefs.blurThumbs && 'blur')} aria-label={`Number ${rank}: ${item.title}`}>
      <span className={cx("no", rank >= 10 && "two")} aria-hidden>{rank}</span>
      <div className="art" ref={artRef}>
        <Cover src={itemPoster(item)} alt="" seed={item.id} label={!item.scene ? item.name : undefined} />
        <span className="glare" aria-hidden />
      </div>
    </Link>
  );
}

const MOODS = [
  ['#5a1426', '#14060a'],
  ['#0f3a35', '#05100f'],
  ['#2b2150', '#0a0716'],
  ['#5a3a12', '#140c04'],
  ['#4a1a3c', '#12060e'],
  ['#1c2d4d', '#070b14'],
];

/** Bento browse grid: wide / tall / small tiles that always tile into a clean rectangle. */
export function Bento({ tags }: { tags: { id: number; name: string; c?: number }[] }) {
  const nav = useNavigate();
  const SHAPES = ['w', 't', 's', 's', 'w', 's', 's', 'w'];
  const area = (s: string) => (s === 's' ? 1 : 2);
  let k = 0, sum = 0;
  for (let n = 1; n <= Math.min(tags.length, SHAPES.length); n++) {
    sum += area(SHAPES[n - 1]);
    if (sum % 2 === 0) k = n;
  }
  const list = tags.slice(0, k);
  return (
    <div className="bento">
      {list.map((t, n) => {
        const [a, b] = MOODS[(hash(String(t.id)) + n) % MOODS.length];
        return (
          <button key={t.id} className={cx('tile', SHAPES[n])} style={{ ['--a' as string]: a, ['--b' as string]: b }} onClick={() => nav(`/library?tags=${t.id}`)}>
            <span className="tn mono">{String(n + 1).padStart(2, '0')}</span>
            <span className="tt clamp-2">{t.name}</span>
            {t.c != null && <span className="tc mono">{t.c} {t.c === 1 ? 'film' : 'films'}</span>}
          </button>
        );
      })}
    </div>
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
