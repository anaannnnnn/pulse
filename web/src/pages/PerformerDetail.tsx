import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Heart, Play, Globe } from 'lucide-react';
import { api } from '../api';
import { Cover } from '../components/Art';
import { SceneCard } from '../components/Cards';
import { CardSkeletons, EmptyState, ErrorState, SectionHead, Skeleton } from '../components/ui';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';
import { age, cx, fmtDate } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useFavorite } from '../lib/useFavorite';

const LABELS: [string, string][] = [
  ['birthday', 'Born'],
  ['birthplace', 'Birthplace'],
  ['nationality', 'Nationality'],
  ['ethnicity', 'Ethnicity'],
  ['height', 'Height'],
  ['weight', 'Weight'],
  ['measurements', 'Measurements'],
  ['cupsize', 'Cup size'],
  ['hair_colour', 'Hair'],
  ['eye_colour', 'Eyes'],
  ['tattoos', 'Tattoos'],
  ['piercings', 'Piercings'],
  ['astrology', 'Star sign'],
];

export default function PerformerDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const player = usePlayer();
  const { prefs } = usePrefs();
  const fav = useFavorite();
  const [bioMore, setBioMore] = useState(false);
  const [remoteOn, setRemoteOn] = useState(false);
  const q = useQuery({ queryKey: ['performer', id], queryFn: () => api.performer(id) });
  const remote = useQuery({ queryKey: ['performer-remote', id], queryFn: () => api.performerRemote(id, q.data?.performer.name), enabled: remoteOn });
  const back = () => (history.length > 1 ? nav(-1) : nav('/library?tab=performers'));

  if (q.isLoading)
    return (
      <main className="page">
        <div className="stack gap-16" style={{ alignItems: 'center', paddingTop: 72 }}>
          <Skeleton w={184} h={184} r={999} />
          <Skeleton w={200} h={28} />
          <Skeleton w="100%" h={70} />
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
  const { performer: p, items } = q.data;
  const ex = p.extras || {};
  const a = age(ex.birthday);
  const career = ex.career_start_year ? `${ex.career_start_year}–${ex.career_end_year || 'now'}` : null;
  const details = LABELS.map(([k, l]) => [l, k === 'birthday' ? fmtDate(ex[k] as string) : ex[k]] as const).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);

  return (
    <main className={cx('page no-pad-top', prefs.blurThumbs && 'blur')}>
      <section className="profile-hero">
        <div className="aurora" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <div className="detail-top">
          <button className="icon-btn" onClick={back} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
          <button className={cx('icon-btn', p.favorite && 'on')} aria-pressed={p.favorite} aria-label="Favorite performer" onClick={() => fav.mutate({ kind: 'performer', refId: p.id, list: 'favorites', on: !p.favorite })}>
            <Heart size={20} fill={p.favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div className="portrait blurable">
          <Cover src={p.image || p.face} alt={p.name} seed={p.id} eager />
        </div>
        <div className="stack gap-4">
          <h1 className="h1">{p.name}</h1>
          {p.aliases.length > 0 && <p className="caption clamp-1" style={{ margin: 0 }}>Also known as {p.aliases.slice(0, 3).join(', ')}</p>}
        </div>
        <div className="stats">
          <div className="stat">
            <b>{items.length}</b>
            <span>In library</span>
          </div>
          <div className="stat">
            <b>{a ?? '—'}</b>
            <span>Age</span>
          </div>
          <div className="stat">
            <b>{career ? String(ex.career_start_year) : (ex.height as string) || '—'}</b>
            <span>{career ? 'Debut' : 'Height'}</span>
          </div>
        </div>
        {items.length > 0 && (
          <button className="btn btn-primary btn-block" onClick={() => player.play(itemSource(items[0], items))}>
            <Play size={16} fill="currentColor" /> Play all
          </button>
        )}
      </section>

      {p.bio && (
        <section className="section">
          <SectionHead title="About" />
          <p className={cx('desc', !bioMore && 'clamp-3')} style={{ margin: 0 }}>{p.bio}</p>
          {p.bio.length > 180 && (
            <button className="link-btn mt-8" onClick={() => setBioMore(!bioMore)}>
              {bioMore ? 'Show less' : 'Read more'}
            </button>
          )}
        </section>
      )}

      {details.length > 0 && (
        <section className="section">
          <SectionHead title="Details" />
          <div className="panel">
            <dl className="kv">
              {details.map(([l, v]) => (
                <div key={l} style={{ display: 'contents' }}>
                  <dt>{l}</dt>
                  <dd>{String(v)}{l === 'Born' && a ? ` (${a})` : ''}</dd>
                </div>
              ))}
              {career && (
                <>
                  <dt>Career</dt>
                  <dd>{career}</dd>
                </>
              )}
            </dl>
          </div>
        </section>
      )}

      {p.photos.length > 1 && (
        <section className="section">
          <SectionHead title="Photos" />
          <div className="photos">
            {p.photos.map((src) => (
              <img key={src} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className="blurable" />
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <SectionHead title="In your library" />
        {items.length ? (
          <div className="grid">
            {items.map((it) => (
              <SceneCard key={it.id} item={it} queue={items} />
            ))}
          </div>
        ) : (
          <EmptyState title="No videos with this performer" />
        )}
      </section>

      <section className="section">
        <SectionHead title="More on ThePornDB" action={!remoteOn ? <button className="link-btn row gap-4" onClick={() => setRemoteOn(true)}><Globe size={14} /> Load</button> : undefined} />
        {remoteOn && remote.isLoading && <CardSkeletons rail n={4} />}
        {remote.isError && <ErrorState error={remote.error} onRetry={() => remote.refetch()} />}
        {remote.data && (
          <div className="rail">
            {remote.data.scenes.map((s) => (
              <div key={s.id} className="card" style={{ cursor: 'default' }}>
                <div className="art">
                  <Cover src={s.poster} alt="" seed={s.id} />
                  {s.inLibrary && <div className="corner"><span className="badge ok">In library</span></div>}
                </div>
                <div className="meta">
                  <span className="title clamp-2">{s.title}</span>
                  <span className="sub clamp-1">{[s.site, s.date?.slice(0, 4)].filter(Boolean).join(' · ')}</span>
                </div>
              </div>
            ))}
            {!remote.data.scenes.length && <p className="caption">Nothing else found.</p>}
          </div>
        )}
        {!remoteOn && <p className="caption" style={{ margin: 0 }}>See scenes featuring {p.name} that aren’t in your library yet.</p>}
      </section>
    </main>
  );
}
