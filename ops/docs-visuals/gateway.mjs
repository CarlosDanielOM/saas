// Real Angular development assets with browser-only example data. No API proxy.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const upstream = process.env.SAAS_SITE_URL || 'http://127.0.0.1:4203';
const port = Number(process.env.SAAS_CAPTURE_PORT || 4204);
const directory = new URL('./', import.meta.url);
const groups = new Set(['commands', 'alerts', 'growth']);
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Read-only capture gateway'); }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const target = new URL(upstream);
    target.pathname = url.pathname;
    target.search = url.search;
    const upstreamResponse = await fetch(target, { headers: { accept: req.headers.accept || '*/*' } });
    const type = upstreamResponse.headers.get('content-type') || 'application/octet-stream';
    let buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    if (type.includes('text/html')) {
      const group = url.searchParams.get('capture');
      if (!groups.has(group)) { res.writeHead(400); return res.end('Choose ?capture=commands|alerts|growth&lang=en|es&theme=dark|light'); }
      const core = await readFile(new URL('browser-core.js', directory), 'utf8');
      const fixture = await readFile(new URL(`${group}.fixture.js`, directory), 'utf8');
      // Group scripts may adjust the profile before the application reads it.
      const persist = 'localStorage.setItem("dimasite.session.v1",JSON.stringify({...JSON.parse(localStorage.getItem("dimasite.session.v1")),appUser:window.docsCapture.app,twitchUser:window.docsCapture.user}));';
      buffer = Buffer.from(buffer.toString().replace('<head>', `<head><script>${core}\n${fixture}\n${persist}</script>`));
    }
    res.writeHead(upstreamResponse.status, { 'content-type': type, 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; media-src 'self' data: blob:; connect-src 'self'; frame-src 'none'" });
    res.end(req.method === 'HEAD' ? undefined : buffer);
  } catch (error) { res.writeHead(502); res.end(`Capture gateway: ${error.message}`); }
});
server.listen(port, '127.0.0.1', () => console.log(`Capture gateway: http://127.0.0.1:${port} (Angular: ${upstream})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
