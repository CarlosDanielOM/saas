import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 80);
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || new URL('../public', import.meta.url).pathname);
const DATA_DIR = resolve(process.env.DATA_DIR || '/data');
const CSRF_HEADER = 'x-dimadb';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, filePath, cache = true) {
  const type = MIME[extname(filePath)] || 'application/octet-stream';
  const headers = {
    'content-type': type,
  };
  if (filePath.endsWith('index.html')) {
    headers['cache-control'] = 'no-cache, no-store, must-revalidate';
  } else if (cache) {
    headers['cache-control'] = 'public, max-age=2592000, immutable';
  }
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = resolve(join(PUBLIC_DIR, decoded));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

function handleApi(req, res, url) {
  const csrfOk = String(req.headers[CSRF_HEADER] || '') === '1';
  const openPaths = new Set(['/api/health']);

  if (!openPaths.has(url.pathname) && !csrfOk) {
    sendJson(res, 403, { error: true, message: 'Missing X-Dimadb header', status: 403 });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      error: false,
      status: 200,
      data: { ok: true, service: 'dimadb', dataDir: DATA_DIR },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/setup/status') {
    sendJson(res, 200, {
      error: false,
      status: 200,
      data: { needsSetup: true, mock: true },
    });
    return;
  }

  sendJson(res, 404, { error: true, message: 'Not found', status: 404 });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }

  const requested = safePublicPath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!requested) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (existsSync(requested) && statSync(requested).isFile()) {
    sendFile(res, requested);
    return;
  }

  const indexPath = join(PUBLIC_DIR, 'index.html');
  if (existsSync(indexPath)) {
    sendFile(res, indexPath, false);
    return;
  }

  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('dimadb public assets missing');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dimadb listening on ${PORT}`);
  console.log(`public=${PUBLIC_DIR} data=${DATA_DIR}`);
});
