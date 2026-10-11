import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { SceneCard, PersonCard } from '../components/Cards';
import { CardSkeletons, EmptyState, ErrorState, Segmented, SectionHead } from '../components/ui';

export default function Favorites() {
  const [sp, setSp] = useSearchParams();
  const list = sp.get('list') === 'watchlist' ? 'watchlist' : 'favorites';
  const q = useQuery({ queryKey: ['favorites', list], queryFn: () => api.favorites(list) });
  const d = q.data;
  return (
    <main className="page">
      <header className="topbar">
        <h1 className="h1">{list === 'watchlist' ? 'Watchlist' : 'Favorites'}</h1>
      </header>
      <Segmented label="List" value={list} onChange={(v) => setSp({ list: v }, { replace: true })} options={[{ value: 'favorites', label: 'Favorites' }, { value: 'watchlist', label: 'Watchlist' }]} />
      <div className="mt-24">
        {q.isLoading && <CardSkeletons n={6} />}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {d && !d.items.length && !d.performers.length && !d.studios.length && (
          <EmptyState title={list === 'watchlist' ? 'Nothing saved for later' : 'No favorites yet'}>
            {list === 'watchlist' ? 'Tap the bookmark on any video to save it here.' : 'Tap the heart on videos, performers or studios to collect them here.'}
          </EmptyState>
        )}
        {d && d.performers.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <SectionHead title="Performers" />
            <div className="rail" style={{ ['--col' as string]: '108px' }}>
              {d.performers.map((p) => (
                <PersonCard key={p.id} p={p} />
              ))}
            </div>
          </section>
        )}
        {d && d.studios.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <SectionHead title="Studios" />
            <div className="chips wrap">
              {d.studios.map((s) => (
                <Link key={s.id} to={`/studio/${s.id}`} className="chip">
                  {s.name}
                </Link>
              ))}
            </div>
          </section>
        )}
        {d && d.items.length > 0 && (
          <section>
            <SectionHead title="Videos" />
            <div className="grid">
              {d.items.map((it) => (
                <SceneCard key={it.id} item={it} queue={d.items} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
