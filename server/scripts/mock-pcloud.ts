/**
 * In-process mock of the pCloud API used by integration tests and the offline demo.
 * Implements: oauth2_token, userinfo, listfolder, getfilelink, getvideolinks, getthumblink,
 * downloadfileasync, plus a content host that serves the sample media with HTTP Range support.
 */
import http from 'node:http';
import fs from 'node:fs';

export interface MockFile {
  folder: string;
  name: string;
}

export const MOCK_TOKEN = 'mock-access-token';
export const MOCK_CODE = 'mock-code';

export function startMockPcloud(opts: { port: number; files: MockFile[]; video: string; thumb?: string; subtitle?: string }) {
  const folders = [...new Set(opts.files.map((f) => f.folder))];
  const folderIds = new Map(folders.map((f, i) => [f, 1000 + i]));
  const metas = opts.files.map((f, i) => ({
    name: f.name,
    isfolder: false,
    fileid: 50000 + i,
    parentfolderid: folderIds.get(f.folder)!,
    size: f.name.endsWith('.srt') ? 120 : 734003200 + i * 7340032,
    contenttype: f.name.endsWith('.srt') ? 'application/x-subrip' : 'video/mp4',
    hash: 900000 + i,
    created: new Date(Date.UTC(2026, 8, 1 + i)).toUTCString(),
    modified: new Date(Date.UTC(2026, 8, 1 + i)).toUTCString(),
    thumb: !f.name.endsWith('.srt'),
  }));
  const host = `127.0.0.1:${opts.port}`;
  const uploads: string[] = [];

  const folderMeta = (id: number, recursive: boolean): any => {
    if (id === 0)
      return {
        name: '/',
        isfolder: true,
        folderid: 0,
        path: '/',
        contents: [
          { name: 'Media', isfolder: true, folderid: 999, parentfolderid: 0, contents: recursive ? folders.map((f) => folderMeta(folderIds.get(f)!, true)) : undefined },
          { name: 'Documents', isfolder: true, folderid: 998, parentfolderid: 0, contents: recursive ? [] : undefined },
        ],
      };
    if (id === 999) return { name: 'Media', isfolder: true, folderid: 999, parentfolderid: 0, path: '/Media', contents: folders.map((f) => (recursive ? folderMeta(folderIds.get(f)!, true) : { name: f, isfolder: true, folderid: folderIds.get(f), parentfolderid: 999 })) };
    if (id === 998) return { name: 'Documents', isfolder: true, folderid: 998, parentfolderid: 0, path: '/Documents', contents: [] };
    const name = folders.find((f) => folderIds.get(f) === id);
    if (!name) return null;
    return { name, isfolder: true, folderid: id, parentfolderid: 999, path: `/Media/${name}`, contents: metas.filter((m) => m.parentfolderid === id) };
  };

  const send = (res: http.ServerResponse, body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const serveFile = (req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string) => {
    const size = fs.statSync(file).size;
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://${host}`);
    const p = u.pathname;
    if (p.startsWith('/content/')) {
      const [, , kind] = p.split('/');
      if (kind === 'thumb' && opts.thumb) return serveFile(req, res, opts.thumb, 'image/jpeg');
      if (kind === 'sub' && opts.subtitle) return serveFile(req, res, opts.subtitle, 'application/x-subrip');
      return serveFile(req, res, opts.video, 'video/mp4');
    }
    if (p === '/oauth2_token' && req.method === 'POST' && !(req as any)._parsed) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { for (const [k, v] of new URLSearchParams(body)) u.searchParams.set(k, v); (req as any)._parsed = true; handle(req, res, u); });
      return;
    }
    return handle(req, res, u);
  });
  const handle = (req: http.IncomingMessage, res: http.ServerResponse, u: URL) => {
    const p = u.pathname;
    if (p === '/oauth2_token') {
      if (u.searchParams.get('code') !== MOCK_CODE || !u.searchParams.get('client_secret')) return send(res, { result: 2012, error: 'Invalid code.' });
      return send(res, { result: 0, access_token: MOCK_TOKEN, token_type: 'bearer', uid: 42, locationid: 2 });
    }
    const auth = req.headers.authorization === `Bearer ${MOCK_TOKEN}` || u.searchParams.get('access_token') === MOCK_TOKEN;
    if (!auth) return send(res, { result: 1000, error: 'Log in required.' });
    const fileid = Number(u.searchParams.get('fileid'));
    const file = metas.find((m) => m.fileid === fileid);
    switch (p) {
      case '/userinfo':
        return send(res, { result: 0, email: 'owner@example.com', userid: 42, quota: 2199023255552, usedquota: 845623353344, premium: true });
      case '/listfolder': {
        const m = folderMeta(Number(u.searchParams.get('folderid') || 0), u.searchParams.get('recursive') === '1');
        return m ? send(res, { result: 0, metadata: m }) : send(res, { result: 2005, error: 'Directory does not exist.' });
      }
      case '/getfilelink':
        if (!file) return send(res, { result: 2009, error: 'File not found.' });
        return send(res, { result: 0, hosts: [host], path: `/content/${file.name.endsWith('.srt') ? 'sub' : 'video'}/${fileid}`, expires: new Date(Date.now() + 3600e3).toUTCString() });
      case '/getvideolinks':
        if (!file) return send(res, { result: 2009, error: 'File not found.' });
        return send(res, {
          result: 0,
          variants: [
            { isoriginal: true, width: 1280, height: 720, duration: '60.0', fps: '30', videocodec: 'h264', audiocodec: 'aac', videobitrate: 2500, hosts: [host], path: `/content/video/${fileid}`, expires: new Date(Date.now() + 3600e3).toUTCString() },
            { isoriginal: false, width: 854, height: 480, duration: '60.0', fps: '30', videocodec: 'h264', audiocodec: 'aac', videobitrate: 900, hosts: [host], path: `/content/video/${fileid}?v=480`, expires: new Date(Date.now() + 3600e3).toUTCString() },
          ],
        });
      case '/getthumblink':
        return send(res, { result: 0, hosts: [host], path: `/content/thumb/${fileid}`, expires: new Date(Date.now() + 3600e3).toUTCString() });
      case '/downloadfileasync':
        uploads.push(String(u.searchParams.get('url')));
        return send(res, { result: 0, metadata: [] });
      default:
        return send(res, { result: 2000, error: `mock: unknown method ${p}` });
    }
  };
  return new Promise<{ server: http.Server; host: string; uploads: string[]; close: () => Promise<void> }>((resolve) =>
    server.listen(opts.port, '127.0.0.1', () => resolve({ server, host, uploads, close: () => new Promise((r) => server.close(() => r())) })),
  );
}
