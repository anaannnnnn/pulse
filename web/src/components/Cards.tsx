import { Link, useNavigate } from 'react-router-dom';
import { Play, Heart, Bookmark } from 'lucide-react';
import type { Item, PerformerRef } from '../api';
import { Cover } from './Art';
import { cx, fmtDuration, initials } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';

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
  return (
    <Link to={`/scene/${item.id}`} className={cx('card poster-card', wide && 'wide', prefs.blurThumbs && 'blur')} aria-label={`${item.title}, ${itemSub(item)}`}>
      <div className="art">
        <Cover src={img} alt="" seed={item.id} label={!item.scene ? item.name : undefined} />
        <div className="scrim">
          <span className="title clamp-2">{item.title}</span>
          <span className="sub clamp-1">{item.path?.startsWith('/TorBox') ? 'Download · ' : ''}{item.duration ? fmtDuration(item.duration) : itemSub(item)}</span>
        </div>
        <div className="corner">
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
  const pct = item.progress?.duration ? (item.progress.position / item.progress.duration) * 100 : 0;
  const left = item.progress?.duration ? fmtDuration(item.progress.duration - item.progress.position) : null;
  return (
    <button className={cx('cw-card', prefs.blurThumbs && 'blur')} onClick={() => player.play(itemSource(item))} aria-label={`Resume ${item.title}`} style={{ textAlign: 'left' }}>
      <div className="art">
        <Cover src={item.scene?.background || item.scene?.poster || item.thumb || null} alt="" seed={item.id} className="blurable" />
        <div className="overlay">
          <span className="play">
            <Play size={14} fill="currentColor" />
          </span>
          <span className="progress">
            <i style={{ width: `${pct}%` }} />
          </span>
        </div>
      </div>
      <div className="stack" style={{ padding: '0 2px' }}>
        <span className="clamp-1" style={{ fontWeight: 600, fontSize: 14 }}>
          {item.title}
        </span>
        <span className="caption">{left ? `${left} left` : itemSub(item)}</span>
      </div>
    </button>
  );
}

export function PersonCard({ p, count }: { p: PerformerRef; count?: number }) {
  const { prefs } = usePrefs();
  return (
    <Link to={`/performer/${p.id}`} className={cx('person', prefs.blurThumbs && 'blur')}>
      <span className="ph">
        {p.image ? <Cover src={p.image} alt="" seed={p.id} className="blurable" /> : <span className="avatar" style={{ width: '100%', height: '100%', fontSize: 22 }}>{initials(p.name)}</span>}
        <span className="cast-meta">
          <span className="nm clamp-2">{p.name}</span>
          {count != null && <span className="ct">{count} {count === 1 ? 'scene' : 'scenes'}</span>}
        </span>
      </span>
    </Link>
  );
}

export function RowItem({ item, onClick, right, active }: { item: Item; onClick?: () => void; right?: React.ReactNode; active?: boolean }) {
  const nav = useNavigate();
  const { prefs } = usePrefs();
  return (
    <button className={cx('row-item', active && 'active', prefs.blurThumbs && 'blur')} onClick={onClick || (() => nav(`/scene/${item.id}`))}>
      <span className="thumb wide">
        <Cover src={item.scene?.background || item.scene?.poster || item.thumb || null} alt="" seed={item.id} className="blurable" />
      </span>
      <span className="grow stack" style={{ minWidth: 0 }}>
        <span className="t clamp-1">{item.title}</span>
        <span className="s clamp-1">{item.scene ? itemSub(item) : item.path || item.name}</span>
      </span>
      {right ?? <span className="r">{fmtDuration(item.duration) || ''}</span>}
    </button>
  );
}
