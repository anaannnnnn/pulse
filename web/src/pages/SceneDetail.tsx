import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Heart, Bookmark, Play, Wand2, ExternalLink, Subtitles, Clock, MonitorPlay, Building2, CalendarDays } from 'lucide-react';
import { api } from '../api';
import { Cover } from '../components/Art';
import { PersonCard, SceneCard } from '../components/Cards';
import { Chip, Confidence, ErrorState, SectionHead, Skeleton } from '../components/ui';
import { MatchSheet } from '../components/MatchSheet';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';
import { cx, fmtBytes, fmtDate, fmtDuration, fmtTime, providerLabel, strategyLabel } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useFavorite } from '../lib/useFavorite';
import { gsap, reduced } from '../motion/gsap';
import { startPosterIn, endPosterIn } from '../motion/transition';
import { setAmbient } from '../motion/ambient';

export default function SceneDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const player = usePlayer();
  const { prefs } = usePrefs();
  const fav = useFavorite();
  const [matchOpen, setMatchOpen] = useState(false);
  const [more, setMore] = useState(false);
  const q = useQuery({ queryKey: ['item', id], queryFn: () => api.item(id) });
  const back = () => (history.length > 1 ? nav(-1) : nav('/'));
  const heroRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    startPosterIn();
  }, [id]);
  const loaded = q.data?.item;
  // poster -> backdrop shared-element entrance, scroll parallax, ambient glow from the artwork
  useLayoutEffect(() => {
    const h = heroRef.current;
    if (!h || !loaded) return;
    void setAmbient(loaded.scene?.background || loaded.scene?.poster, loaded.id);
    const played = endPosterIn(h);
    const ctx = gsap.context(() => {
      if (reduced()) return;
      gsap.to('.detail-hero .bg', { yPercent: 14, scale: 1.14, ease: 'none', scrollTrigger: { trigger: h, start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('.detail-hero > .stack', { y: -40, opacity: 0.15, ease: 'none', scrollTrigger: { trigger: h, start: '45% top', end: 'bottom top', scrub: true } });
      if (!played) gsap.from('.detail-hero .bg', { scale: 1.2, duration: 1.4, ease: 'expo.out' });
      gsap.from('.detail-play > *', { y: 26, opacity: 0, duration: 0.7, stagger: 0.07, ease: 'power4.out', delay: played ? 0.7 : 0.15, clearProps: 'all' });
    }, h.parentElement!);
    return () => ctx.revert();
  }, [loaded?.id]);

  if (q.isLoading)
    return (
      <main className="page no-pad-top">
        <Skeleton h={520} style={{ margin: '0 calc(-1 * var(--page-x))', borderRadius: 0 }} />
        <div className="stack gap-12 mt-16">
          <Skeleton h={18} w="60%" />
          <Skeleton h={14} w="40%" />
          <Skeleton h={80} />
        </div>
      </main>
    );
  if (q.isError || !q.data)
    return (
      <main className="page">
        <button className="icon-btn" onClick={back} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <div className="mt-24">
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </div>
      </main>
    );
  const { item: it, related } = q.data;
  const sc = it.scene;
  const resume = it.progress && !it.progress.completed && it.progress.position > 15;
  const pct = it.progress?.duration ? (it.progress.position / it.progress.duration) * 100 : 0;

  return (
    <main className={cx('page no-pad-top', prefs.blurThumbs && 'blur')}>
      <section className="detail-hero" ref={heroRef}>
        <div className="bg hero-media">
          <Cover src={sc?.background || sc?.poster} alt="" seed={it.id} eager label={!sc ? it.name : undefined} />
        </div>
        <div className="detail-top">
          <button className="icon-btn" onClick={back} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
          <button className="icon-btn" onClick={() => setMatchOpen(true)} aria-label="Fix metadata match">
            <Wand2 size={18} />
          </button>
        </div>
        <div className="stack gap-12" style={{ width: '100%' }}>
          <div className="row gap-8 wrap">
            {sc?.site && (
              <Link to={`/studio/${sc.site.id}`} className="badge violet" style={{ height: 24, fontSize: 11 }}>
                {sc.site.name}
              </Link>
            )}
            {it.resolution && <span className="badge">{it.resolution}</span>}
            {sc?.type && sc.type !== 'scene' && <span className="badge cyan">{sc.type}</span>}
            {it.matchStatus !== 'matched' && <span className="badge warn">{it.matchStatus === 'pending' ? 'Matching…' : 'Unmatched'}</span>}
          </div>
          <h1 className="detail-title">{it.title}</h1>
          <div className="meta-line">
            {fmtDate(sc?.date) && <span>{fmtDate(sc?.date)}</span>}
            {fmtDuration(it.duration) && (
              <>
                <span className="sep" />
                <span>{fmtDuration(it.duration)}</span>
              </>
            )}
            {it.size && (
              <>
                <span className="sep" />
                <span>{fmtBytes(it.size)}</span>
              </>
            )}
            {it.subtitles.length > 0 && (
              <>
                <span className="sep" />
                <Subtitles size={14} />
              </>
            )}
          </div>
        </div>
      </section>

      <div className="stack gap-16 mt-16">
        <div className="actions detail-play">
          <button className="btn btn-primary grow" onClick={() => player.play(itemSource(it, related))}>
            <Play size={16} fill="currentColor" /> {resume ? `Resume from ${fmtTime(it.progress!.position)}` : 'Play'}
          </button>
          <button className={cx('icon-btn', it.favorite && 'on')} aria-pressed={it.favorite} aria-label="Favorite" onClick={() => fav.mutate({ kind: 'item', refId: it.id, list: 'favorites', on: !it.favorite })}>
            <Heart size={20} fill={it.favorite ? 'currentColor' : 'none'} />
          </button>
          <button className={cx('icon-btn', it.watchlist && 'on')} aria-pressed={it.watchlist} aria-label="Watchlist" onClick={() => fav.mutate({ kind: 'item', refId: it.id, list: 'watchlist', on: !it.watchlist })}>
            <Bookmark size={20} fill={it.watchlist ? 'currentColor' : 'none'} />
          </button>
        </div>
        {pct > 0 && !it.progress?.completed && (
          <div className="progress-line" aria-label={`${Math.round(pct)}% watched`}>
            <i style={{ width: `${pct}%` }} />
          </div>
        )}

        {!sc && (
          <div className="banner warn">
            <Wand2 size={18} />
            <span className="grow">No metadata yet. Search ThePornDB to match this file.</span>
            <button className="btn btn-primary btn-sm" onClick={() => setMatchOpen(true)}>
              Find match
            </button>
          </div>
        )}

        {sc?.description && (
          <div>
            <p className={cx('desc', !more && 'clamp-3')} style={{ margin: 0 }}>
              {sc.description}
            </p>
            {sc.description.length > 180 && (
              <button className="link-btn mt-8" onClick={() => setMore(!more)}>
                {more ? 'Show less' : 'Read more'}
              </button>
            )}
          </div>
        )}

        <div className="feat">
          <h3 className="feat-h">At a glance</h3>
          <div className="feat-grid">
            <span><Clock size={22} /><b>{fmtDuration(it.duration) || '—'}</b><em>Runtime</em></span>
            <span><MonitorPlay size={22} /><b>{it.resolution || 'HD'}</b><em>Quality</em></span>
            <span><Building2 size={22} /><b className="clamp-1">{sc?.site?.name || 'Library'}</b><em>Studio</em></span>
            <span><CalendarDays size={22} /><b>{sc?.date ? sc.date.slice(0, 4) : '—'}</b><em>Released</em></span>
          </div>
        </div>
      </div>

      {sc && sc.performers.length > 0 && (
        <section className="section">
          <SectionHead title="Performers" />
          <div className="rail" style={{ ['--col' as string]: '132px' }}>
            {sc.performers.map((p) => (
              <PersonCard key={p.id} p={p} />
            ))}
          </div>
        </section>
      )}

      {sc && sc.tags.length > 0 && (
        <section className="section">
          <SectionHead title="Categories" />
          <div className="chips wrap">
            {sc.tags.map((t) => (
              <Chip small key={t.id} onClick={() => nav(`/library?tags=${t.id}`)}>
                {t.name}
              </Chip>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <SectionHead title="File" />
        <div className="panel">
          <dl className="kv">
            <dt>Name</dt>
            <dd className="mono" style={{ fontSize: 12 }}>{it.name}</dd>
            {it.path && (
              <>
                <dt>Folder</dt>
                <dd>{it.path.split('/').slice(0, -1).join('/') || '/'}</dd>
              </>
            )}
            <dt>Size</dt>
            <dd>{fmtBytes(it.size)}</dd>
            <dt>Match</dt>
            <dd>
              {it.matchStatus === 'matched' ? (
                <span className="row gap-8 wrap">
                  {it.matchSource === 'manual' ? <span className="badge ok">Manual</span> : <Confidence value={it.matchConfidence} />}
                  {it.provider && <span className="badge violet" title="Metadata provider that supplied this match">Matched via {providerLabel(it.provider)}</span>}
                  {it.matchStrategy && it.matchStrategy !== 'manual' && <span className="badge" title="Matching strategy that found this scene">{strategyLabel(it.matchStrategy)}</span>}
                </span>
              ) : (
                it.matchError || (it.matchStatus === 'pending' ? 'Queued for matching' : 'No confident match')
              )}
            </dd>
            {it.subtitles.length > 0 && (
              <>
                <dt>Subtitles</dt>
                <dd>{it.subtitles.map((s) => s.lang.toUpperCase()).join(', ')}</dd>
              </>
            )}
            {sc?.url && (
              <>
                <dt>Source</dt>
                <dd>
                  <a href={sc.url} target="_blank" rel="noreferrer noopener" className="row gap-4 accent">
                    Official page <ExternalLink size={12} />
                  </a>
                </dd>
              </>
            )}
          </dl>
        </div>
      </section>

      {related.length > 0 && (
        <section className="section">
          <SectionHead title="More like this" />
          <div className="rail">
            {related.map((r) => (
              <SceneCard key={r.id} item={r} queue={related} />
            ))}
          </div>
        </section>
      )}
      {matchOpen && <MatchSheet item={it} onClose={() => setMatchOpen(false)} />}
    </main>
  );
}
