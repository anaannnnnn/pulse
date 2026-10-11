# Pulse update 5: fixes the "server is extremely slow" problem

## What was wrong
1. `data\pulse.db` had grown to 2.3 GB: 2.2 GB of it was a table (`http_cache`) holding every ThePornDB/StashDB answer (up to 4 MB each). Maintenance queries
   ("Retry matching", start of a matching run) scanned all of it on the single Node thread (9-10 s freezes), and every cache write stringified/wrote megabytes synchronously.
2. The tag / studio / performer "scene count" lookups had no index, so Home, Library filters and the facets call each scanned whole tables (1-2 s of pure CPU each).
   Node can only do one thing at a time, so every other request (even /api/health) queued behind them: 10-50 s page loads.
3. The matcher re-scored every candidate again and again (and re-normalised the same strings thousands of times), starving the web requests.

## What changed
* Provider answers now live in their own compressed file `data\cache.db` (size-capped at 512 MB, pruned in small chunks, never blocks). `pulse.db` is back to ~13 MB.
  The first start after this update drops the old table and compacts `pulse.db` once (about 10-60 s, a log line says so). Old cached answers are discarded; they are re-fetched on demand.
* New indexes for tag/performer/studio counts, favourites, dates. Lists (library, performers, studios, tags, facets, home) are served from a short read cache that any write invalidates.
* Gzip/Brotli for JSON and the web app, ETag/304 for the web app and thumbnails (30 days, immutable), thumbnails cached on disk + in memory, one pCloud fetch per thumbnail (max 6 at once).
* Matching is about 3-5x faster per CPU second and yields to web requests between steps.
* `/api/health` never touches the database and now also reports event-loop delay, cache stats and slow-request counts.
* Requests slower than 500 ms and event-loop stalls longer than 250 ms are logged ("slow request ..." / "event loop was blocked ...") in `C:\pulse-service\server.log`. The noisy per-request log lines are off.

## Install
1. Stop the server (scheduled task "Pulse Server").
2. Extract this archive over your `pulse-app\pulse-app` folder (overwrite). `.env` and data are not in it.
3. In `server`: `npm run build` (no new packages), then start the task again.
4. First start: wait for "database compacted" in the log, then open the app.
