// Serves a built site bundle on loopback (read-only), with the same SPA fallback nginx uses (index.csr.html).
// Rendering from the bundle on disk means the same bytes as production without touching the public site.
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, readdirSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join, normalize, resolve} from 'node:path';

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'};

export function checkBundle(dir) {
  if (!existsSync(resolve(dir, 'index.csr.html'))) throw new Error(`${dir} is not a built dimasite bundle (no index.csr.html)`);
}

/** Changes when a deploy replaces the bundle mid-render. */
export function bundleHash(dir) {
  const hash = createHash('sha256');
  const walk = sub => {
    for (const name of readdirSync(resolve(dir, sub)).sort()) {
      const rel = sub ? `${sub}/${name}` : name, st = statSync(resolve(dir, rel));
      if (st.isDirectory()) walk(rel); else hash.update(`${rel}:${st.size}:${st.mtimeMs}\n`);
    }
  };
  walk('');
  return hash.digest('hex').slice(0, 16);
}

export function serveBundle(dir) {
  checkBundle(dir);
  const root = resolve(dir);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(path)) { res.writeHead(404).end(); return; }
      file = resolve(root, 'index.csr.html');
    }
    res.writeHead(200, {'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'});
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise({url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })}));
  });
}
