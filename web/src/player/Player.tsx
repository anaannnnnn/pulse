import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Pause, Play, RotateCcw, RotateCw, Maximize, Minimize, PictureInPicture2, Gauge, Settings2, Captions, X, Volume2, VolumeX, SkipForward, AlertTriangle, Sun } from 'lucide-react';
import { api, type StreamInfo, type StreamVariant } from '../api';
import { usePlayer, type PlaySource } from './PlayerContext';
import { usePrefs } from '../lib/prefs';
import { cx, fmtTime } from '../lib/format';
import { useToast } from '../components/Toast';
import { gsap, haptic } from '../motion/gsap';

const NATIVE_OK = ['mp4', 'm4v', 'mov', 'webm'];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const nativeHls = () => typeof document !== 'undefined' && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');

/** Timeline scrubber: buffered + played ranges, a draggable head and a time tooltip. Keyboard: ←/→ 5 s, Home/End. */
function Scrubber({ time, duration, buffered, onSeek }: { time: number; duration: number; buffered: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pctAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const shown = drag ?? (duration ? time / duration : 0);
  const tipAt = drag ?? hover;
  return (
    <div
      ref={ref}
      className={cx('scrub', drag != null && 'dragging')}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${fmtTime(time)} of ${fmtTime(duration)}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(pctAt(e.clientX));
      }}
      onPointerMove={(e) => {
        const p = pctAt(e.clientX);
        if (e.pointerType === 'mouse') setHover(p);
        if (drag != null) setDrag(p);
      }}
      onPointerUp={(e) => {
        if (drag != null) onSeek(pctAt(e.clientX) * duration);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(Math.min(duration, time + 5));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, time - 5));
        if (e.key === 'Home') onSeek(0);
        if (e.key === 'End') onSeek(Math.max(0, duration - 1));
      }}
    >
      <div className="track">
        <i className="buf" style={{ width: `${Math.max(shown, buffered) * 100}%` }} />
        <i className="played" style={{ width: `${shown * 100}%` }} />
      </div>
      <div className="head" style={{ left: `${shown * 100}%` }} />
      {tipAt != null && duration > 0 && (
        <div className="tip" style={{ left: `${Math.min(96, Math.max(4, tipAt * 100))}%` }}>
          {fmtTime(tipAt * duration)}
        </div>
      )}
    </div>
  );
}

export function Player() {
  const pl = usePlayer();
  const { prefs } = usePrefs();
  const toast = useToast();
  const s = pl.current;
  const rootRef = useRef<HTMLDivElement>(null);
  const v = pl.videoRef;
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [variant, setVariant] = useState('original');
  const [useFallback, setUseFallback] = useState(false);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState<null | 'speed' | 'quality' | 'subs'>(null);
  const [speed, setSpeed] = useState(prefs.defaultSpeed);
  const [buffered, setBuffered] = useState(0);
  const [fs, setFs] = useState(false);
  const [muted, setMuted] = useState(false);
  const [subOn, setSubOn] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ side: 'l' | 'r' | 'c'; n: number } | null>(null);
  const resumeAt = useRef<number | null>(null);
  const lastSave = useRef(0);
  const retried = useRef(0);
  const idleTimer = useRef<number | undefined>(undefined);
  const lastTap = useRef({ t: 0 }).current;
  // gestures: drag down = minimise (spring), right edge = volume, left edge = brightness
  const [hud, setHud] = useState<{ k: 'vol' | 'bri'; v: number } | null>(null);
  const [bri, setBri] = useState(1);
  const hudT = useRef<number | undefined>(undefined);
  const g = useRef<{ id: number; mode: 'none' | 'dismiss' | 'vol' | 'bri'; x: number; y: number; base: number; vy: number; ly: number; lt: number } | null>(null);
  const skip = prefs.skipSeconds || 10;

  // resolve stream links (fresh, short-lived) + resume point whenever the source changes
  const resolve = useCallback(
    async (keepVariant?: string) => {
      if (!s) return;
      try {
        const info = await api.stream({ kind: s.kind, itemId: s.itemId, tb: s.tb });
        setStream(info);
        const native = !s.ext || NATIVE_OK.includes(s.ext);
        const firstAlt = info.variants.find((x) => x.transcoded && (x.type !== 'hls' || nativeHls() || true));
        setVariant(keepVariant || (prefs.preferOriginal && native ? 'original' : firstAlt?.id || 'original'));
        if (info.duration) pl._setPlayback({ duration: info.duration });
      } catch (e) {
        setLoading(false);
        setError((e as Error).message || 'Could not get a stream link');
      }
    },
    [s?.key, prefs.preferOriginal],
  );
  useEffect(() => {
    if (!s) return;
    setError(null);
    setLoading(true);
    setMenu(null);
    setStream(null);
    setUseFallback(false);
    retried.current = 0;
    setSubOn(null);
    void resolve();
    resumeAt.current = null;
    if (prefs.resumePlayback)
      api
        .getProgress(s.key)
        .then((p) => {
          if (p && !p.completed && p.position > 15) {
            resumeAt.current = p.position;
            if (v.current && v.current.readyState >= 1) v.current.currentTime = p.position;
          }
        })
        .catch(() => {});
  }, [s?.key]);

  const current: StreamVariant | undefined = stream?.variants.find((x) => x.id === variant) || stream?.variants[0];
  const src = current ? (useFallback && current.fallback ? current.fallback : current.url) : null;
  const isHls = !!current && (current.type === 'hls' || /\.m3u8(\?|$)/.test(src || ''));

  // attach source (hls.js for HLS where the browser has no native support)
  useEffect(() => {
    const el = v.current;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (!el || !src) return;
    if (isHls && !nativeHls()) {
      let cancelled = false;
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) return;
        const h = new Hls({ maxBufferLength: 60 });
        h.loadSource(src);
        h.attachMedia(el);
        h.on(Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) {
            setLoading(false);
            setError('The adaptive stream failed. Try another quality.');
          }
        });
        hlsRef.current = h;
      });
      return () => {
        cancelled = true;
      };
    }
    el.src = src;
    el.load();
  }, [src, isHls]);
  useEffect(() => () => hlsRef.current?.destroy(), []);

  const save = useCallback(
    (force = false) => {
      const el = v.current;
      if (!s || !el || !el.duration || !Number.isFinite(el.duration)) return;
      if (!force && Date.now() - lastSave.current < 10_000) return;
      lastSave.current = Date.now();
      api.saveProgress(s.key, { position: el.currentTime, duration: el.duration, title: s.title, poster: s.poster ?? null }).catch(() => {});
    },
    [s?.key],
  );

  useEffect(() => {
    const onHide = () => save(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      save(true);
    };
  }, [save]);

  // idle auto-hide
  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      if (v.current && !v.current.paused) setIdle(true);
    }, 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  const seek = (t: number) => {
    const el = v.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(t, el.duration || t));
    poke();
  };
  const jump = (d: number) => {
    seek((v.current?.currentTime || 0) + d);
    setFlash({ side: d < 0 ? 'l' : 'r', n: Date.now() });
  };
  const toggleFs = async () => {
    const el = rootRef.current as HTMLElement & { webkitRequestFullscreen?: () => void };
    const vid = v.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (el.requestFullscreen) await el.requestFullscreen();
      else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();
    } catch {
      vid.webkitEnterFullscreen?.();
    }
  };
  useEffect(() => {
    const h = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const pip = async () => {
    const vid = v.current as HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void };
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (vid.requestPictureInPicture) await vid.requestPictureInPicture();
      else vid.webkitSetPresentationMode?.('picture-in-picture');
    } catch {
      toast('Picture-in-picture is not available here', 'error');
    }
  };
  const changeVariant = (id: string) => {
    resumeAt.current = v.current?.currentTime || resumeAt.current || 0;
    setLoading(true);
    setError(null);
    setUseFallback(false);
    setVariant(id);
    setMenu(null);
  };

  // keyboard
  useEffect(() => {
    if (!s || !pl.expanded) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        pl.toggle();
      } else if (e.key === 'ArrowRight' || e.key === 'l') jump(skip);
      else if (e.key === 'ArrowLeft' || e.key === 'j') jump(-skip);
      else if (e.key === 'f') toggleFs();
      else if (e.key === 'm' && v.current) {
        v.current.muted = !v.current.muted;
        setMuted(v.current.muted);
      } else if (e.key === 'Escape' && !document.fullscreenElement) pl.minimize();
      poke();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [s?.key, pl.expanded, skip]);

  // media session (lock screen controls)
  useEffect(() => {
    if (!s || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.subtitle || 'Pulse', artwork: s.poster ? [{ src: s.poster, sizes: '512x512' }] : [] });
    navigator.mediaSession.setActionHandler('seekbackward', () => jump(-skip));
    navigator.mediaSession.setActionHandler('seekforward', () => jump(skip));
  }, [s?.key]);

  const showHud = (k: 'vol' | 'bri', val: number) => {
    setHud({ k, v: val });
    window.clearTimeout(hudT.current);
    hudT.current = window.setTimeout(() => setHud(null), 900);
  };
  const gDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,.scrub,.menu,input,a')) return;
    g.current = { id: e.pointerId, mode: 'none', x: e.clientX, y: e.clientY, base: 0, vy: 0, ly: e.clientY, lt: performance.now() };
  };
  const gMove = (e: React.PointerEvent) => {
    const d = g.current, root = rootRef.current;
    if (!d || d.id !== e.pointerId || !root) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y, w = root.clientWidth, h = root.clientHeight;
    if (d.mode === 'none') {
      if (Math.abs(dy) < 12 || Math.abs(dy) < Math.abs(dx) * 1.4) return;
      const fx = d.x / w;
      if (fx > 0.76) { d.mode = 'vol'; d.base = v.current?.volume ?? 1; }
      else if (fx < 0.24) { d.mode = 'bri'; d.base = bri; }
      else if (dy > 0) d.mode = 'dismiss';
      else return;
      try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    const now = performance.now();
    d.vy = (e.clientY - d.ly) / Math.max(1, now - d.lt);
    d.ly = e.clientY; d.lt = now;
    if (d.mode === 'vol') {
      const val = Math.min(1, Math.max(0, d.base - dy / (h * 0.55)));
      if (v.current) { v.current.volume = val; v.current.muted = val === 0; }
      setMuted(val === 0);
      showHud('vol', val);
    } else if (d.mode === 'bri') {
      const val = Math.min(1.4, Math.max(0.25, d.base - dy / (h * 0.55)));
      setBri(val);
      showHud('bri', (val - 0.25) / 1.15);
    } else if (d.mode === 'dismiss') {
      const p = Math.min(1, Math.max(0, dy) / (h * 0.5));
      gsap.set(root, { y: Math.max(0, dy) * 0.92, scale: 1 - p * 0.14, borderRadius: p * 36, overflow: 'hidden', transformOrigin: '50% 40%', overwrite: 'auto' });
    }
  };
  const gUp = (e: React.PointerEvent) => {
    const d = g.current, root = rootRef.current;
    g.current = null;
    if (!d || !root || d.mode !== 'dismiss') return;
    const dy = e.clientY - d.y;
    if (dy > 150 || d.vy > 0.8) {
      haptic(10);
      gsap.to(root, { y: window.innerHeight * 0.55, scale: 0.8, opacity: 0, duration: 0.32, ease: 'power3.in', onComplete: () => { gsap.set(root, { clearProps: 'all' }); pl.minimize(); } });
    } else gsap.to(root, { y: 0, scale: 1, borderRadius: 0, duration: 0.7, ease: 'elastic.out(1,0.6)', clearProps: 'borderRadius,overflow' });
  };
  if (!s) return null;
  const next = s.queue?.[0];
  const isTranscoded = !!current?.transcoded;
  const variants = stream?.variants || [];
  const subs = stream?.subtitles || [];

  return (
    <div
      ref={rootRef}
      className={cx('player', idle && 'idle', loading && !error && 'is-loading')}
      style={pl.expanded ? undefined : { visibility: 'hidden', pointerEvents: 'none', opacity: 0 }}
      onPointerMove={(e) => { poke(); gMove(e); }}
      onPointerDown={gDown}
      onPointerUp={gUp}
      onPointerCancel={gUp}
      role="dialog"
      aria-label={`Player: ${s.title}`}
      aria-hidden={!pl.expanded}
    >
      <video
        ref={v}
        playsInline
        autoPlay
        style={bri !== 1 ? { filter: `brightness(${bri})` } : undefined}
        preload="metadata"
        poster={s.poster || undefined}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.playbackRate = speed;
          if (resumeAt.current != null) {
            el.currentTime = resumeAt.current;
            resumeAt.current = null;
          }
          pl._setPlayback({ duration: el.duration });
          if (el.textTracks[0]) for (let i = 0; i < el.textTracks.length; i++) el.textTracks[i].mode = i === subOn ? 'showing' : 'hidden';
        }}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onPlaying={() => {
          setLoading(false);
          pl._setPlayback({ playing: true });
          poke();
        }}
        onPause={() => {
          pl._setPlayback({ playing: false });
          setIdle(false);
          save(true);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          pl._setPlayback({ time: el.currentTime });
          save();
        }}
        onProgress={(e) => {
          const el = e.currentTarget;
          if (el.buffered.length && el.duration) setBuffered(el.buffered.end(el.buffered.length - 1) / el.duration);
        }}
        onEnded={() => {
          save(true);
          if (prefs.autoplayNext && next) pl.play({ ...next, queue: s.queue!.slice(1) });
        }}
        onError={(e) => {
          const el = e.currentTarget;
          if (!src) return;
          const code = el.error?.code;
          resumeAt.current = el.currentTime || resumeAt.current;
          // 1) direct pCloud link refused (IP-bound / expired) -> server-side Range proxy
          if (current?.fallback && !useFallback) {
            setUseFallback(true);
            return;
          }
          // 2) codec not supported -> transcoded variant
          if (!current?.transcoded && code === 4) {
            const t = variants.find((x) => x.transcoded && x.type !== 'hls') || variants.find((x) => x.transcoded);
            if (t) {
              toast(`This file’s format isn’t supported here, switched to ${t.label}`, 'info');
              changeVariant(t.id);
              return;
            }
          }
          // 3) expired link -> fetch fresh links once, keep position
          if (retried.current < 1) {
            retried.current++;
            setUseFallback(false);
            void resolve(variant);
            return;
          }
          setLoading(false);
          setError(code === 4 ? 'This video format can’t be played in this browser.' : 'The stream stopped. Check your connection and try again.');
        }}
      >
        {subs.map((t, i) => (
          <track key={t.url} kind="subtitles" src={t.url} srcLang={(t.lang || 'en').slice(0, 2)} label={t.label || (t.lang || 'Subtitles').toUpperCase()} default={i === subOn} />
        ))}
      </video>

      <div
        className="layer"
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          const now = Date.now();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width;
          if (now - lastTap.t < 300 && (x < 0.33 || x > 0.66)) jump(x < 0.33 ? -skip : skip);
          lastTap.t = now;
          setMenu(null);
          if (idle) poke();
          else setIdle(!v.current?.paused);
        }}
      >
        <div className="ptop">
          <button className="icon-btn" onClick={() => pl.minimize()} aria-label="Minimise player">
            <ChevronDown size={20} />
          </button>
          <div className="ttl">
            <div className="overline" style={{ color: '#ffffffaa' }}>
              {s.kind === 'torbox' ? 'Playing from TorBox' : isTranscoded ? `pCloud · ${current?.label}` : useFallback ? 'pCloud · via server' : 'Playing from pCloud'}
            </div>
            <div className="h4 clamp-1" style={{ fontSize: 15 }}>
              {s.title}
            </div>
          </div>
          <button className="icon-btn" onClick={() => pl.close()} aria-label="Close player">
            <X size={20} />
          </button>
        </div>

        <div className="center" onClick={(e) => e.stopPropagation()}>
          <button className="skip" onClick={() => jump(-skip)} aria-label={`Back ${skip} seconds`}>
            <RotateCcw size={24} />
            <small>{skip}</small>
          </button>
          <button className="big" onClick={pl.toggle} aria-label={pl.playing ? 'Pause' : 'Play'}>
            {pl.playing ? <Pause size={34} fill="currentColor" /> : <Play size={34} fill="currentColor" style={{ marginLeft: 4 }} />}
          </button>
          <button className="skip" onClick={() => jump(skip)} aria-label={`Forward ${skip} seconds`}>
            <RotateCw size={24} />
            <small>{skip}</small>
          </button>
        </div>

        <div className="pbottom" onClick={(e) => e.stopPropagation()}>
          <div className="stack gap-4">
            <div className="h3 clamp-2">{s.title}</div>
            {s.subtitle && <div className="body-s clamp-1" style={{ color: 'rgba(255,255,255,0.7)' }}>{s.subtitle}</div>}
          </div>
          <Scrubber time={pl.time} duration={pl.duration} buffered={buffered} onSeek={seek} />
          <div className="times">
            <span>{fmtTime(pl.time)}</span>
            <span>-{fmtTime(Math.max(0, pl.duration - pl.time))}</span>
          </div>
          <div className="ctrl-row">
            <button
              className="icon-btn"
              aria-label={muted ? 'Unmute' : 'Mute'}
              onClick={() => {
                if (!v.current) return;
                v.current.muted = !v.current.muted;
                setMuted(v.current.muted);
              }}
            >
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <button className={cx('icon-btn', menu === 'speed' && 'on')} aria-label="Playback speed" onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>
              {speed === 1 ? <Gauge size={18} /> : <span className="mono" style={{ fontSize: 11 }}>{speed}×</span>}
            </button>
            {variants.length > 1 && (
              <button className={cx('icon-btn', menu === 'quality' && 'on')} aria-label="Quality" onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
                <Settings2 size={18} />
              </button>
            )}
            {subs.length > 0 && (
              <button className={cx('icon-btn', (menu === 'subs' || subOn != null) && 'on')} aria-label="Subtitles" onClick={() => setMenu(menu === 'subs' ? null : 'subs')}>
                <Captions size={18} />
              </button>
            )}
            <button className="icon-btn" aria-label="Picture in picture" onClick={pip}>
              <PictureInPicture2 size={18} />
            </button>
            {next && (
              <button className="icon-btn" aria-label="Play next" onClick={() => pl.play({ ...next, queue: s.queue!.slice(1) })}>
                <SkipForward size={18} />
              </button>
            )}
            <button className="icon-btn" aria-label={fs ? 'Exit full screen' : 'Full screen'} onClick={toggleFs}>
              {fs ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
      </div>

      {menu && (
        <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {menu === 'speed' && (
            <>
              <div className="mh overline">Speed</div>
              {SPEEDS.map((x) => (
                <button
                  key={x}
                  role="menuitemradio"
                  aria-checked={x === speed}
                  className={cx(x === speed && 'on')}
                  onClick={() => {
                    setSpeed(x);
                    if (v.current) v.current.playbackRate = x;
                    setMenu(null);
                  }}
                >
                  {x === 1 ? 'Normal' : `${x}×`}
                </button>
              ))}
            </>
          )}
          {menu === 'quality' && (
            <>
              <div className="mh overline">Quality</div>
              {variants.map((q) => (
                <button key={q.id} role="menuitemradio" aria-checked={q.id === variant} className={cx(q.id === variant && 'on')} onClick={() => changeVariant(q.id)}>
                  <span className="grow">{q.label}</span>
                  <span className="mono faint">{q.type === 'hls' ? 'HLS' : q.transcoded ? 'Transcoded' : ''}</span>
                </button>
              ))}
            </>
          )}
          {menu === 'subs' && (
            <>
              <div className="mh overline">Subtitles</div>
              {[{ label: 'Off', i: null as number | null }, ...subs.map((t, i) => ({ label: t.label || (t.lang || 'Track').toUpperCase(), i }))].map((o) => (
                <button
                  key={String(o.i)}
                  className={cx(o.i === subOn && 'on')}
                  onClick={() => {
                    setSubOn(o.i);
                    const tt = v.current?.textTracks;
                    if (tt) for (let i = 0; i < tt.length; i++) tt[i].mode = i === o.i ? 'showing' : 'hidden';
                    setMenu(null);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {hud && (
        <div className="hud" key={hud.k} role="status" aria-label={`${hud.k === 'vol' ? 'Volume' : 'Brightness'} ${Math.round(hud.v * 100)}%`}>
          {hud.k === 'vol' ? hud.v === 0 ? <VolumeX size={18} /> : <Volume2 size={18} /> : <Sun size={18} />}
          <span className="hud-bar"><i style={{ height: `${hud.v * 100}%` }} /></span>
        </div>
      )}
      {flash && <div key={flash.n} className="flash" style={flash.side === 'l' ? { left: '12%' } : { right: '12%' }}>{flash.side === 'l' ? <RotateCcw size={28} /> : <RotateCw size={28} />}</div>}
      {loading && !error && (
        <div className="loading">
          <div className="spinner" aria-label="Loading video" />
        </div>
      )}
      {error && (
        <div className="err">
          <div className="state err" style={{ background: '#13111fe6', maxWidth: 360 }}>
            <div className="orb">
              <AlertTriangle size={28} />
            </div>
            <h3 className="h4">Playback problem</h3>
            <p>{error}</p>
            <div className="row gap-8 wrap" style={{ justifyContent: 'center' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  retried.current = 0;
                  setError(null);
                  setLoading(true);
                  const el = v.current;
                  if (el) resumeAt.current = el.currentTime;
                  setUseFallback(false);
                  void resolve(variant);
                }}
              >
                Retry
              </button>
              {variants.filter((x) => x.transcoded && x.id !== variant && x.type !== 'hls').slice(0, 1).map((x) => (
                <button key={x.id} className="btn btn-secondary btn-sm" onClick={() => changeVariant(x.id)}>
                  Try {x.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function MiniPlayer() {
  const pl = usePlayer();
  const s = pl.current;
  if (!s || pl.expanded) return null;
  return (
    <div className="mini glass" role="region" aria-label="Now playing">
      <button className="row gap-12 grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={pl.expand} aria-label={`Open player: ${s.title}`}>
        <span className="cover">{s.poster ? <img src={s.poster} alt="" referrerPolicy="no-referrer" /> : <span className="gen-art" />}</span>
        <span className="grow stack" style={{ minWidth: 0 }}>
          <span className="t clamp-1">{s.title}</span>
          <span className="s clamp-1">{s.subtitle || (s.kind === 'torbox' ? 'TorBox' : 'pCloud')}</span>
        </span>
      </button>
      <button className="icon-btn ghost" onClick={pl.toggle} aria-label={pl.playing ? 'Pause' : 'Play'}>
        {pl.playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
      </button>
      <button className="icon-btn ghost sm" onClick={pl.close} aria-label="Stop">
        <X size={18} />
      </button>
      <span className="prog" style={{ width: `${pl.duration ? (pl.time / pl.duration) * 100 : 0}%` }} />
    </div>
  );
}
