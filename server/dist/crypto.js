import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
let key = null;
function getKey() {
    if (key)
        return key;
    let material = config.secret;
    if (!material) {
        const f = path.join(config.dataDir, 'secret.key');
        if (!fs.existsSync(f))
            fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
        material = fs.readFileSync(f, 'utf8').trim();
    }
    key = crypto.createHash('sha256').update(material).digest();
    return key;
}
/** AES-256-GCM, output: v1:<iv>:<tag>:<ciphertext> (base64) */
export function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
export function decrypt(blob) {
    const [v, iv, tag, data] = blob.split(':');
    if (v !== 'v1')
        throw new Error('bad ciphertext');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
export function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    const h = crypto.scryptSync(pin, salt, 32);
    return `s1:${salt.toString('base64')}:${h.toString('base64')}`;
}
export function verifyPin(pin, stored) {
    const [, salt, h] = stored.split(':');
    const calc = crypto.scryptSync(pin, Buffer.from(salt, 'base64'), 32);
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'base64'));
}
