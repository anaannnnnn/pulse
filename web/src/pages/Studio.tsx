import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Heart } from 'lucide-react';
import { api } from '../api';
import { SceneCard } from '../components/Cards';
import { CardSkeletons, ErrorState } from '../components/ui';
import { cx } from '../lib/format';
import { useFavorite } from '../lib/useFavorite';

export default function Studio() {
  const { id = '0' } = useParams();
  const nav = useNavigate();
  const fav = useFavorite();
  const q = useQuery({ queryKey: ['studio', id], queryFn: () => api.studio(Number(id)) });
  const favs = useQuery({ queryKey: ['studios'], queryFn: api.studios });
  const isFav = !!favs.data?.find((s) => s.id === Number(id))?.favorite;
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => (history.length > 1 ? nav(-1) : nav('/library?tab=studios'))} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <div className="grow" />
        <button className={cx('icon-btn', isFav && 'on')} aria-label="Favorite studio" onClick={() => fav.mutate({ kind: 'site', refId: Number(id), list: 'favorites', on: !isFav })}>
          <Heart size={20} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      </header>
      {q.isLoading && <CardSkeletons n={6} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <>
          <div className="row gap-16" style={{ marginBottom: 24 }}>
            {q.data.studio.logo && (
              <span style={{ width: 72, height: 72, borderRadius: 20, background: '#fff', padding: 10, flex: 'none', display: 'grid', placeItems: 'center', boxShadow: 'var(--glow-violet)' }}>
                <img src={q.data.studio.logo} alt="" referrerPolicy="no-referrer" style={{ maxHeight: '100%', objectFit: 'contain' }} />
              </span>
            )}
            <div className="grow">
              <div className="overline">Studio</div>
              <h1 className="h2">{q.data.studio.name}</h1>
              <div className="caption">{q.data.items.length} videos in your library</div>
            </div>
          </div>
          <div className="grid">
            {q.data.items.map((it) => (
              <SceneCard key={it.id} item={it} queue={q.data.items} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
