import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { createStore } from './store.mjs';
import { createAuth, publicUser } from './auth.mjs';
import { createRedisHub } from './redis.mjs';
import {
  clearSessionCookie,
  fail,
  isSecureRequest,
  ok,
  readBody,
  sessionCookie,
} from './http-util.mjs';

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

const store = createStore(DATA_DIR);
const auth = createAuth(store);
const redis = createRedisHub(store);

function sendFile(res, filePath, cache = true) {
  const type = MIME[extname(filePath)] || 'application/octet-stream';
  const headers = { 'content-type': type };
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
  return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
}

function requireCsrf(req, res, url) {
  if (url.pathname === '/api/health') {
    return true;
  }
  if (String(req.headers[CSRF_HEADER] || '') === '1') {
    return true;
  }
  fail(res, 403, 'Missing X-Dimadb header');
  return false;
}

function requireUser(req, res) {
  const user = auth.currentUser(req);
  if (!user) {
    fail(res, 401, 'Not authenticated');
    return null;
  }
  return user;
}

function cookieHeader(req, sessionId) {
  return { 'set-cookie': sessionCookie(sessionId, isSecureRequest(req)) };
}

async function handleApi(req, res, url) {
  if (!requireCsrf(req, res, url)) {
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      ok(res, { ok: true, service: 'dimadb', dataDir: DATA_DIR });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/setup/status') {
      ok(res, { needsSetup: auth.needsSetup() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/setup') {
      if (!auth.needsSetup()) {
        fail(res, 409, 'Setup already completed');
        return;
      }
      const body = await readBody(req);
      const user = auth.createUser({
        username: body.username,
        password: body.password,
        role: 'admin',
      });
      const { session } = auth.login(user.username, body.password);
      ok(res, { user: publicUser(user) }, cookieHeader(req, session.id));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      const { user, session } = auth.login(body.username, body.password);
      ok(res, { user: publicUser(user) }, cookieHeader(req, session.id));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      auth.logout(req);
      ok(res, { ok: true }, { 'set-cookie': clearSessionCookie(isSecureRequest(req)) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = requireUser(req, res);
      if (!user) {
        return;
      }
      ok(res, { user: publicUser(user) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/users') {
      const user = requireUser(req, res);
      if (!user) {
        return;
      }
      if (user.role !== 'admin') {
        fail(res, 403, 'Admin only');
        return;
      }
      ok(res, store.users().map(publicUser));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/users') {
      const user = requireUser(req, res);
      if (!user) {
        return;
      }
      if (user.role !== 'admin') {
        fail(res, 403, 'Admin only');
        return;
      }
      const body = await readBody(req);
      const created = auth.createUser({
        username: body.username,
        password: body.password,
        role: body.role === 'user' ? 'user' : 'admin',
      });
      ok(res, publicUser(created));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/connections') {
      if (!requireUser(req, res)) {
        return;
      }
      ok(res, redis.list());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/connections') {
      if (!requireUser(req, res)) {
        return;
      }
      const body = await readBody(req);
      ok(res, redis.add(body));
      return;
    }

    const connectionMatch = url.pathname.match(/^\/api\/connections\/([^/]+)(?:\/(ping))?$/);
    if (connectionMatch) {
      if (!requireUser(req, res)) {
        return;
      }
      const id = decodeURIComponent(connectionMatch[1]);
      if (req.method === 'DELETE' && !connectionMatch[2]) {
        redis.remove(id);
        ok(res, { ok: true });
        return;
      }
      if (req.method === 'POST' && connectionMatch[2] === 'ping') {
        const pong = await redis.ping(id);
        ok(res, { ok: true, pong });
        return;
      }
    }

    const redisMatch = url.pathname.match(/^\/api\/redis\/([^/]+)\/(keys|key|command)$/);
    if (redisMatch) {
      if (!requireUser(req, res)) {
        return;
      }
      const id = decodeURIComponent(redisMatch[1]);
      const action = redisMatch[2];

      if (action === 'keys' && req.method === 'GET') {
        ok(res, await redis.scan(id, {
          cursor: url.searchParams.get('cursor') || '0',
          match: url.searchParams.get('match') || '*',
          count: url.searchParams.get('count') || 50,
        }));
        return;
      }

      if (action === 'key' && req.method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key) {
          fail(res, 400, 'key is required');
          return;
        }
        ok(res, await redis.inspect(id, key));
        return;
      }

      if (action === 'key' && req.method === 'PUT') {
        const body = await readBody(req);
        if (!body.key) {
          fail(res, 400, 'key is required');
          return;
        }
        ok(res, await redis.setString(id, body.key, body.value));
        return;
      }

      if (action === 'key' && req.method === 'DELETE') {
        const key = url.searchParams.get('key');
        if (!key) {
          fail(res, 400, 'key is required');
          return;
        }
        ok(res, { deleted: await redis.del(id, key) });
        return;
      }

      if (action === 'command' && req.method === 'POST') {
        const body = await readBody(req);
        const args = Array.isArray(body.args) ? body.args : String(body.command || '').trim().split(/\s+/);
        if (!args[0]) {
          fail(res, 400, 'command is required');
          return;
        }
        ok(res, { result: await redis.command(id, args, Boolean(body.confirm)) });
        return;
      }
    }

    fail(res, 404, 'Not found');
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) {
      console.error(error);
    }
    fail(res, status, error.message || 'Request failed');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    void handleApi(req, res, url);
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
