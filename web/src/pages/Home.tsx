import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Info, Search, CloudCog, ChevronRight, Settings2 } from 'lucide-react';
import { api, isMock, type Item } from '../api';
import { SceneCard, ContinueCard, PersonCard } from '../components/Cards';
import { SearchOverlay } from '../components/SearchOverlay';
import { Rail } from '../components/Rail';
import { useReveal } from '../lib/useReveal';
import { Cover } from '../components/Art';
import { CardSkeletons, Chip, EmptyState, ErrorState, SectionHead, Skeleton } from '../components/ui';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';
import { cx, fmtDuration, fmtDate } from '../lib/format';
import { usePrefs } from '../lib/prefs';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const FEATURE_MS = 7000;

function Hero({ items }: { items: Item[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const held = paused || hover || reduce;
  const player = usePlayer();
  const nav = useNavigate();
  const { prefs } = usePrefs();
  const origin = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (items.length < 2 || held) return;
    setEpoch((e) => e + 1);
    const t = setInterval(() => setI((x) => (x + 1) % items.length), FEATURE_MS);
    return () => clearInterval(t);
  }, [items.length, held]);
  const it = items[i];
  if (!it) return null;
  const step = (dir: number) => setI((x) => (x + dir + items.length) % items.length);
  return (
    <section
      className={cx('hero', prefs.blurThumbs && 'blur')}
      style={{ ['--feat-ms' as string]: `${FEATURE_MS}ms` }}
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHover(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') step(1);
        if (e.key === 'ArrowLeft') step(-1);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        setPaused(true);
        origin.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const o = origin.current;
        origin.current = null;
        if (o && Math.abs(e.clientX - o.x) > 48 && Math.abs(e.clientX - o.x) > Math.abs(e.clientY - o.y)) step(e.clientX < o.x ? 1 : -1);
        window.setTimeout(() => setPaused(false), 2800);
      }}
      onPointerCancel={() => {
        origin.current = null;
        setPaused(false);
      }}
    >
      <div className="hero-media">
        <div className="hero-parallax" key={it.id}>
          <Cover src={it.scene?.background || it.scene?.poster} alt="" seed={it.id} eager />
        </div>
      </div>
      <div className="aurora" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <div className="hero-grain" aria-hidden />
      <div className="content">
        <div className="hero-progress" role="tablist" aria-label="Featured titles">
          {items.map((x, n) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={n === i}
              aria-label={`Show featured ${n + 1} of ${items.length}`}
              className={cx(n < i && 'done', n === i && 'on', n === i && held && 'held')}
              onClick={() => {
                setI(n);
                setPaused(true);
                window.setTimeout(() => setPaused(false), 2800);
              }}
            >
              <i key={n === i ? epoch : 0} />
            </button>
          ))}
        </div>
        <span className="hero-eyebrow">
          <b className="live-dot" aria-hidden />
          Featured
          <span className="sep" aria-hidden />
          {it.scene?.site?.name || 'Your library'}
        </span>
        <h2 className="title clamp-3" key={`t-${it.id}`}>
          {it.title}
        </h2>
        <div className="hero-meta" key={`m-${it.id}`}>
          {it.scene?.performers.slice(0, 2).map((p) => p.name).join(' & ') && <span>{it.scene?.performers.slice(0, 2).map((p) => p.name).join(' & ')}</span>}
          {it.scene?.date && <span>{fmtDate(it.scene?.date)}</span>}
          {it.duration ? <span>{fmtDuration(it.duration)}</span> : null}
          {it.resolution && /2160|4k/i.test(it.resolution) ? <span className="pill-4k">4K</span> : null}
        </div>
        <div className="actions hero-actions">
          <button className="btn btn-primary btn-lg" onClick={() => player.play(itemSource(it, items))}>
            <Play size={18} fill="currentColor" /> {it.progress && !it.progress.completed ? 'Resume' : 'Play'}
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => nav(`/scene/${it.id}`)}>
            <Info size={18} /> Details
          </button>
          <span className="hero-count" aria-hidden>
            {String(i + 1).padStart(2, '0')}<em>/{String(items.length).padStart(2, '0')}</em>
          </span>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const q = useQuery({ queryKey: ['home'], queryFn: api.home });
  const client = useQueryClient();
  const nav = useNavigate();
  const [search, setSearch] = useState(false);
  const d = q.data;
  useReveal();
  useEffect(() => {
    const on = () => q.refetch();
    window.addEventListener('pulse-refresh', on);
    return () => window.removeEventListener('pulse-refresh', on);
  }, [q]);
  useEffect(() => {
    if (isMock) return;
    let live = true;
    api.torboxImport().then((r) => {
      if (live && r.added) {
        client.invalidateQueries({ queryKey: ['home'] });
        client.invalidateQueries({ queryKey: ['items'] });
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [client]);
  return (
    <main className="page home">
      <header className="topbar">
        <div className="grow">
          <div className="overline">{greeting()}</div>
          <h1 className="h1">Tonight</h1>
        </div>
        <button className="icon-btn" aria-label="Search library" onClick={() => setSearch(true)}>
          <Search size={20} />
        </button>
        <Link className="icon-btn" aria-label="Settings" to="/settings">
          <Settings2 size={20} />
        </Link>
      </header>
      {search && <SearchOverlay onClose={() => setSearch(false)} />}

      {q.isLoading && (
        <>
          <Skeleton h={520} r={28} style={{ marginTop: 64 }} />
          <div className="section">
            <CardSkeletons rail n={4} />
          </div>
        </>
      )}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && d.stats.items === 0 && (
        <EmptyState
          icon={<CloudCog size={30} />}
          title="Your library is empty"
          action={
            <Link className="btn btn-primary" to="/settings/pcloud">
              Connect pCloud
            </Link>
          }
        >
          Connect your pCloud account and choose the folders with your videos. Pulse indexes them and matches every file with ThePornDB.
        </EmptyState>
      )}
      {d && d.stats.items > 0 && (
        <>
          {d.featured.length > 0 && <Hero items={d.featured} />}
          {d.tags.length > 0 && (
            <div className="chips mt-16" aria-label="Browse categories">
              <Chip on onClick={() => nav('/library')}>All</Chip>
              {d.tags.slice(0, 10).map((t) => (
                <Chip key={t.id} onClick={() => nav(`/library?tags=${t.id}`)}>
                  {t.name}
                </Chip>
              ))}
            </div>
          )}
          {d.continueWatching.length > 0 && (
            <section className="section" data-reveal>
              <SectionHead title="Continue watching" />
              <Rail col="264px" label="Continue watching">
                {d.continueWatching.map((it) => (
                  <ContinueCard key={it.id} item={it} />
                ))}
              </Rail>
            </section>
          )}
          <section className="section" data-reveal>
            <SectionHead title="Recently added" action={<Link className="see-all" to="/library?sort=added">See all <ChevronRight size={14} /></Link>} />
            <Rail label="Recently added">
              {d.recentlyAdded.map((it) => (
                <SceneCard key={it.id} item={it} queue={d.recentlyAdded} />
              ))}
            </Rail>
          </section>
          {d.performers.length > 0 && (
            <section className="section" data-reveal>
              <SectionHead title="Performers" action={<Link className="see-all" to="/library?tab=performers">See all <ChevronRight size={14} /></Link>} />
              <Rail col="132px" label="Performers">
                {d.performers.map((p) => (
                  <PersonCard key={p.id} p={p} count={p.c} />
                ))}
              </Rail>
            </section>
          )}
          {d.rails.map((r) => (
            <section className="section" key={r.id} data-reveal>
              <SectionHead
                title={r.title}
                action={
                  <Link className="see-all" to={r.kind === 'site' ? `/studio/${r.refId}` : r.kind === 'performer' ? `/performer/${r.refId}` : `/library?tags=${r.refId}`}>
                    See all <ChevronRight size={14} />
                  </Link>
                }
              />
              <Rail label={r.title}>
                {r.items.map((it) => (
                  <SceneCard key={it.id} item={it} queue={r.items} />
                ))}
              </Rail>
            </section>
          ))}
          {d.watchlist.length > 0 && (
            <section className="section" data-reveal>
              <SectionHead title="Watchlist" action={<Link className="see-all" to="/favorites?list=watchlist">See all <ChevronRight size={14} /></Link>} />
              <Rail label="Watchlist">
                {d.watchlist.map((it) => (
                  <SceneCard key={it.id} item={it} queue={d.watchlist} />
                ))}
              </Rail>
            </section>
          )}
        </>
      )}
    </main>
  );
}
