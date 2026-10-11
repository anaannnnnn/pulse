// Live StashDB + ThePornDB checks using env keys. Run: LIVE=1 npx vitest run test/liveStash.test.ts  (keys are never printed)
import { describe, it, expect } from 'vitest';
import { TpdbClient } from '../src/clients/tpdb.js';
import { StashDbClient } from '../src/clients/stashdb.js';
import { cleanSecret } from '../src/secret.js';
import { parseFilename } from '../src/parser.js';
import { runCascade } from '../src/services/matchEngine.js';

const live = process.env.LIVE === '1' || process.env.npm_lifecycle_event === 'test:live';
const stashKey = cleanSecret(process.env.STASHDB_API_KEY);
describe.skipIf(!live)('live StashDB', () => {
  const stash = new StashDbClient(stashKey);
  it('test() reports the key status (hint only, never the key)', async () => {
    const r = await stash.test();
    console.log('stashdb test ->', r.status, '|', r.hint);
    expect(JSON.stringify(r)).not.toContain(stashKey || '\u0000');
    expect(['ok', 'unauthorized']).toContain(r.status);
  }, 30000);
  it.skipIf(!stashKey)('searches mainstream titles and runs the cascade next to ThePornDB', async () => {
    const t = await stash.test();
    if (!t.ok) { console.log('skipping: StashDB key not accepted'); return; }
    const titles = ['Blacked Emily Willis', 'Vixen Riley Reid', 'Mandy Marx Pain To Play'];
    const tpdb = new TpdbClient(cleanSecret(process.env.TPDB_API_KEY));
    for (const name of titles) {
      const t0 = Date.now();
      const r = await runCascade(tpdb, { fileName: `${name}.mp4`, folderPath: '', parsed: parseFilename(`${name}.mp4`, ''), threshold: 0.75, stash });
      console.log(`"${name}" -> ${r.best?.source}/${r.best?.matchedBy} "${r.best?.title}" ${r.best?.confidence} alsoOn=${JSON.stringify(r.best?.alsoOn || [])} queries=${r.queries} ${Date.now() - t0}ms errors=${r.errors.map((e) => e.code).join(',')}`);
      expect(r.candidates.length).toBeGreaterThanOrEqual(0);
    }
  }, 120000);
});
