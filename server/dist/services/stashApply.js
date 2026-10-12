import { nameKey } from '../db.js';
const nowIso = () => new Date().toISOString();
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
/** Fills gaps in `base` with `add` (existing values win); unions aliases / posters / links. */
export function mergeDetails(base, add) {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(add || {})) {
        if (k === 'extras' || k === 'extra')
            continue;
        if (k === 'aliases')
            out.aliases = [...new Set([...(out.aliases || []), ...(v || [])])];
        else if (k === 'posters') {
            const seen = new Set((out.posters || []).map((p) => p?.url));
            out.posters = [...(out.posters || []), ...(v || []).filter((p) => p?.url && !seen.has(p.url))];
        }
        else if (empty(out[k]))
            out[k] = v;
    }
    const be = { ...(base?.extras || base?.extra || {}) };
    const ae = add?.extras || {};
    for (const [k, v] of Object.entries(ae)) {
        if (k === 'links')
            be.links = { ...v, ...(be.links && typeof be.links === 'object' && !Array.isArray(be.links) ? be.links : {}) };
        else if (empty(be[k]))
            be[k] = v;
    }
    out.extras = be;
    if (add?._source && !out._source)
        out._source = add._source;
    return out;
}
export function upsertStashStudio(db, lib, s) {
    if (s.id) {
        const r = db.prepare('SELECT id FROM studios WHERE stash_id=?').get(s.id);
        if (r) {
            db.prepare('UPDATE studios SET logo=COALESCE(logo,?), parent=COALESCE(parent,?) WHERE id=?').run(s.logo, s.parent, r.id);
            return r.id;
        }
    }
    const id = lib.upsertStudio(s.name, { parent: s.parent, logo: s.logo });
    if (s.id)
        db.prepare('UPDATE studios SET stash_id=COALESCE(stash_id,?) WHERE id=?').run(s.id, id);
    return id;
}
export function upsertStashPerformer(db, p) {
    let row = db.prepare('SELECT id, details FROM performers WHERE stash_id=?').get(p.id);
    if (!row)
        row = db.prepare('SELECT id, details FROM performers WHERE name_key=? ORDER BY (tpdb_id IS NOT NULL) DESC LIMIT 1').get(nameKey(p.name));
    if (!row && p.aliases.length) {
        // an existing performer known under one of this performer's aliases
        for (const a of p.aliases) {
            const k = nameKey(a);
            if (k.length < 5)
                continue;
            row = db.prepare('SELECT id, details FROM performers WHERE name_key=? LIMIT 1').get(k);
            if (row)
                break;
        }
    }
    const prev = row?.details ? JSON.parse(row.details) : null;
    const details = JSON.stringify(prev ? mergeDetails(prev, p.details) : p.details);
    if (row) {
        db.prepare('UPDATE performers SET stash_id=COALESCE(stash_id,?), image=COALESCE(image,?), thumb=COALESCE(thumb,?), gender=COALESCE(gender,?), details=?, details_at=? WHERE id=?')
            .run(p.id, p.image, p.thumb, p.gender, details, nowIso(), row.id);
        return row.id;
    }
    return Number(db.prepare('INSERT INTO performers(name, image, thumb, gender, stash_id, name_key, details, details_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(p.name, p.image, p.thumb, p.gender, p.id, nameKey(p.name), details, nowIso()).lastInsertRowid);
}
export function upsertStashTag(db, lib, t) {
    const id = lib.upsertTag(t.name, null);
    if (t.id)
        db.prepare('UPDATE tags SET stash_id=COALESCE(stash_id,?) WHERE id=?').run(t.id, id);
    return id;
}
/** Applies a StashDB scene to a library scene. Returns the normalised scene. */
export async function applyStashScene(db, lib, stash, sceneId, stashId, o = {}) {
    const x = await stash.scene(stashId);
    if (!x)
        throw Object.assign(new Error('StashDB scene not found'), { statusCode: 404, code: 'not_found' });
    const tpdbAlso = o.alsoOn?.find((a) => a.source === 'tpdb')?.id ?? null;
    db.transaction(() => {
        const studioId = x.studio ? upsertStashStudio(db, lib, x.studio) : null;
        const perfIds = x.performers.map((p) => upsertStashPerformer(db, p));
        const tagIds = x.tags.map((t) => upsertStashTag(db, lib, t));
        db.prepare(`UPDATE scenes SET title=?, date=?, description=?, studio_id=?, stash_id=?, match_source='stashdb', tpdb_id=?, tpdb_type=?, tpdb_url=NULL,
      poster=?, backdrop=?, trailer=NULL, match_status=?, match_confidence=?, match_strategy=?, duration=COALESCE(duration, ?), updated_at=? WHERE id=?`).run(x.title || null, x.date, x.description, studioId, x.id, tpdbAlso, tpdbAlso ? 'scene' : null, x.poster, x.backdrop || x.poster, o.manual ? 'manual' : 'matched', o.confidence ?? null, o.manual ? 'manual' : o.strategy ?? null, x.duration, nowIso(), sceneId);
        lib.setScenePerformers(sceneId, perfIds);
        lib.setSceneTags(sceneId, tagIds);
    })();
    return x;
}
/** After a ThePornDB apply: record that this scene is a TPDB match and keep the StashDB twin's id when both providers agreed. */
export function stampTpdbSource(db, sceneId, alsoOn) {
    db.prepare(`UPDATE scenes SET match_source='tpdb', stash_id=? WHERE id=?`).run(alsoOn?.find((a) => a.source === 'stashdb')?.id ?? null, sceneId);
}
/** Refreshes a performer from StashDB (by stored stash_id, else best name/alias match). Existing values win; gaps are filled. */
export async function refreshStashPerformer(db, stash, performerId) {
    const row = db.prepare('SELECT * FROM performers WHERE id=?').get(performerId);
    if (!row)
        return null;
    let found = null;
    if (row.stash_id)
        found = await stash.performer(row.stash_id);
    if (!found) {
        const list = await stash.searchPerformers(row.name, 8);
        const k = nameKey(row.name);
        found = list.find((p) => nameKey(p.name) === k) || list.find((p) => p.aliases.some((a) => nameKey(a) === k)) || null;
    }
    if (!found)
        return null;
    const merged = mergeDetails(row.details ? JSON.parse(row.details) : null, found.details);
    db.prepare('UPDATE performers SET stash_id=?, image=COALESCE(image,?), thumb=COALESCE(thumb,?), gender=COALESCE(gender,?), details=?, details_at=? WHERE id=?')
        .run(found.id, found.image, found.thumb, found.gender, JSON.stringify(merged), nowIso(), performerId);
    return found;
}
