import type { Item, TorboxFile, TorboxItem } from '../api';
import type { PlaySource } from '../player/PlayerContext';

export function itemSource(it: Item, queue: Item[] = []): PlaySource {
  return {
    key: it.id,
    kind: 'pcloud',
    title: it.title,
    subtitle: [it.scene?.site?.name, it.scene?.performers.slice(0, 2).map((p) => p.name).join(', ')].filter(Boolean).join(' · ') || undefined,
    poster: it.scene?.background || it.scene?.poster || null,
    fileId: it.fileId,
    ext: it.name.split('.').pop()?.toLowerCase(),
    subtitles: it.subtitles,
    itemId: it.id,
    duration: it.duration,
    queue: queue.filter((q) => q.id !== it.id).slice(0, 20).map((q) => itemSource(q)),
  };
}

export function torboxSource(t: TorboxItem, f: TorboxFile): PlaySource {
  return {
    key: `tb:${t.kind}:${t.id}:${f.id}`,
    kind: 'torbox',
    title: f.name,
    subtitle: t.name,
    poster: null,
    ext: f.name.split('.').pop()?.toLowerCase(),
    tb: { kind: t.kind, id: t.id, fileId: f.id },
  };
}

/** A single video inside a TorBox zip (streamed out of the archive, nothing is extracted). */
export function zipEntrySource(t: TorboxItem, zip: TorboxFile, entry: { name: string; shortName: string }): PlaySource {
  return {
    key: `tb:${t.kind}:${t.id}:${zip.id}:${entry.name}`,
    kind: 'torbox',
    title: entry.shortName,
    subtitle: zip.name,
    poster: null,
    ext: entry.shortName.split('.').pop()?.toLowerCase(),
    tb: { kind: t.kind, id: t.id, fileId: zip.id, entry: entry.name },
  };
}
