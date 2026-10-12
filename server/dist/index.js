import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config } from './config.js';
let fetchImpl;
let demoInfo = '';
if (config.demo) {
    // Offline demo: route pCloud API + content calls to an in-process mock serving sample media.
    const { startMockPcloud, MOCK_CODE } = await import('../scripts/mock-pcloud.js');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files = JSON.parse(fs.readFileSync(path.join(root, 'server/scripts/demo-fixture.json'), 'utf8'));
    const mock = await startMockPcloud({ port: config.demoPort, files, video: path.join(root, 'data-demo/sample.mp4'), thumb: path.join(root, 'data-demo/thumb.jpg'), subtitle: path.join(root, 'data-demo/sample.srt') });
    fetchImpl = (input, init) => {
        const u = String(input).replace(/^https:\/\/(e?api\.pcloud\.com|127\.0\.0\.1:\d+)/, `http://${mock.host}`);
        return fetch(u, init);
    };
    demoInfo = ` DEMO MODE: pCloud mocked on ${mock.host}; connect with POST /api/pcloud/exchange {"code":"${MOCK_CODE}"}`;
}
const app = await buildApp({ logger: true, fetch: fetchImpl });
await app.listen({ port: config.port, host: config.host });
app.log.info(`Pulse server on :${config.port} (pCloud client ${config.pcloud.clientId ? 'configured' : 'missing'}, TPDB ${config.tpdbKey ? 'configured' : 'missing'}, StashDB ${config.stashdbKey ? 'configured' : 'missing'}, TorBox ${config.torboxKey ? 'configured' : 'missing'})${demoInfo}`);
