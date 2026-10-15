import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, CloudCog, ChevronRight, Settings2, LayoutGrid, Film, HardDrive, Sparkles, Flame, Heart, Star, Zap, Gem, Crown, Moon, Sun, Music } from 'lucide-react';

const CAT_ICONS = [Flame, Heart, Star, Zap, Gem, Crown, Moon, Sun, Music];
import { api, isMock, type Item } from '../api';
import { SceneCard, ContinueCard, PersonCard, CatCard } from '../components/Cards';
import { SearchOverlay } from '../components/SearchOverlay';
import { Rail } from '../components/Rail';
import { useRailReveal } from '../motion/hooks';
import { Hero } from '../components/Hero';
import { fmtBytes } from '../lib/format';
import { CardSkeletons, EmptyState, ErrorState, SectionHead, Skeleton } from '../components/ui';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const q = useQuery({ queryKey: ['home'], queryFn: api.home });
  const client = useQueryClient();
  const [search, setSearch] = useState(false);
  const d = q.data;
  useRailReveal([d?.stats.items, d?.rails.length]);
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
        <Link className="icon-btn" aria-label="Settings" to="/settings">
          <Settings2 size={20} />
        </Link>
        <div className="grow" />
        <button className="icon-btn" aria-label="Search library" onClick={() => setSearch(true)}>
          <Search size={20} />
        </button>
        <Link className="avatar-btn" aria-label="Settings" to="/settings">P</Link>
      </header>
      <div className="greet">
        <div className="hi">{greeting()}</div>
        <h1 className="h1">Stream tonight,<br /><em>on your terms.</em></h1>
      </div>
      <button className="search-pill" onClick={() => setSearch(true)} aria-label="Search library">
        <span>Search titles, stars, studios…</span>
        <span className="go"><Search size={18} /></span>
      </button>
      {search && <SearchOverlay onClose={() => setSearch(false)} />}

      {q.isLoading && (
        <>
          <Skeleton h={300} r={30} style={{ marginTop: 24 }} />
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
          {d.tags.length > 0 && (
            <div className="cats" aria-label="Browse categories">
              <Link to="/library" className="cat on"><span className="cc"><LayoutGrid size={22} /></span><span>All</span></Link>
              {d.tags.slice(0, 9).map((t, n) => {
                const Ic = CAT_ICONS[n % CAT_ICONS.length];
                return (
                <Link key={t.id} to={`/library?tags=${t.id}`} className="cat"><span className="cc"><Ic size={22} /></span><span className="clamp-1">{t.name}</span></Link>
                );
              })}
            </div>
          )}
          {d.featured.length > 0 && <Hero items={d.featured} />}
          <div className="trust">
            <span><Film size={20} /><i><b>{d.stats.items}</b>videos</i></span>
            <span><HardDrive size={20} /><i><b>{d.stats.bytes != null ? fmtBytes(d.stats.bytes) : '—'}</b>stored</i></span>
            <span><Sparkles size={20} /><i><b>{d.stats.matched ?? 0}</b>matched</i></span>
          </div>
          {d.continueWatching.length > 0 && (
            <section className="section">
              <SectionHead title="Continue watching" />
              <Rail col="276px" label="Continue watching">
                {d.continueWatching.map((it) => (
                  <ContinueCard key={it.id} item={it} />
                ))}
              </Rail>
            </section>
          )}
          <section className="section">
            <SectionHead title="Recently added" action={<Link className="see-all" to="/library?sort=added">See all <ChevronRight size={14} /></Link>} />
            <Rail label="Recently added">
              {d.recentlyAdded.map((it) => (
                <SceneCard key={it.id} item={it} queue={d.recentlyAdded} />
              ))}
            </Rail>
          </section>
          {d.tags.length > 3 && (
            <section className="section">
              <SectionHead title="Top categories" action={<Link className="see-all" to="/library">View all <ChevronRight size={14} /></Link>} />
              <Rail col="132px" label="Top categories">
                {d.tags.slice(0, 10).map((t, n) => (
                  <CatCard key={t.id} tag={t} index={n} />
                ))}
              </Rail>
            </section>
          )}
          {d.performers.length > 0 && (
            <section className="section">
              <SectionHead title="Performers" action={<Link className="see-all" to="/library?tab=performers">See all <ChevronRight size={14} /></Link>} />
              <Rail col="132px" label="Performers">
                {d.performers.map((p) => (
                  <PersonCard key={p.id} p={p} count={p.c} />
                ))}
              </Rail>
            </section>
          )}
          {d.rails.map((r) => (
            <section className="section" key={r.id}>
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
            <section className="section">
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
