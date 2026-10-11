import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { Subtitle, TorboxKind } from '../api';

export interface PlaySource {
  key: string; // progress key: pc_<fileId> | tb:<kind>:<id>:<fileId>
  kind: 'pcloud' | 'torbox';
  title: string;
  subtitle?: string;
  poster?: string | null;
  fileId?: number;
  ext?: string;
  tb?: { kind: TorboxKind; id: number; fileId: number };
  subtitles?: Subtitle[];
  itemId?: string;
  duration?: number | null;
  queue?: PlaySource[];
}

interface PlayerState {
  current: PlaySource | null;
  expanded: boolean;
  playing: boolean;
  time: number;
  duration: number;
  play: (s: PlaySource) => void;
  expand: () => void;
  minimize: () => void;
  close: () => void;
  toggle: () => void;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  _setPlayback: (p: { playing?: boolean; time?: number; duration?: number }) => void;
}

const Ctx = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PlaySource | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pb, setPb] = useState({ playing: false, time: 0, duration: 0 });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const play = useCallback((s: PlaySource) => {
    setCurrent(s);
    setExpanded(true);
    setPb({ playing: false, time: 0, duration: s.duration || 0 });
  }, []);
  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);
  const value: PlayerState = {
    current,
    expanded,
    ...pb,
    play,
    expand: () => setExpanded(true),
    minimize: () => setExpanded(false),
    close: () => {
      videoRef.current?.pause();
      setCurrent(null);
      setExpanded(false);
    },
    toggle,
    videoRef,
    _setPlayback: (p) => setPb((o) => ({ ...o, ...p })),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const c = useContext(Ctx);
  if (!c) throw new Error('PlayerProvider missing');
  return c;
}
