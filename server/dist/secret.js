/** Cleans a pasted secret: BOM / zero-width chars, CR/LF, surrounding quotes, a stray "Bearer " prefix and any whitespace inside the token. */
export function cleanSecret(v) {
    let t = String(v ?? '').replace(/[\uFEFF\u200B-\u200D\u2060\u00A0]/g, '').trim();
    for (let i = 0; i < 3; i++)
        t = t.replace(/^(['"`\u2018\u2019\u201C\u201D])(.*)\1$/s, '$2').trim();
    t = t.replace(/^(authorization\s*:\s*)?bearer\s+/i, '').replace(/^(['"`\u2018\u2019\u201C\u201D]+)|(['"`\u2018\u2019\u201C\u201D]+)$/g, '');
    return t.replace(/\s+/g, '');
}
