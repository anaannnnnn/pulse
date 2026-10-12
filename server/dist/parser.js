export const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'm4v', 'webm', 'ts', 'wmv', 'flv', 'mpg', 'mpeg'];
export const SUB_EXTS = ['srt', 'vtt'];
/** Extensions stripped from names before parsing (superset of VIDEO_EXTS). */
const STRIP_EXTS = new Set([...VIDEO_EXTS, ...SUB_EXTS, 'm2ts', 'mts', 'vob', '3gp', 'rmvb', 'asf', 'ogv', 'divx', 'nfo', 'part', 'm4p']);
const JUNK = new Set([
    'xxx', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'm4v', 'web', 'webrip', 'webdl', 'hdrip', 'bdrip', 'brrip', 'bluray', 'dvdrip', 'hdtv', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc',
    'aac', 'ac3', 'dts', 'mp3', 'ktr', 'wrb', 'rarbg', 'prt', 'xleech', 'gush', 'iak', 'xc', 'sd', 'hd', 'fhd', 'uhd', 'hdr', 'sdr', '60fps', '30fps', '24fps', '25fps',
    '10bit', '8bit', 'hi10p', 'split', 'remastered', 'internal', 'repack', 'proper', 'nf', 'n1c', 'p2p', 'xvid', 'divx', 'mpeg4', 'sample', 'dl', 'rip',
]);
const RES_RE = /(?<![A-Za-z0-9])(?:(4320|2160|1440|1080|720|576|540|480|360)[pi](?:\d{2,3})?|(4k|8k|uhd|fhd)|\d{3,4}x(\d{3,4}))(?![A-Za-z0-9])/i;
const RES_TOKEN_RE = new RegExp(`^${RES_RE.source}$`, 'i');
const BITRATE_RE = /^(?:\d{3,5}(?:kbps|kb\/s|kbit|k)|\d+(?:\.\d+)?(?:mbps|mb\/s)|\d{2,3}fps)$/i;
const GENERIC_FOLDERS = /^(videos?|movies?|downloads?|completed|media|porn|xxx|adult|new|misc|clips?|scenes?|pcloud|my pcloud|torbox|root|stuff|temp|tmp|files?|data|storage|private|hd|sd|unsorted|sorted|library|content|vids?|films?|other|others|backup|folder|untitled folder|incoming|inbox|archive|favorites?|keep|watch|watched|to watch|\d+|disk\s*\d*|usb|drive)$/i;
const SMALL_WORDS = new Set(['at', 'in', 'on', 'of', 'to', 'my', 'me', 'it', 'is', 'an', 'as', 'by', 'up', 'do', 'go', 'he', 'we', 'no', 'so', 'or', 'us', 'if', 'a', 'i']);
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
/** nameKey-style keys of common studios/networks so a bare leading token can be recognised as a studio. */
const BUILTIN_STUDIOS = new Set(`brazzers realitykings naughtyamerica bangbros blacked blackedraw tushy tushyraw vixen mofos digitalplayground twistys teamskeet nubiles nubilefilms passionhd evilangel julesjordan adulttime fakehub faketaxi fakehostel publicagent porncz fantasyhd exxxtrasmall castingcouch-x castingcouchx 21sextury 21naturals analvids legalporno hardx darkx lesbianx eroticax allherluv girlsway sweetsinner sexart metart x-art xart hegre femjoy playboyplus hotwifexxx clubsevenfour mylf momsteachsex familystrokes sislovesme shoplyfter lethalhardcore tonightsgirlfriend wankz sexymomma pervmom perfectgonzo spizoo cumlouder hdpov puretaboo nympho nubilesporn povd povmasters teenmegaworld18 brattysis hotandmean vrbangers wankzvr naughtyamericavr czechvr virtualrealporn badoinkvr baberoticavr 5kporn passion-hd bellesa bellesahouse dorcel dorcelclub jamesdeen sexyhub fitnessrooms spyfam gotfilled brazzersexxtra bangbrosnetwork bangrealteens bangpov monstersofcock bigtitsatwork bigtitsroundasses brazzersnetwork milfhunter pornfidelity naughtyoffice naughtyathome latinaabuse seemomsuck`.split(/\s+/).map((s) => s.replace(/[^a-z0-9]/g, '')));
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function validDate(y, m, d) {
    return y >= 1970 && y <= new Date().getUTCFullYear() + 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}
const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const key = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
function titleCase(s) {
    return s.replace(/\b([a-z])([a-z']*)/g, (_, a, b) => a.toUpperCase() + b);
}
/** "BigTitsAtWork" -> "Big Tits At Work"; leaves "McKenzie", "BraZZers", "DeVille" alone. */
export function splitCamel(token) {
    if (token.length < 6 || !/[a-z][A-Z][a-z]/.test(token))
        return token;
    const parts = token.split(/(?<=[a-z])(?=[A-Z][a-z])/);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        let p = parts[i];
        while (i < parts.length - 1 && p.length < 3 && !SMALL_WORDS.has(p.toLowerCase()))
            p += parts[++i];
        out.push(p);
    }
    if (out.length > 1 && out[out.length - 1].length < 3 && !SMALL_WORDS.has(out[out.length - 1].toLowerCase())) {
        const l = out.pop();
        out[out.length - 1] += l;
    }
    return out.join(' ');
}
export function splitPerformers(s) {
    return s
        .split(/\s*(?:,|&|\+|\band\b|\bft\b\.?|\bfeat\b\.?|\bfeaturing\b|\bx\b(?=\s))\s*/i)
        .map((p) => p.replace(/[()[\]]/g, '').trim())
        .filter((p) => p.length > 1 && !/^\d+$/.test(p));
}
function isJunkToken(t) {
    t = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const l = t.toLowerCase().replace(/[^a-z0-9/.]/g, '');
    if (!l)
        return false; // pure punctuation such as "-" is a segment separator, not junk
    return JUNK.has(l) || RES_TOKEN_RE.test(t) || BITRATE_RE.test(l);
}
function cleanTokens(s) {
    return s
        .split(/\s+/)
        .filter((t) => t && !isJunkToken(t))
        .join(' ')
        .replace(/\s*-\s*[A-Za-z0-9]+$/, (m) => (/^\s*-\s*(ktr|wrb|xleech|gush|prt|iak|rarbg|xc|p2p|n1c)$/i.test(m) ? '' : m))
        .trim();
}
/** Junk phrases that span separators ("WEB-DL", "H.264", "Full HD", "Blu-Ray") removed before tokenising. */
function stripJunkPhrases(s) {
    return s
        // release-group suffix after a technical token: "…XXX.1080p.MP4-KTR", "…x264-GRP", "…10bit-GRP"
        .replace(/((?:^|[ ._-])(?:xxx|mp4|mkv|avi|\d{3,4}p|[hx][ ._-]?26[45]|hevc|aac|ac3|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|\d{1,2}bit|webrip|hdrip|bdrip|sd|hd)[ ._]*)-[A-Za-z0-9]{2,12}\s*$/i, '$1')
        .replace(/(?<![A-Za-z0-9])(?:web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|full[ ._-]?hd|[hx][ ._-]?26[45]|dd[p+]?[ ._]?[257][ ._]?[01]|hd[ ._-]?rip|dvd[ ._-]?rip|\d{1,2}[ ._-]?bit)(?![A-Za-z0-9])/gi, ' ')
        .replace(/(?<![A-Za-z0-9])\d{3,5}\s?(?:kbps|kb\/s|kbit)(?![A-Za-z0-9])|(?<![A-Za-z0-9])\d+(?:\.\d+)?\s?(?:mbps|mb\/s)(?![A-Za-z0-9])/gi, ' ');
}
/** Looks like a single studio token, e.g. "Brazzers", "BangBros", "Vixen", "TeamSkeet", "brazzers.com" */
function looksLikeStudio(s) {
    const t = s.trim();
    return /^[A-Za-z0-9][A-Za-z0-9!']*(\.(com|net|xxx))?$/.test(t) && !/^\d+$/.test(t);
}
/** Finds the first plausible date: YYYY-MM-DD, YYYY.MM.DD, DD.MM.YYYY, YYYYMMDD, YY.MM.DD, "12 May 2021", "May 12, 2021". */
export function extractDate(s) {
    let m;
    const hit = (y, mo, d, mm, format) => validDate(y, mo, d) ? { date: isoDate(y, mo, d), year: y, index: mm.index, length: mm[0].length, format } : null;
    if ((m = /(?<![0-9])((?:19|20)\d\d)[-._ /](\d\d)[-._ /](\d\d)(?![0-9])/.exec(s))) {
        const h = hit(+m[1], +m[2], +m[3], m, 'YYYY-MM-DD');
        if (h)
            return h;
    }
    if ((m = /(?<![0-9])(\d\d)[-._ /](\d\d)[-._ /]((?:19|20)\d\d)(?![0-9])/.exec(s))) {
        const a = +m[1], b = +m[2], y = +m[3];
        const h = (a > 12 ? hit(y, b, a, m, 'DD.MM.YYYY') : b > 12 ? hit(y, a, b, m, 'MM.DD.YYYY') : hit(y, b, a, m, 'DD.MM.YYYY') || hit(y, a, b, m, 'MM.DD.YYYY'));
        if (h)
            return h;
    }
    if ((m = /(?<![0-9])((?:19|20)\d\d)(\d\d)(\d\d)(?![0-9])/.exec(s))) {
        const h = hit(+m[1], +m[2], +m[3], m, 'YYYYMMDD');
        if (h)
            return h;
    }
    if ((m = /(?<![0-9])(\d\d)[-._](\d\d)[-._](\d\d)(?![0-9])/.exec(s))) {
        const h = hit(2000 + +m[1], +m[2], +m[3], m, 'YY.MM.DD') || hit(2000 + +m[3], +m[2], +m[1], m, 'DD.MM.YY');
        if (h)
            return h;
    }
    const mon = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    if ((m = new RegExp(`(?<![0-9A-Za-z])(\\d{1,2})(?:st|nd|rd|th)?[ ._-]${mon}[ ._,-]+((?:19|20)\\d\\d)(?![0-9])`, 'i').exec(s))) {
        const h = hit(+m[3], MONTHS[m[2].toLowerCase()], +m[1], m, 'DD Mon YYYY');
        if (h)
            return h;
    }
    if ((m = new RegExp(`(?<![A-Za-z])${mon}[ ._-]+(\\d{1,2})(?:st|nd|rd|th)?[ ._,-]+((?:19|20)\\d\\d)(?![0-9])`, 'i').exec(s))) {
        const h = hit(+m[3], MONTHS[m[1].toLowerCase()], +m[2], m, 'Mon DD YYYY');
        if (h)
            return h;
    }
    return null;
}
export function isKnownStudioKey(k, extra) { return BUILTIN_STUDIOS.has(k) || !!extra?.has(k); }
export function parseFilename(fileName, folderPath, opts = {}) {
    const extra = opts.knownStudios ? new Set([...opts.knownStudios].map(key)) : undefined;
    let base = String(fileName).replace(/^.*[\\/]/, '').trim();
    const extMatch = base.match(/\.([A-Za-z0-9]{2,5})$/);
    let extension = '';
    if (extMatch && STRIP_EXTS.has(extMatch[1].toLowerCase())) {
        extension = extMatch[1].toLowerCase();
        base = base.slice(0, -extMatch[0].length);
    }
    else if (extMatch && !/\s/.test(base) && /^[A-Za-z]{2,4}$/.test(extMatch[1]) && /[._-].*\.[A-Za-z]{2,4}$/.test(base) && false)
        extension = '';
    // duplicate/copy suffixes: "name (1)", "name - Copy", "name copy 2", "name [2]"
    for (let i = 0; i < 3; i++) {
        const b2 = base.replace(/\s*\(\d{1,2}\)\s*$/, '').replace(/[\s._-]*[[(]?copy(?:[\s._-]*\d{1,2})?[\])]?\s*$/i, '').replace(/\s+\[\d{1,2}\]\s*$/, '');
        if (b2 === base)
            break;
        base = b2;
    }
    base = base.trim();
    const out = { studio: null, date: null, year: null, title: null, performers: [], resolution: null, extension, jav: null, query: '', words: [], cleanTitle: '', studioHints: [], folderHints: [], dateFormat: null };
    const res = base.match(RES_RE);
    if (res) {
        const r = (res[1] ? res[1] + 'p' : res[2] ? res[2] : res[3] ? res[3] + 'p' : '').toLowerCase();
        out.resolution = r === '4k' || r === 'uhd' ? '2160p' : r === '8k' ? '4320p' : r === 'fhd' ? '1080p' : r || null;
    }
    // JAV codes: SSIS-123, ABP-001, FC2-PPV-123456
    const jav = base.match(/(?:^|[^A-Za-z0-9])(FC2-?PPV-?\d{5,8}|[A-Za-z]{2,6}[-_ ]\d{2,5})(?:[^A-Za-z0-9]|$)/);
    if (jav && !/^(?:19|20)\d\d-/.test(jav[1]) && (/^FC2/i.test(jav[1]) || /-/.test(jav[1]) || (/^[A-Z]{2,6}[_ ]\d{3,5}$/.test(jav[1]) && !RES_TOKEN_RE.test(jav[1].replace(/[_ ]/g, ''))))
        && !/^(?:part|pt|ep|episode|scene|cd|disc|vol|volume|no|v|s|e|x|h|ac|hd|sd|mp|dd|img|dsc|dscn|dscf|mov|vid|video|pxl|mvi|gopr|gp|wp|sam|dji|clip|screen|rec|movie|cam|trk|vts|track|file|new|untitled|copy)[-_ ]?\d+$/i.test(jav[1]) && !/^\d+p$/i.test(jav[1])) {
        out.jav = jav[1].replace(/[_ ]/g, '-').toUpperCase();
    }
    if (!out.jav) {
        const c = base.match(/^\s*([A-Za-z]{3,5})(\d{3,4})(?=[^A-Za-z0-9]|$)/);
        if (c && !/^(?:x|h|mp|ac|hd|sd|dd|part|pt|ep|cd|vol|disc|scene|vid|video|img|mov|dsc|dscn|clip|file|pxl|mvi|gopr|dji|screen|rec|movie|cam|trk|new|untitled|copy|take)$/i.test(c[1]) && !/^(?:mp|ac|hd|sd)\d/i.test(c[0]) && !/^(?:19|20)\d\d$/.test(c[2]))
            out.jav = `${c[1].toUpperCase()}-${c[2]}`;
    }
    let s = base;
    // site tags: www.site.com / [site.com] / site.com -> studio hint, removed from text
    const siteTags = [];
    s = s.replace(/[[({]?\s*(?:www\.)?([A-Za-z0-9][A-Za-z0-9-]{1,30})\.(com|net|org|xxx|tv|to|cc|me|co|club|site|biz)\b\s*[\])}]?/gi, (m0, name, tld, off, whole) => {
        const hasWww = /www\./i.test(m0), bracketed = /^[[({]/.test(m0.trim()) && /[\])}]$/.test(m0.trim());
        const plain = /^(com|net|org|tv)$/i.test(tld);
        const after = whole[off + m0.length];
        if (!(hasWww || bracketed || (plain && (!after || /[\s._-]/.test(after)))))
            return m0;
        if (!hasWww && !bracketed && off > 0 && !/[\s._\-[(]/.test(whole[off - 1] || ' '))
            return m0;
        siteTags.push(name.replace(/^www\./i, ''));
        return ' ';
    });
    // brackets/parens: studio-ish -> hint; junk/year dropped; other text keeps its words
    s = s.replace(/[[({]\s*([^\])}]{0,60}?)\s*[\])}]/g, (m0, inner, off, whole) => {
        const t = inner.trim();
        if (!t)
            return ' ';
        if (off > 0 && !/[\s\-([]/.test(whole[off - 1]) && /[A-Za-z0-9]/.test(whole[off - 1]) && m0.startsWith('['))
            return ' '; // "PRT[XvX]" group tag glued to a token
        if (/^(19|20)\d\d$/.test(t)) {
            if (!out.year)
                out.year = Number(t);
            return ' ';
        }
        if (/^(?:19|20)\d\d[-._]\d\d[-._]\d\d$/.test(t) || /^\d\d[-._]\d\d[-._](?:\d\d|\d{4})$/.test(t))
            return ` ${t} `;
        const toks = t.split(/[\s._-]+/).filter(Boolean);
        if (toks.every((x) => isJunkToken(x) || /^[a-f0-9]{8}$/i.test(x) || /^\d{1,3}$/.test(x) && false))
            return ' ';
        if (/^[A-Za-z0-9][A-Za-z0-9 .!'&-]{1,40}$/.test(t) && toks.length <= 2 && !out.studioHints.length && m0.startsWith('[') && (off <= 2 || /\s[-–—]\s$/.test(whole.slice(Math.max(0, off - 4), off)))) {
            out.studioHints.push(t.replace(/\.(com|net|xxx)$/i, ''));
            return ' ';
        }
        return ` ${t} `;
    });
    // round-bracket studio e.g. "(Brazzers.com)" already handled by site-tag step; (Brazzers) left as words.
    // Dates (before separators are flattened so 21.05.12 and 2021-05-12 are still intact)
    let dateIdx = -1;
    let dm = extractDate(s);
    if (!dm) {
        const c = /^([A-Za-z][A-Za-z0-9]*)[ ._-](\d{2})(\d{2})(\d{2})(?=[ ._-]|$)/.exec(s.trim());
        if (c && (isKnownStudioKey(key(c[1]), extra)) && validDate(2000 + +c[2], +c[3], +c[4])) {
            dm = { date: isoDate(2000 + +c[2], +c[3], +c[4]), year: 2000 + +c[2], index: s.indexOf(c[0]) + c[1].length + 1, length: 6, format: 'YYMMDD' };
        }
    }
    let beforeDate = '';
    if (dm) {
        out.date = dm.date;
        out.year = dm.year;
        out.dateFormat = dm.format;
        dateIdx = dm.index;
        beforeDate = s.slice(0, dm.index);
        s = s.slice(0, dm.index).replace(/[._]+$/, '') + ' ' + s.slice(dm.index + dm.length).replace(/^[._]+/, '');
    }
    if (!out.year) {
        const y = s.match(/\(((?:19|20)\d\d)\)/);
        if (y) {
            out.year = Number(y[1]);
            s = s.replace(y[0], ' ');
        }
    }
    if (out.jav)
        s = s.replace(new RegExp(out.jav.replace(/-/g, '[-_ ]?'), 'i'), ' ');
    s = stripJunkPhrases(s);
    const hadSpace = /\s/.test(base);
    s = s.replace(/_+/g, ' ').replace(/\++/g, ' ').replace(/(?:^|\s)[.]+|[.]+(?=\s|$)/g, ' ');
    s = s.replace(/(?<=\S)\.(?=\S)/g, ' ');
    if (!/\s[-–—|~]\s/.test(s) && !hadSpace)
        s = s.replace(/(?<=\S)-(?=\S)/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    beforeDate = beforeDate.replace(/[[\](){}]/g, ' ').replace(/[._+]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Studio prefix: "Brazzers 21.05.12 ..." (single leading token or known multi-word studio before the date)
    if (dm && beforeDate && !out.studio) {
        const bt = beforeDate.replace(/\s*[-–—|~]\s*$/, '').replace(/^\s*[-–—|~]\s*/, '').split(' ').filter((x) => x && !isJunkToken(x));
        const joined = bt.join('');
        if (bt.length === 1 && looksLikeStudio(bt[0]))
            out.studio = bt[0].replace(/\.(com|net|xxx)$/i, '');
        else if (bt.length >= 2 && bt.length <= 3 && isKnownStudioKey(key(joined), extra))
            out.studio = bt.join(' ');
        if (out.studio) {
            const first = beforeDate.split(' ')[0];
            s = s.replace(new RegExp('^' + bt.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ ._-]+')), '').replace(/^\s*[-–—|~]\s*/, '').trim();
            void first;
        }
    }
    if (!out.studio && out.studioHints.length)
        out.studio = out.studioHints[0];
    s = cleanTokens(s).replace(/(?:\s*[-–—|~]\s+){2,}/g, ' - ').replace(/^\s*[-–—|~]\s+|\s+[-–—|~]\s*$/g, '');
    const segs = s.split(/\s+[-–—|~]\s+|^\s*-\s*|\s*-\s*$/).map((x) => x.trim()).filter(Boolean);
    if (segs.length >= 3) {
        if (out.studio) {
            out.performers = splitPerformers(segs[0]);
            out.title = segs.slice(1).join(' - ');
        }
        else if (looksLikeStudio(segs[0]) && !looksLikeStudio(segs[1])) {
            out.studio = segs[0].replace(/\.(com|net|xxx)$/i, '');
            out.performers = splitPerformers(segs[1]);
            out.title = segs.slice(2).join(' - ');
        }
        else if (looksLikeStudio(segs[1]) && !looksLikeStudio(segs[0])) {
            out.performers = splitPerformers(segs[0]);
            out.studio = segs[1].replace(/\.(com|net|xxx)$/i, '');
            out.title = segs.slice(2).join(' - ');
        }
        else {
            out.studio = segs[0];
            out.performers = splitPerformers(segs[1]);
            out.title = segs.slice(2).join(' - ');
        }
    }
    else if (segs.length === 2) {
        const k0 = key(segs[0]);
        if (!out.studio && (looksLikeStudio(segs[0]) && (isKnownStudioKey(k0, extra) || !/\s/.test(segs[0])) || isKnownStudioKey(k0, extra))) {
            out.studio = segs[0].replace(/\.(com|net|xxx)$/i, '');
            out.title = segs[1];
        }
        else if (!out.studio && isKnownStudioKey(key(segs[1]), extra) && !isKnownStudioKey(k0, extra)) {
            out.studio = segs[1];
            out.title = segs[0];
        }
        else {
            out.performers = splitPerformers(segs[0]);
            out.title = segs[1];
        }
    }
    else if (segs.length === 1) {
        out.title = segs[0];
        // "Studio Rest Of Title" when date was found and studio not yet known, or a known studio leads
        const w = segs[0].split(' ');
        if (!out.studio && w.length > 1 && (isKnownStudioKey(key(w[0]), extra) || (w.length > 2 && isKnownStudioKey(key(w[0] + w[1]), extra)))) {
            const n = isKnownStudioKey(key(w[0]), extra) ? 1 : 2;
            out.studio = w.slice(0, n).join(' ');
            out.title = w.slice(n).join(' ');
        }
        // Performer heuristic for release-style names: "First Last And First Last <title>"
        if (dm && out.studio) {
            const words = out.title.split(' ');
            const andIdx = words.findIndex((x, i) => i > 0 && i < 6 && /^(?:and|&)$/i.test(x));
            if (andIdx > 0 && words.length >= andIdx + 3) {
                out.performers = [words.slice(0, andIdx).join(' '), words.slice(andIdx + 1, andIdx + 3).join(' ')].map(titleCase);
                const t = words.slice(andIdx + 3).join(' ');
                out.title = t ? titleCase(t) : null;
            }
            else
                out.title = titleCase(out.title) || null;
        }
    }
    // Parent folders: studio / performer hints
    const folders = (folderPath || '').split(/[\\/]/).map((x) => x.trim()).filter(Boolean).slice(-3).reverse();
    for (const f of folders) {
        const c = f.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!c || GENERIC_FOLDERS.test(c) || c.length < 3)
            continue;
        out.folderHints.push(c);
    }
    const parent = folders[0];
    if (!out.studio && parent && looksLikeStudio(parent) && !GENERIC_FOLDERS.test(parent))
        out.studio = parent;
    if (!out.studio && siteTags.length)
        out.studio = siteTags[0].split('.')[0];
    if (out.title)
        out.title = out.title.replace(/\s+/g, ' ').trim() || null;
    if (out.title && out.jav && !out.title.length)
        out.title = null;
    if (!out.title && out.jav)
        out.title = out.jav;
    if (out.title && out.title !== out.jav)
        out.title = out.title.split(' ').map(splitCamel).join(' ');
    // hints
    const hints = [];
    const addHint = (h) => { if (h && !hints.some((x) => key(x) === key(h)))
        hints.push(h); };
    addHint(out.studio);
    out.studioHints.forEach(addHint);
    siteTags.forEach((t) => addHint(t.split('.')[0]));
    const camel = out.studio ? splitCamel(out.studio) : null;
    if (camel && camel !== out.studio)
        hints.push(camel);
    out.studioHints = hints;
    const wordSrc = [...out.performers, out.title !== out.jav ? out.title || '' : ''].join(' ');
    out.words = wordSrc.split(/[\s,&/]+/).map((x) => x.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter((x) => x && !isJunkToken(x));
    out.cleanTitle = out.words.join(' ');
    out.query = [out.jav, out.studio, out.date, out.performers.join(' '), out.title !== out.jav ? out.title : null]
        .filter(Boolean).join(' ').trim() || base;
    void dateIdx;
    return out;
}
export function isVideo(name) {
    const m = name.match(/\.([A-Za-z0-9]+)$/);
    return !!m && VIDEO_EXTS.includes(m[1].toLowerCase()) && !/\bsample\b/i.test(name);
}
/** Phone clips, date-only names, and files with no studio, performer, code or title. Bulk matching skips these. */
const CAMERA_NAME = /^(?:img|dsc|dscn|dscf|pxl|mvi|gopr|dji|vid|mov|video|clip|screenrecording|screen|rec|movie|cam|whatsapp|wa)[-_ ]?\d|^whatsapp\b/i;
const DATE_ONLY_NAME = /^(?:19|20)\d{2}[-_. ]?\d{2}[-_. ]?\d{2}(?:[-_. T]?\d{2,6})*$/;
export function isUnsearchable(fileName, parsed) {
    const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/i, '').trim();
    if (CAMERA_NAME.test(base) || DATE_ONLY_NAME.test(base))
        return true;
    if (parsed.jav || parsed.performers.length || parsed.studio || parsed.studioHints?.length)
        return false;
    const words = (parsed.words || []).filter((w) => w.length > 2 && !/^\d+$/.test(w));
    return words.length < 2;
}
export function isSubtitle(name) {
    const m = name.match(/\.([A-Za-z0-9]+)$/);
    return !!m && SUB_EXTS.includes(m[1].toLowerCase());
}
/** "Movie.en.srt" -> "en" */
export function subtitleLang(subName, videoBase) {
    const rest = subName.replace(/\.(srt|vtt)$/i, '').slice(videoBase.length).replace(/^[._ -]+/, '');
    return rest ? rest.toLowerCase() : null;
}
export function srtToVtt(srt) {
    return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/^\uFEFF/, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
}
