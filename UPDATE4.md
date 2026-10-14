# UPDATE 4 — TorBox zips: browse, play, download and copy single videos

TorBox archives with hundreds of videos no longer need to be downloaded or unzipped. The server reads the zip's table of
contents with HTTP Range requests and streams one file at a time straight out of the archive.

## What changed
- **Reader** (`server/src/zipList.ts`): ZIP64 (archives over 4 GB, more than 65 535 files), any number of entries, store and
  deflate. The old reader skipped ZIP64 archives and stopped at 40 files. Listing a zip is now 2-3 requests instead of one per file,
  and the parsed index is cached. Seeking works for stored files natively; for deflated files the server skips ahead
  (the player still gets a normal `206`, jumping ahead just reads more of the archive).
- **TorBox page**: a zip shows an archive button. It opens a searchable list of every video in it, with play, download,
  multi-select, **Save to pCloud** and **Add to library**.
- **TorBox → pCloud, no local download**
  - a whole file: pCloud pulls it directly from TorBox (`downloadfileasync`), nothing passes through Pulse.
  - single files from inside a zip: streamed archive → server → pCloud (`uploadfile`), never written to disk, 2 at a time,
    with progress and cancel on the TorBox page. The save button now works (it was hidden because the client stubbed it out).
- **Library**: scenes imported from a zip get a download button; importing no longer caps at 8 zips / 40 videos per zip, and
  re-importing only adds what is missing.

## API
- `GET  /api/torbox/zip/entries?type&id&fileId`
- `GET  /api/torbox/zip/stream?type&id&fileId&entry[&download=1]` (Range supported)
- `POST /api/torbox/save-to-pcloud` `{ type, id, fileId, folderId, entries?: string[] | "videos", subfolder?, name? }`
- `GET /api/torbox/transfers`, `DELETE /api/torbox/transfers/:id`, `POST /api/torbox/transfers/{cancel-all,clear}`
- `POST /api/torbox/import` accepts `{ zip: { type, id, fileId, entries? } }`
- `GET /api/scenes/:id/proxy?download=1`

## Notes
- Copies in progress live in memory; restarting the server drops the queue (finished files stay in pCloud).
- `TORBOX_TRANSFER_CONCURRENCY` (default 2) controls how many zip files are copied at once.
- Encrypted zips and exotic compression methods are listed but cannot be played.

## Rebuild
```
npm run build
```
