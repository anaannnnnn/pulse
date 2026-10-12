import { nameKey } from '../db.js';
const nowIso = () => new Date().toISOString();
export function progressShape(p) {
    if (!p)
        return null;
    const percent = p.duration ? Math.min(100, Math.round((p.position / p.duration) * 1000) / 10) : 0;
    return { position: p.position, duration: p.duration ?? null, percent, completed: !!p.completed, updatedAt: p.updated_at };
}
/** Which provider a stored row came from (ThePornDB wins when both ids are known). */
const srcOf = (r) => (r.tpdb_id ? 'tpdb' : r.stash_id ? 'stashdb' : null);
export class Library {
    db;
    constructor(db) {
        this.db = db;
    }
    // ---------- serialization ----------
    cards(rows) {
        if (!rows.length)
            return [];
        const ids = rows.map((r) => r.id);
        const ph = ids.map(() => '?').join(',');
        const perf = this.db.prepare(`SELECT sp.scene_id, p.id, p.name, p.image, p.thumb, p.tpdb_id, p.stash_id FROM scene_performers sp JOIN performers p ON p.id=sp.performer_id WHERE sp.scene_id IN (${ph}) ORDER BY p.name`).all(...ids);
        const prog = this.db.prepare(`SELECT * FROM progress WHERE scene_id IN (${ph})`).all(...ids);
        const studios = this.db.prepare(`SELECT id, name FROM studios WHERE id IN (SELECT studio_id FROM scenes WHERE id IN (${ph}))`).all(...ids);
        const pm = new Map();
        for (const p of perf) {
            if (!pm.has(p.scene_id))
                pm.set(p.scene_id, []);
            pm.get(p.scene_id).push({ id: p.id, name: p.name, image: p.thumb || p.image, source: srcOf(p) });
        }
        const prm = new Map(prog.map((p) => [p.scene_id, p]));
        const sm = new Map(studios.map((s) => [s.id, s]));
        return rows.map((r) => {
            const parsed = r.parsed ? JSON.parse(r.parsed) : null;
            const thumb = r.has_thumb ? `/api/scenes/${r.id}/thumb` : null;
            return {
                id: r.id,
                title: r.title || parsed?.title || r.file_name,
                fileName: r.file_name, path: r.path, size: r.size || 0,
                duration: r.duration ?? null, width: r.width ?? null, height: r.height ?? null,
                date: r.date ?? null, year: r.date ? Number(String(r.date).slice(0, 4)) : parsed?.year ?? null,
                poster: r.poster || thumb, thumb: thumb || r.poster || null,
                studio: r.studio_id && sm.get(r.studio_id) ? { id: r.studio_id, name: sm.get(r.studio_id).name } : null,
                performers: pm.get(r.id) || [],
                matchStatus: r.match_status, matchConfidence: r.match_confidence ?? null, matchStrategy: r.match_strategy ?? null,
                matchSource: r.match_source ?? srcOf(r), matchError: r.match_error ?? null, matchErrorCode: r.match_error_code ?? null,
                favorite: !!r.favorite, watchlist: !!r.watchlist,
                progress: progressShape(prm.get(r.id)),
                addedAt: r.added_at, source: r.source,
            };
        });
    }
    sceneRow(id) { return this.db.prepare('SELECT * FROM scenes WHERE id=?').get(id); }
    detail(id) {
        const r = this.sceneRow(id);
        if (!r)
            return null;
        const [card] = this.cards([r]);
        const tags = this.db.prepare(`SELECT t.id, t.name, t.slug, t.tpdb_id, t.stash_id, (SELECT COUNT(*) FROM scene_tags x WHERE x.tag_id=t.id) sceneCount FROM scene_tags st JOIN tags t ON t.id=st.tag_id WHERE st.scene_id=? ORDER BY t.name`).all(id);
        const tagsOut = tags.map(({ tpdb_id, stash_id, ...t }) => ({ ...t, source: srcOf({ tpdb_id, stash_id }) }));
        const performers = this.performerList(`WHERE p.id IN (SELECT performer_id FROM scene_performers WHERE scene_id=?)`, [id], 'ORDER BY p.name', 200);
        const parsed = r.parsed ? JSON.parse(r.parsed) : null;
        return {
            ...card, description: r.description ?? null, tags: tagsOut, performers,
            stashdb: r.stash_id ? { id: r.stash_id, url: `https://stashdb.org/scenes/${r.stash_id}` } : null,
            tpdb: r.tpdb_id ? { id: r.tpdb_id, type: r.tpdb_type || 'scene', url: r.tpdb_url ?? null } : null,
            parsed,
            matchQuery: r.match_query ?? null, matchAlternatives: r.match_alts ? JSON.parse(r.match_alts) : [],
            pcloud: r.pcloud_file_id ? { fileId: r.pcloud_file_id, folderId: r.pcloud_folder_id, contentType: r.content_type ?? null } : null,
            torbox: r.torbox_id ? { type: r.torbox_type, id: r.torbox_id, fileId: r.torbox_file_id } : null,
            trailer: r.trailer ?? null, backdrop: r.backdrop || r.poster || null,
            subtitles: this.db.prepare('SELECT id, name, lang, format FROM subtitles WHERE scene_id=?').all(id),
        };
    }
    performerShape(p) {
        return { id: p.id, name: p.name, slug: p.slug, image: p.image, thumb: p.thumb, gender: p.gender, tpdbId: p.tpdb_id, stashId: p.stash_id ?? null, source: srcOf(p), sceneCount: p.sceneCount ?? 0, favorite: !!p.favorite };
    }
    performerList(where, params, order = 'ORDER BY p.name', limit = 40, offset = 0) {
        const rows = this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM scene_performers sp WHERE sp.performer_id=p.id) sceneCount FROM performers p ${where} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
        return rows.map((p) => this.performerShape(p));
    }
    performerDetail(id) {
        const p = this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM scene_performers sp WHERE sp.performer_id=p.id) sceneCount FROM performers p WHERE id=?`).get(id);
        if (!p)
            return null;
        const d = p.details ? JSON.parse(p.details) : {};
        const ex = d.extras || d.extra || {};
        const scenes = this.cards(this.db.prepare(`SELECT s.* FROM scenes s JOIN scene_performers sp ON sp.scene_id=s.id WHERE sp.performer_id=? ORDER BY COALESCE(s.date, s.added_at) DESC LIMIT 60`).all(id));
        const images = [];
        for (const x of d.posters || [])
            if (x?.url)
                images.push(x.url);
        if (d.image && !images.includes(d.image))
            images.unshift(d.image);
        return {
            ...this.performerShape(p),
            bio: d.bio || null, aliases: d.aliases || [], birthday: ex.birthday || null, birthplace: ex.birthplace || null,
            ethnicity: ex.ethnicity || null, nationality: ex.nationality || null, hairColor: ex.hair_colour || ex.haircolor || null,
            eyeColor: ex.eye_colour || null, height: ex.height || null, weight: ex.weight || null, measurements: ex.measurements || null,
            cupSize: ex.cupsize || null, tattoos: ex.tattoos || null, piercings: ex.piercings || null,
            careerStart: ex.career_start_year ? String(ex.career_start_year) : null, careerEnd: ex.career_end_year ? String(ex.career_end_year) : null,
            images: images.slice(0, 30), links: ex.links && typeof ex.links === 'object' && !Array.isArray(ex.links) ? ex.links : {},
            scenes,
        };
    }
    // ---------- query ----------
    query(q) {
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 40));
        const where = [];
        const params = [];
        const ids = (v) => String(v || '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (q.q) {
            const like = `%${String(q.q).trim()}%`;
            where.push(`(s.title LIKE ? OR s.file_name LIKE ? OR s.path LIKE ? OR s.studio_id IN (SELECT id FROM studios WHERE name LIKE ?)
        OR s.id IN (SELECT sp.scene_id FROM scene_performers sp JOIN performers p ON p.id=sp.performer_id WHERE p.name LIKE ?)
        OR s.id IN (SELECT st.scene_id FROM scene_tags st JOIN tags t ON t.id=st.tag_id WHERE t.name LIKE ?))`);
            params.push(like, like, like, like, like, like);
        }
        for (const t of ids(q.tags)) {
            where.push('s.id IN (SELECT scene_id FROM scene_tags WHERE tag_id=?)');
            params.push(t);
        }
        for (const p of ids(q.performers)) {
            where.push('s.id IN (SELECT scene_id FROM scene_performers WHERE performer_id=?)');
            params.push(p);
        }
        const st = ids(q.studio);
        if (st.length) {
            where.push(`s.studio_id IN (${st.map(() => '?').join(',')})`);
            params.push(...st);
        }
        if (q.year) {
            const m = String(q.year).match(/^(\d{4})(?:-(\d{4}))?$/);
            if (m) {
                where.push(`CAST(substr(s.date,1,4) AS INTEGER) BETWEEN ? AND ?`);
                params.push(Number(m[1]), Number(m[2] || m[1]));
            }
        }
        if (q.minDuration) {
            where.push('s.duration >= ?');
            params.push(Number(q.minDuration));
        }
        if (q.maxDuration) {
            where.push('s.duration <= ?');
            params.push(Number(q.maxDuration));
        }
        if (q.matched === 'true')
            where.push(`s.match_status IN ('matched','manual')`);
        if (q.matched === 'false')
            where.push(`s.match_status NOT IN ('matched','manual')`);
        if (q.status) {
            where.push('s.match_status=?');
            params.push(String(q.status));
        }
        if (q.favorites === 'true')
            where.push('s.favorite=1');
        if (q.watchlist === 'true')
            where.push('s.watchlist=1');
        if (q.source) {
            where.push('s.source=?');
            params.push(String(q.source));
        }
        if (q.watched === 'true')
            where.push('s.id IN (SELECT scene_id FROM progress WHERE completed=1)');
        if (q.watched === 'false')
            where.push('s.id NOT IN (SELECT scene_id FROM progress)');
        if (q.watched === 'inprogress')
            where.push('s.id IN (SELECT scene_id FROM progress WHERE completed=0)');
        const order = String(q.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const sorts = {
            added: `s.added_at ${order}, s.id ${order}`, date: `s.date IS NULL, s.date ${order}`, title: `COALESCE(s.title, s.file_name) COLLATE NOCASE ${order}`,
            duration: `s.duration IS NULL, s.duration ${order}`, size: `s.size ${order}`, random: 'RANDOM()',
            lastWatched: `(SELECT updated_at FROM progress WHERE scene_id=s.id) IS NULL, (SELECT updated_at FROM progress WHERE scene_id=s.id) ${order}`,
        };
        const sort = sorts[String(q.sort || 'added')] || sorts.added;
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = this.db.prepare(`SELECT COUNT(*) c FROM scenes s ${w}`).get(...params).c;
        const rows = this.db.prepare(`SELECT s.* FROM scenes s ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
        return { items: this.cards(rows), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }
    facets() {
        const years = this.db.prepare(`SELECT CAST(substr(date,1,4) AS INTEGER) year, COUNT(*) count FROM scenes WHERE date IS NOT NULL GROUP BY year ORDER BY year DESC`).all();
        const studios = this.studios({ pageSize: 200 }).items;
        const tags = this.tags({ pageSize: 100 }).items;
        const performers = this.performerList('', [], 'ORDER BY sceneCount DESC, p.name', 100);
        const durationMax = this.db.prepare('SELECT MAX(duration) m FROM scenes').get().m || 0;
        const t = this.db.prepare(`SELECT COUNT(*) scenes, SUM(match_status IN ('matched','manual')) matched, SUM(favorite) favorites FROM scenes`).get();
        return { years, studios, tags, performers, durationMax, totals: { scenes: t.scenes, matched: t.matched || 0, unmatched: t.scenes - (t.matched || 0), favorites: t.favorites || 0 } };
    }
    studios(q) {
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(200, Number(q.pageSize) || 40);
        const wh = [];
        const p = [];
        if (q.q) {
            wh.push('st.name LIKE ?');
            p.push(`%${q.q}%`);
        }
        if (q.favorites === 'true')
            wh.push('st.favorite=1');
        const w = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
        const total = this.db.prepare(`SELECT COUNT(*) c FROM studios st ${w}`).get(...p).c;
        const items = this.db.prepare(`SELECT st.*, (SELECT COUNT(*) FROM scenes s WHERE s.studio_id=st.id) sceneCount FROM studios st ${w} ORDER BY sceneCount DESC, st.name LIMIT ? OFFSET ?`).all(...p, pageSize, (page - 1) * pageSize)
            .map((s) => ({ id: s.id, name: s.name, slug: s.slug, logo: s.logo, parent: s.parent, tpdbId: s.tpdb_id, sceneCount: s.sceneCount, favorite: !!s.favorite, stashId: s.stash_id ?? null, source: srcOf(s) }));
        return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }
    tags(q) {
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(500, Number(q.pageSize) || 40);
        const w = q.q ? 'WHERE t.name LIKE ?' : '';
        const p = q.q ? [`%${q.q}%`] : [];
        const total = this.db.prepare(`SELECT COUNT(*) c FROM tags t ${w}`).get(...p).c;
        const items = this.db.prepare(`SELECT t.id, t.name, t.slug, t.tpdb_id, t.stash_id, (SELECT COUNT(*) FROM scene_tags st WHERE st.tag_id=t.id) sceneCount FROM tags t ${w} ORDER BY sceneCount DESC, t.name LIMIT ? OFFSET ?`).all(...p, pageSize, (page - 1) * pageSize).map(({ tpdb_id, stash_id, ...t }) => ({ ...t, source: srcOf({ tpdb_id, stash_id }) }));
        return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }
    performers(q) {
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(200, Number(q.pageSize) || 40);
        const where = [];
        const p = [];
        if (q.q) {
            where.push('p.name LIKE ?');
            p.push(`%${q.q}%`);
        }
        if (q.favorites === 'true')
            where.push('p.favorite=1');
        if (q.gender) {
            where.push('LOWER(p.gender)=LOWER(?)');
            p.push(q.gender);
        }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const ord = String(q.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const sort = q.sort === 'scenes' ? `ORDER BY sceneCount ${ord}, p.name` : q.sort === 'added' ? `ORDER BY p.added_at ${ord}` : `ORDER BY p.name COLLATE NOCASE ${q.order === 'desc' ? 'DESC' : 'ASC'}`;
        const total = this.db.prepare(`SELECT COUNT(*) c FROM performers p ${w}`).get(...p).c;
        return { items: this.performerList(w, p, sort, pageSize, (page - 1) * pageSize), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }
    // ---------- mutations ----------
    upsertStudio(name, extra = {}) {
        if (extra.tpdbId) {
            const r = this.db.prepare('SELECT id FROM studios WHERE tpdb_id=?').get(extra.tpdbId);
            if (r) {
                this.db.prepare('UPDATE studios SET name=?, slug=COALESCE(?,slug), logo=COALESCE(?,logo), parent=COALESCE(?,parent) WHERE id=?').run(name, extra.slug ?? null, extra.logo ?? null, extra.parent ?? null, r.id);
                return r.id;
            }
        }
        const key = nameKey(name);
        const r = this.db.prepare('SELECT id FROM studios WHERE name_key=?').get(key);
        if (r) {
            this.db.prepare('UPDATE studios SET tpdb_id=COALESCE(tpdb_id,?), slug=COALESCE(?,slug), logo=COALESCE(?,logo), parent=COALESCE(?,parent) WHERE id=?').run(extra.tpdbId ?? null, extra.slug ?? null, extra.logo ?? null, extra.parent ?? null, r.id);
            return r.id;
        }
        return Number(this.db.prepare('INSERT INTO studios(name, slug, tpdb_id, logo, parent, name_key) VALUES(?,?,?,?,?,?)').run(name, extra.slug ?? null, extra.tpdbId ?? null, extra.logo ?? null, extra.parent ?? null, key).lastInsertRowid);
    }
    upsertPerformer(name, extra = {}) {
        if (extra.tpdbId) {
            const r = this.db.prepare('SELECT id FROM performers WHERE tpdb_id=?').get(extra.tpdbId);
            if (r) {
                this.db.prepare('UPDATE performers SET image=COALESCE(?,image), thumb=COALESCE(?,thumb), gender=COALESCE(?,gender) WHERE id=?').run(extra.image ?? null, extra.thumb ?? null, extra.gender ?? null, r.id);
                return r.id;
            }
        }
        const key = nameKey(name);
        const r = this.db.prepare('SELECT id, tpdb_id FROM performers WHERE name_key=? AND (tpdb_id IS NULL OR ? IS NULL) LIMIT 1').get(key, extra.tpdbId ?? null);
        if (r) {
            this.db.prepare('UPDATE performers SET tpdb_id=COALESCE(tpdb_id,?), slug=COALESCE(?,slug), image=COALESCE(?,image), thumb=COALESCE(?,thumb), gender=COALESCE(?,gender), name=? WHERE id=?')
                .run(extra.tpdbId ?? null, extra.slug ?? null, extra.image ?? null, extra.thumb ?? null, extra.gender ?? null, name, r.id);
            return r.id;
        }
        return Number(this.db.prepare('INSERT INTO performers(name, slug, tpdb_id, image, thumb, gender, name_key) VALUES(?,?,?,?,?,?,?)').run(name, extra.slug ?? null, extra.tpdbId ?? null, extra.image ?? null, extra.thumb ?? null, extra.gender ?? null, key).lastInsertRowid);
    }
    upsertTag(name, tpdbId) {
        const key = nameKey(name);
        const r = this.db.prepare('SELECT id FROM tags WHERE name_key=?').get(key);
        if (r)
            return r.id;
        return Number(this.db.prepare('INSERT INTO tags(name, tpdb_id, name_key) VALUES(?,?,?)').run(name, tpdbId ?? null, key).lastInsertRowid);
    }
    setScenePerformers(sceneId, ids) {
        this.db.prepare('DELETE FROM scene_performers WHERE scene_id=?').run(sceneId);
        const ins = this.db.prepare('INSERT OR IGNORE INTO scene_performers(scene_id, performer_id) VALUES(?,?)');
        for (const id of ids)
            ins.run(sceneId, id);
    }
    setSceneTags(sceneId, ids) {
        this.db.prepare('DELETE FROM scene_tags WHERE scene_id=?').run(sceneId);
        const ins = this.db.prepare('INSERT OR IGNORE INTO scene_tags(scene_id, tag_id) VALUES(?,?)');
        for (const id of ids)
            ins.run(sceneId, id);
    }
    cleanupOrphans() {
        this.db.exec(`DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM scene_tags);
      DELETE FROM studios WHERE id NOT IN (SELECT studio_id FROM scenes WHERE studio_id IS NOT NULL);
      DELETE FROM performers WHERE favorite=0 AND id NOT IN (SELECT performer_id FROM scene_performers);`);
    }
    setProgress(sceneId, position, duration, completed) {
        const prev = this.db.prepare('SELECT * FROM progress WHERE scene_id=?').get(sceneId);
        const scene = this.sceneRow(sceneId);
        const dur = duration ?? prev?.duration ?? scene?.duration ?? null;
        const done = completed ?? (dur ? position / dur >= 0.92 : false);
        this.db.prepare(`INSERT INTO progress(scene_id, position, duration, completed, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(scene_id) DO UPDATE SET position=excluded.position, duration=excluded.duration, completed=excluded.completed, updated_at=excluded.updated_at`)
            .run(sceneId, Math.max(0, position), dur, done ? 1 : 0, nowIso());
        if (dur && !scene?.duration)
            this.db.prepare('UPDATE scenes SET duration=? WHERE id=?').run(dur, sceneId);
        return progressShape(this.db.prepare('SELECT * FROM progress WHERE scene_id=?').get(sceneId));
    }
    continueWatching(limit = 20) {
        return this.cards(this.db.prepare(`SELECT s.* FROM scenes s JOIN progress p ON p.scene_id=s.id WHERE p.completed=0 AND p.position > 5 ORDER BY p.updated_at DESC LIMIT ?`).all(limit));
    }
    recentlyAdded(limit = 20) {
        return this.cards(this.db.prepare(`SELECT * FROM scenes ORDER BY added_at DESC, id DESC LIMIT ?`).all(limit));
    }
    home() {
        const rails = [];
        const cont = this.continueWatching(20);
        if (cont.length)
            rails.push({ id: 'continue', title: 'Continue Watching', kind: 'scenes', items: cont });
        const recent = this.recentlyAdded(20);
        if (recent.length)
            rails.push({ id: 'recent', title: 'Recently Added', kind: 'scenes', items: recent });
        const fav = this.cards(this.db.prepare('SELECT * FROM scenes WHERE favorite=1 ORDER BY updated_at DESC LIMIT 20').all());
        if (fav.length)
            rails.push({ id: 'favorites', title: 'Your Favorites', kind: 'scenes', items: fav });
        const perfs = this.performerList('WHERE (SELECT COUNT(*) FROM scene_performers sp WHERE sp.performer_id=p.id) > 0', [], 'ORDER BY p.favorite DESC, sceneCount DESC', 20);
        if (perfs.length)
            rails.push({ id: 'top-performers', title: 'Top Performers', kind: 'performers', items: perfs });
        const topStudios = this.db.prepare(`SELECT st.id, st.name, COUNT(s.id) c FROM studios st JOIN scenes s ON s.studio_id=st.id GROUP BY st.id HAVING c >= 2 ORDER BY c DESC LIMIT 3`).all();
        for (const st of topStudios)
            rails.push({ id: `studio-${st.id}`, title: st.name, kind: 'scenes', items: this.cards(this.db.prepare('SELECT * FROM scenes WHERE studio_id=? ORDER BY COALESCE(date, added_at) DESC LIMIT 20').all(st.id)) });
        const topTags = this.db.prepare(`SELECT t.id, t.name, COUNT(*) c FROM tags t JOIN scene_tags st ON st.tag_id=t.id GROUP BY t.id HAVING c >= 3 ORDER BY c DESC LIMIT 3`).all();
        for (const t of topTags)
            rails.push({ id: `tag-${t.id}`, title: t.name, kind: 'scenes', items: this.cards(this.db.prepare('SELECT s.* FROM scenes s JOIN scene_tags st ON st.scene_id=s.id WHERE st.tag_id=? ORDER BY RANDOM() LIMIT 20').all(t.id)) });
        const unwatched = this.cards(this.db.prepare('SELECT * FROM scenes WHERE id NOT IN (SELECT scene_id FROM progress) ORDER BY RANDOM() LIMIT 20').all());
        if (unwatched.length)
            rails.push({ id: 'unwatched', title: 'Discover', kind: 'scenes', items: unwatched });
        const hero = this.cards(this.db.prepare(`SELECT * FROM scenes WHERE backdrop IS NOT NULL OR poster IS NOT NULL ORDER BY (match_status='matched') DESC, RANDOM() LIMIT 5`).all());
        return { hero: hero.length ? hero : recent.slice(0, 5), rails };
    }
}
