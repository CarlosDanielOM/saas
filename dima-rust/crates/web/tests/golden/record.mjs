// Records golden responses from real Express for the dima-web conformance test.
//
//   node dima-rust/crates/web/tests/golden/record.mjs [path/to/dimabot/node_modules]
//
// Builds the fixture app below with the exact Express stack production runs (express 4,
// body-parser, qs, cors, finalhandler from dimabot/node_modules) under NODE_ENV=production,
// listens on a loopback port chosen by the OS, sends every case as raw HTTP/1.1 bytes and writes
// the requests with their responses to express.json next to this script. The Rust test
// (tests/golden.rs) builds the same app with dima-web, replays the same bytes and compares.
// Keep the two fixtures identical when adding a case.

import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

process.env.NODE_ENV = 'production';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const nodeModules = path.resolve(
  process.argv[2] ?? process.env.DIMABOT_NODE_MODULES ?? path.join(repoRoot, 'dimabot', 'node_modules'),
);
if (!existsSync(path.join(nodeModules, 'express'))) {
  console.error(`express not found under ${nodeModules}; pass the dimabot node_modules path`);
  process.exit(2);
}
const require = createRequire(path.join(nodeModules, 'noop.js'));
const express = require('express');
const cors = require('cors');
const multer = require('multer');

// ---------------------------------------------------------------------------------------------
// Fixture app. Mirrors the reference server's shape: raw webhook before the JSON parsers,
// per-prefix limits, a router with its own CORS, global parsers, routers mounted before cors(),
// cors(), then routes and routers (auth shadowing, mergeParams, error handlers, JSON 404s).
// ---------------------------------------------------------------------------------------------

// Files served by express.static and res.sendFile. The Rust test builds the same tree from the
// `staticFiles` list written into express.json, with the same modification time (a half second
// is exact both through libuv's float conversion and in Rust), so ETags and Last-Modified agree.
const STATIC_MTIME_MS = 1767323045500;
const pattern = (size) => Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
const STATIC_FILES = [
  ['index.html', Buffer.from('<h1>root</h1>\n')],
  ['hello.txt', Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789')],
  ['empty.txt', Buffer.alloc(0)],
  ['noext', Buffer.from('no extension')],
  ['data.json', Buffer.from('{"a":1}')],
  ['script.js', Buffer.from('var a = 1;')],
  ['styles/app.css', Buffer.from('body{}')],
  ['dir/index.html', Buffer.from('<p>dir</p>')],
  ['speech/chan1/one.wav', Buffer.concat([Buffer.from('RIFF'), pattern(60)])],
  ['speech/chan1/one.mp3', Buffer.concat([Buffer.from('ID3'), pattern(40)])],
  ['downloads/123-clip.mp4', pattern(300)],
  ['.env', Buffer.from('SECRET=1')],
  ['.well-known/thing.txt', Buffer.from('well known')],
  ['café/menü.txt', Buffer.from('crème brûlée')],
  ['😀/smile.txt', Buffer.from('smile 😀')],
  ['emoji-😀.txt', Buffer.from('emoji')],
  ['שלום.txt', Buffer.from('שלום עולם')],
  ['with space.txt', Buffer.from('space')],
  ['percent%.txt', Buffer.from('percent')],
  ['UPPER.TXT', Buffer.from('upper')],
  ['big.bin', pattern(70000)],
];
const STATIC_DIRS = ['empty-dir'];

function makeStaticTree() {
  const root = mkdtempSync(path.join(process.env.GOLDEN_TMPDIR ?? os.tmpdir(), 'dima-web-static-'));
  for (const dir of STATIC_DIRS) mkdirSync(path.join(root, dir), { recursive: true });
  for (const [name, bytes] of STATIC_FILES) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    utimesSync(file, STATIC_MTIME_MS / 1000, STATIC_MTIME_MS / 1000);
  }
  return root;
}

const staticRoot = makeStaticTree();
// Uploads land here; every upload route empties it before answering.
const uploadDir = mkdtempSync(path.join(process.env.GOLDEN_TMPDIR ?? os.tmpdir(), 'dima-web-uploads-'));
const UPLOAD_TYPES = ['video/mp4', 'image/png', 'audio/mpeg', 'text/csv'];
const describeError = (err) =>
  err ? { name: err.name, code: err.code ?? null, field: err.field ?? null, message: err.message } : null;
const describeFile = (file, content) =>
  file
    ? {
        fieldname: file.fieldname,
        originalname: file.originalname,
        encoding: file.encoding,
        mimetype: file.mimetype,
        size: file.size,
        content: content ? content.toString('base64') : null,
      }
    : null;
const emptyUploads = () => {
  const leftover = readdirSync(uploadDir).sort();
  for (const name of leftover) rmSync(path.join(uploadDir, name), { force: true });
  return leftover;
};
const diskStorage = () =>
  multer.diskStorage({
    destination: (_req, _file, done) => done(null, uploadDir),
    filename: (_req, file, done) => done(null, `upload${path.extname(file.originalname || '').toLowerCase()}`),
  });
const fileTag = (name) => {
  const size = STATIC_FILES.find(([n]) => n === name)[1].length;
  return `W/"${size.toString(16)}-${STATIC_MTIME_MS.toString(16)}"`;
};
const lastModified = new Date(STATIC_MTIME_MS).toUTCString();
const earlier = new Date(STATIC_MTIME_MS - 86400000).toUTCString();
const later = new Date(STATIC_MTIME_MS + 86400000).toUTCString();

class WidgetError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const describeBody = (body) =>
  Buffer.isBuffer(body)
    ? { isBuffer: true, length: body.length, hex: body.toString('hex') }
    : { isBuffer: false, body };

function buildApp() {
  const app = express();

  const hook = express.Router();
  hook.post('/', express.raw({ type: 'application/json' }), (req, res) => res.json(describeBody(req.body)));
  app.use('/hook', hook);

  app.use('/big', express.json({ limit: '5mb' }));
  app.use('/mid', express.json({ limit: '1mb' }));
  app.use('/four', express.json({ limit: '4mb' }));

  const docs = express.Router();
  docs.use(
    cors({
      origin: (origin, done) => done(null, !origin || /^https:\/\/docs\.example\.com$/.test(origin)),
      methods: ['POST'],
      maxAge: 86400,
    }),
  );
  docs.use(express.json({ limit: '256kb' }));
  docs.post('/ask', (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  app.use('/docs', docs);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const oauth = express.Router();
  oauth.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  oauth.get('/authorize', (req, res) => res.json({ ok: true, query: req.query }));
  oauth.post('/token', (req, res) => res.json({ body: req.body }));
  oauth.get('/fail', (req, res, next) => next(Object.assign(new Error('bad token'), { status: 401 })));
  oauth.get('/limited', (req, res, next) => next(Object.assign(new Error('slow down'), { status: 429 })));
  oauth.get('/broken', () => {
    throw new Error('broken');
  });
  oauth.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  // eslint-disable-next-line no-unused-vars
  oauth.use((err, req, res, next) => {
    const status = err.status === 401 || err.status === 429 ? err.status : 503;
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    if (status === 429) res.setHeader('Retry-After', '60');
    const code = status === 401 ? 'invalid_token' : status === 429 ? 'slow_down' : 'temporarily_unavailable';
    res.status(status).json({ error: code });
  });
  app.use('/oauth', oauth);

  const pre = express.Router();
  pre.get('/thing', (req, res) => res.json({ pre: 'get' }));
  pre.post('/thing', (req, res) => res.json({ pre: 'post' }));
  pre.put('/other', (req, res) => res.json({ pre: 'put' }));
  app.use('/pre', pre);
  app.get('/early', (req, res) => res.json({ early: true }));

  // As in the reference: static files after the parsers and the OAuth mounts, before cors().
  app.use(express.static(staticRoot));
  app.use(cors());

  const where = (req) => ({ path: req.path, baseUrl: req.baseUrl, originalUrl: req.originalUrl, url: req.url });
  app.get('/users/:id', (req, res) => res.json({ route: 'id', params: req.params, ...where(req) }));
  app.get('/users/me', (req, res) => res.json({ route: 'me' }));
  app.get('/order/me', (req, res) => res.json({ route: 'me' }));
  app.get('/order/:id', (req, res) => res.json({ route: 'id', params: req.params }));
  app.get('/opt/:a/:b?', (req, res) => res.json({ params: req.params }));
  app.get('/files/*', (req, res) => res.json({ params: req.params }));
  app.get('/f/:name.:ext', (req, res) => res.json({ params: req.params }));
  app.post('/only-post/:id', (req, res) => res.json({ params: req.params }));
  app.get('/query', (req, res) => res.json({ query: req.query }));
  app.post('/echo', (req, res) => res.json({ body: req.body }));
  app.put('/echo', (req, res) => res.json({ body: req.body }));
  const summary = (req, res) =>
    res.json({ keys: Object.keys(req.body), padLength: typeof req.body.pad === 'string' ? req.body.pad.length : null });
  app.post('/big/echo', summary);
  app.post('/mid/echo', summary);
  app.post('/four/echo', summary);
  app.post('/form-summary', (req, res) => res.json({ keys: Object.keys(req.body).length }));
  app.get('/etag', (req, res) => res.json({ ok: true }));
  app.post('/etag', (req, res) => res.json({ ok: true }));
  app.get('/text', (req, res) => res.send('<p>hello</p>'));
  app.get('/text-plain', (req, res) => res.type('text/plain').send('plain'));
  app.get('/buffer', (req, res) => res.send(Buffer.from([0, 1, 2, 255])));
  app.get('/buffer-typed', (req, res) => res.type('image/png').send(Buffer.from('png!')));
  app.get('/object', (req, res) => res.send({ sent: 'object' }));
  app.get('/set-ct', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.send('var a = 1;');
  });
  app.get('/emoji', (req, res) => res.json({ text: 'héllo 😀 שלום é' }));
  app.get('/status/:code', (req, res) => res.sendStatus(Number(req.params.code)));
  app.get('/created', (req, res) => res.status(201).json({ error: false, status: 200, message: 'Created' }));
  app.get('/no-content', (req, res) => res.status(204).json({ ignored: true }));
  app.get('/reset', (req, res) => res.status(205).send('ignored'));
  app.get('/end', (req, res) => res.status(204).end());
  app.get('/end200', (req, res) => res.end());
  app.get('/redirect', (req, res) => res.redirect('/target?x=1&y=é'));
  app.get('/redirect301', (req, res) => res.redirect(301, 'https://example.com/a b<c>'));
  app.get('/throw', () => {
    throw new Error('boom');
  });
  app.get('/next-err/:status', (req, res, next) => next(Object.assign(new Error('x'), { status: Number(req.params.status) })));
  app.get('/next-err-headers', (req, res, next) =>
    next(Object.assign(new Error('x'), { status: 429, headers: { 'Retry-After': '60' } })),
  );
  app.get('/status-then-error', (req, res, next) => {
    res.status(403);
    next(new Error('x'));
  });
  app.get('/header-then-404', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get(
    '/next-route',
    (req, res, next) => next('route'),
    (req, res) => res.json({ first: true }),
  );
  app.get('/next-route', (req, res) => res.json({ second: true }));
  app.all('/any', (req, res) => res.json({ method: req.method }));
  app.get('/vary', (req, res) => {
    res.vary('Origin');
    res.vary('Accept');
    res.json({ vary: true });
  });
  app.get('/.well-known/thing', (req, res) => res.json({ wellKnown: true }));
  app.get('/a.b/c', (req, res) => res.json({ dotted: 'segment' }));
  app.get('/files.json', (req, res) => res.json({ dotted: 'file' }));
  app.get('/speech/:channelID', (req, res) => res.json({ speechPage: req.params.channelID }));
  app.get('/sendfile/text', (req, res) => res.sendFile(path.join(staticRoot, 'hello.txt')));
  app.get('/sendfile/typed', (req, res) => {
    res.set('Content-Type', 'audio/mpeg');
    res.sendFile(path.join(staticRoot, 'speech', 'chan1', 'one.wav'));
  });
  app.get('/sendfile/status', (req, res) => res.status(200).sendFile(path.join(staticRoot, 'index.html')));
  app.get('/sendfile/no-store', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(staticRoot, 'script.js'));
  });
  app.get('/sendfile/missing', (req, res) => res.sendFile(path.join(staticRoot, 'nope.txt')));
  app.get('/sendfile/dir', (req, res) => res.sendFile(path.join(staticRoot, 'dir')));
  app.get('/sendfile/dotfile', (req, res) => res.sendFile(path.join(staticRoot, '.env')));
  app.get('/sendfile/relative', (req, res) => res.sendFile('hello.txt'));
  app.get('/sendfile/emoji', (req, res) => res.sendFile(path.join(staticRoot, '😀', 'smile.txt')));
  app.get('/sendfile/big', (req, res) => res.sendFile(path.join(staticRoot, 'big.bin')));
  app.get('/type-unknown-ext', (req, res) => res.type('xyz').send(Buffer.from('x')));
  app.get('/type-wav', (req, res) => res.type('wav').send(Buffer.from('RIFF')));
  app.get('/set-manifest-json', (req, res) => {
    res.set('Content-Type', 'application/manifest+json');
    res.send(Buffer.from('{}'));
  });
  const filesRouter = express.Router();
  filesRouter.get('/missing', (req, res) => res.sendFile(path.join(staticRoot, 'nope.txt')));
  filesRouter.get('/range', (req, res) => res.sendFile(path.join(staticRoot, 'hello.txt')));
  // eslint-disable-next-line no-unused-vars
  filesRouter.use((err, req, res, next) =>
    res.status(err.status || 500).json({ status: err.status, code: err.code ?? null, expose: err.expose }),
  );
  app.use('/files-router', filesRouter);
  // multer as trigger.route.ts uses it: disk storage, a mimetype allowlist, a size limit.
  app.post('/upload/disk', (req, res) => {
    const upload = multer({
      storage: diskStorage(),
      fileFilter: (_req, file, done) => done(null, UPLOAD_TYPES.includes(file.mimetype)),
      limits: { fileSize: 64 },
    }).single('trigger');
    upload(req, res, (err) => {
      // After an error multer leaves req.file set, without the paths disk storage removed.
      const content = req.file?.path ? readFileSync(req.file.path) : null;
      const stored = req.file?.filename ?? null;
      res.json({ error: describeError(err), file: describeFile(req.file, content), stored, body: req.body ?? null, leftover: emptyUploads() });
    });
  });
  // multer as asset-library.route.ts uses it: a streaming storage engine and tight limits.
  app.post('/upload/stream', (req, res) => {
    const removed = [];
    const storage = {
      _handleFile(_req, file, done) {
        const parts = [];
        file.stream.on('data', (chunk) => parts.push(chunk));
        file.stream.on('error', done);
        file.stream.on('end', () => {
          const content = Buffer.concat(parts);
          done(null, { size: content.length, content });
        });
      },
      _removeFile(_req, file, done) {
        removed.push(file.originalname);
        done(null);
      },
    };
    const upload = multer({ storage, limits: { fileSize: 50, files: 1, fields: 0, parts: 2 } }).single('file');
    upload(req, res, (err) =>
      res.json({ error: describeError(err), file: describeFile(req.file, req.file?.content), removed, body: req.body ?? null }),
    );
  });
  // Field limits.
  app.post('/upload/fields', (req, res) => {
    const upload = multer({
      storage: diskStorage(),
      limits: { fieldSize: 16, fields: 3, parts: 5, fieldNameSize: 12 },
    }).single('doc');
    upload(req, res, (err) => {
      const file = req.file ? req.file.originalname : null;
      res.json({ error: describeError(err), file, body: req.body ?? null, leftover: emptyUploads() });
    });
  });
  // As middleware: errors take the default path.
  app.post('/upload/middleware', multer({ storage: diskStorage(), limits: { fileSize: 64 } }).single('trigger'), (req, res) => {
    res.json({ file: req.file ? req.file.originalname : null, body: req.body ?? null, leftover: emptyUploads() });
  });
  app.post('/raw-length', express.raw(), (req, res) =>
    res.json({ isBuffer: Buffer.isBuffer(req.body), length: req.body.length }),
  );

  const widgets = express.Router();
  widgets.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  widgets.get('/:channelID/overlay', (req, res) => res.json({ public: true, channel: req.params.channelID }));
  widgets.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer good') {
      res.status(401).json({ error: true, status: 401, message: 'Unauthorized' });
      return;
    }
    next();
  });
  widgets.use('/:channelID', (req, res, next) => {
    if (req.params.channelID === 'forbidden') {
      res.status(403).json({ error: true, status: 403, code: 'permission_required' });
      return;
    }
    next();
  });
  const duel = express.Router({ mergeParams: true });
  duel.get('/state', (req, res) => res.json({ duel: true, params: req.params, ...where(req) }));
  duel.post('/fail', (req, res, next) => next(Object.assign(new Error('duel'), { status: 409 })));
  duel.get('/item/:itemID', (req, res) => res.json({ item: req.params.itemID, params: req.params, ...where(req) }));
  widgets.use('/:channelID/duel', duel);
  const plain = express.Router();
  plain.get('/state', (req, res) => res.json({ plain: true, params: req.params, ...where(req) }));
  widgets.use('/:channelID/plain', plain);
  widgets.get('/:channelID', (req, res) => res.json({ channel: req.params.channelID }));
  widgets.post('/:channelID', (req, res) => res.json({ channel: req.params.channelID, body: req.body }));
  widgets.get('/:channelID/boom', (req, res, next) => next(new WidgetError('Bad widget', 422)));
  widgets.get('/:channelID/crash', () => {
    throw new Error('crash');
  });
  // eslint-disable-next-line no-unused-vars
  widgets.use((err, req, res, next) => {
    const known = err instanceof WidgetError;
    res.status(known ? err.status : 500).json({
      error: true,
      status: known ? err.status : 500,
      code: known ? 'widget' : 'internal',
      message: known ? err.message : 'Widget operation failed',
    });
  });
  app.use('/widgets', widgets);

  const timeline = express.Router();
  timeline.get('/streams/:channelID', (req, res) => res.json({ timeline: req.params.channelID, ...where(req) }));
  const analytics = express.Router();
  analytics.get('/summary', (req, res) => res.json({ summary: true }));
  analytics.use(timeline);
  app.use('/analytics', analytics);

  const overlay = express.Router();
  overlay.get('/overlays/:id', (req, res) => res.json({ overlay: req.params.id, ...where(req) }));
  app.use('/', overlay);

  const v1 = express.Router();
  v1.get('/me', (req, res) => res.json({ me: true }));
  v1.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use('/v1', v1);

  const emailA = express.Router();
  emailA.get('/a', (req, res) => res.json({ email: 'a' }));
  const emailB = express.Router();
  emailB.get('/b', (req, res) => res.json({ email: 'b' }));
  app.use('/email', emailA);
  app.use('/email', emailB);

  return app;
}

// ---------------------------------------------------------------------------------------------
// Cases. `body` is { utf8 }, { base64 } or { gen: {...} } (generated identically in Rust);
// a body gets Content-Length unless `chunked` is set.
// ---------------------------------------------------------------------------------------------

const BS = String.fromCharCode(92);
const JSON_CT = ['Content-Type', 'application/json'];
const FORM_CT = ['Content-Type', 'application/x-www-form-urlencoded'];
const AUTH = ['Authorization', 'Bearer good'];
const utf8 = (text) => ({ utf8: text });
const b64 = (buffer) => ({ base64: Buffer.from(buffer).toString('base64') });
const tag = (text) => {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha1').update(text, 'utf8').digest('base64').substring(0, 27);
  return `"${Buffer.byteLength(text).toString(16)}-${hash}"`;
};
const etagBody = JSON.stringify({ ok: true });
const strong = tag(etagBody);
const weak = `W/${strong}`;
const manyQuery = Array.from({ length: 1002 }, (_, i) => `a[]=${i}`).join('&');

const cases = [];
const add = (name, method, path, headers = [], body = null, extra = {}) =>
  cases.push({ name, method, path, headers, body, ...extra });

// Routing: order, shadowing, case, trailing slash.
add('param-basic', 'GET', '/users/123');
add('param-case-literal', 'GET', '/USERS/123');
add('param-trailing-slash', 'GET', '/users/123/');
add('param-keeps-case', 'GET', '/Users/AbC');
add('param-with-query', 'GET', '/users/123?x=1&y=2');
add('shadowed-by-earlier-param', 'GET', '/users/me');
add('literal-before-param', 'GET', '/order/me');
add('literal-before-param-other', 'GET', '/order/x');
add('param-emoji', 'GET', '/users/%F0%9F%98%80');
add('param-latin', 'GET', '/users/caf%C3%A9');
add('param-rtl', 'GET', '/users/%D7%A9%D7%9C%D7%95%D7%9D');
add('param-combining', 'GET', '/users/e%CC%81');
add('param-encoded-slash', 'GET', '/users/a%2Fb');
add('param-encoded-space-plus', 'GET', '/users/a%20b+c');
add('param-malformed', 'GET', '/users/%E0%A4%A');
add('param-malformed-hex', 'GET', '/users/%zz');
add('param-malformed-other-method-route', 'GET', '/only-post/%E0%A4%A');
add('param-missing', 'GET', '/users');
add('param-too-deep', 'GET', '/users/1/2');
add('optional-absent', 'GET', '/opt/x');
add('optional-present', 'GET', '/opt/x/y');
add('optional-present-slash', 'GET', '/opt/x/y/');
add('star', 'GET', '/files/a/b%20c/d');
add('star-empty', 'GET', '/files/');
add('star-missing', 'GET', '/files');
add('format-param', 'GET', '/f/report.pdf');
add('unmatched-html-404', 'GET', '/nothing/here');
add('unmatched-post', 'POST', '/nothing');
add('unmatched-head', 'HEAD', '/nothing');
add('unmatched-encoded', 'GET', "/a'b%20c");
add('unmatched-with-query', 'GET', '/nothing?x=<b>');
for (const [label, c] of [
  ['lt', '<'],
  ['gt', '>'],
  ['quote', '"'],
  ['lbrace', '{'],
  ['rbrace', '}'],
  ['pipe', '|'],
  ['backslash', BS],
  ['caret', '^'],
  ['backtick', '`'],
  ['hash', '#'],
]) {
  add(`raw-char-path-${label}`, 'GET', `/users/a${c}b`);
  add(`raw-char-query-${label}`, 'GET', `/query?q=${c}&r=1`);
}
add('next-route', 'GET', '/next-route');
add('all-get', 'GET', '/any');
add('all-delete', 'DELETE', '/any');
add('all-patch', 'PATCH', '/ANY/');
add('email-first-router', 'GET', '/email/a');
add('email-second-router', 'GET', '/email/b');
add('mounted-at-root', 'GET', '/overlays/abc');
add('pathless-nested-router', 'GET', '/analytics/streams/abc');
add('pathless-nested-sibling', 'GET', '/analytics/summary');
add('pathless-nested-miss', 'GET', '/analytics/nothing');
add('v1-route', 'GET', '/v1/me');
add('v1-json-404', 'GET', '/v1/nope');
add('v1-root-json-404', 'GET', '/v1');
add('v1-prefix-not-segment', 'GET', '/v1x');

// Auth middleware inside a mount, mergeParams, router error handlers.
add('widgets-public-before-auth', 'GET', '/widgets/chan/overlay');
add('widgets-no-auth', 'GET', '/widgets/chan');
add('widgets-unmatched-no-auth', 'GET', '/widgets/chan/nothing/at/all');
add('widgets-root-no-auth', 'GET', '/widgets');
add('widgets-ok', 'GET', '/widgets/chan', [AUTH]);
add('widgets-forbidden', 'GET', '/widgets/forbidden', [AUTH]);
add('widgets-unmatched-auth', 'GET', '/widgets/chan/nothing', [AUTH]);
add('widgets-merge-params', 'GET', '/widgets/Chan/duel/state', [AUTH]);
add('widgets-no-merge-params', 'GET', '/widgets/chan/plain/state', [AUTH]);
add('widgets-child-error-to-parent-handler', 'POST', '/widgets/chan/duel/fail', [AUTH]);
add('widgets-known-error', 'GET', '/widgets/chan/boom', [AUTH]);
add('widgets-thrown-error', 'GET', '/widgets/chan/crash', [AUTH]);
add('widgets-parser-error-skips-router-handler', 'POST', '/widgets/chan', [AUTH, JSON_CT], utf8('{bad'));
add('widgets-post-body', 'POST', '/widgets/chan', [AUTH, JSON_CT], utf8('{"a":1}'));
add('oauth-route', 'GET', '/oauth/authorize?scope=a+b');
add('oauth-json-404', 'GET', '/oauth/nope');
add('oauth-options', 'OPTIONS', '/oauth/token');
add('oauth-401', 'GET', '/oauth/fail');
add('oauth-429', 'GET', '/oauth/limited');
add('oauth-thrown', 'GET', '/oauth/broken');
add('oauth-form-post', 'POST', '/oauth/token', [FORM_CT], utf8('grant_type=code&code=x%2By&code=z'));

// OPTIONS and CORS placement.
add('options-auto-allow', 'OPTIONS', '/pre/thing');
add('options-auto-allow-put', 'OPTIONS', '/pre/other');
add('options-before-cors-unmatched', 'OPTIONS', '/pre/nothing');
add('options-cors-preflight', 'OPTIONS', '/users/1', [
  ['Origin', 'https://site.example'],
  ['Access-Control-Request-Method', 'PUT'],
  ['Access-Control-Request-Headers', 'X-Custom, Content-Type'],
]);
add('options-cors-plain', 'OPTIONS', '/early');
add('options-cors-unknown-path', 'OPTIONS', '/nothing');
add('cors-simple', 'GET', '/users/1', [['Origin', 'https://site.example']]);
add('cors-not-applied-before', 'GET', '/early', [['Origin', 'https://site.example']]);
add('cors-on-404', 'GET', '/nothing', [['Origin', 'https://site.example']]);
add('cors-not-on-parser-error', 'POST', '/echo', [['Origin', 'https://site.example'], JSON_CT], utf8('{bad'));
add('docs-allowed-origin', 'POST', '/docs/ask', [['Origin', 'https://docs.example.com'], JSON_CT], utf8('{"q":"hi"}'));
add('docs-no-origin', 'POST', '/docs/ask', [JSON_CT], utf8('{"q":"hi"}'));
add('docs-refused-origin', 'POST', '/docs/ask', [['Origin', 'https://evil.example'], JSON_CT], utf8('{"q":"hi"}'));
add('docs-preflight-allowed', 'OPTIONS', '/docs/ask', [
  ['Origin', 'https://docs.example.com'],
  ['Access-Control-Request-Method', 'POST'],
  ['Access-Control-Request-Headers', 'content-type'],
]);
add('docs-preflight-refused', 'OPTIONS', '/docs/ask', [['Origin', 'https://evil.example']]);
add('docs-within-limit', 'POST', '/docs/ask', [JSON_CT], { gen: { type: 'json-pad', size: 200 * 1024 } });
add('docs-over-limit-keeps-cors', 'POST', '/docs/ask', [['Origin', 'https://docs.example.com'], JSON_CT], {
  gen: { type: 'json-pad', size: 300 * 1024 },
});

// res.send / json / sendStatus / redirect.
add('send-string', 'GET', '/text');
add('send-string-typed', 'GET', '/text-plain');
add('send-buffer', 'GET', '/buffer');
add('send-buffer-typed', 'GET', '/buffer-typed');
add('send-object', 'GET', '/object');
add('set-content-type-charset', 'GET', '/set-ct');
add('json-non-ascii', 'GET', '/emoji');
add('send-status-200', 'GET', '/status/200');
add('send-status-404', 'GET', '/status/404');
add('send-status-418', 'GET', '/status/418');
add('send-status-unknown', 'GET', '/status/299');
add('status-body-mismatch', 'GET', '/created');
add('status-204-strips-body', 'GET', '/no-content');
add('status-205', 'GET', '/reset');
add('end-204', 'GET', '/end');
add('end-200', 'GET', '/end200');
add('redirect-plain', 'GET', '/redirect');
add('redirect-html', 'GET', '/redirect', [['Accept', 'text/html,application/xhtml+xml,*/*;q=0.8']]);
add('redirect-json', 'GET', '/redirect', [['Accept', 'application/json']]);
add('redirect-head', 'HEAD', '/redirect');
add('redirect-301-encoded', 'GET', '/redirect301', [['Accept', 'text/html']]);
add('vary-twice', 'GET', '/vary');

// Errors.
add('thrown-error', 'GET', '/throw');
add('next-error-418', 'GET', '/next-err/418');
add('next-error-302', 'GET', '/next-err/302');
add('next-error-599', 'GET', '/next-err/599');
add('next-error-499', 'GET', '/next-err/499');
add('next-error-headers', 'GET', '/next-err-headers');
add('status-then-error', 'GET', '/status-then-error');
add('header-then-404', 'GET', '/header-then-404');
add('head-error', 'HEAD', '/throw');

// ETag, 304, HEAD.
add('etag-plain', 'GET', '/etag');
add('etag-weak-match', 'GET', '/etag', [['If-None-Match', weak]]);
add('etag-strong-form-match', 'GET', '/etag', [['If-None-Match', strong]]);
add('etag-list-match', 'GET', '/etag', [['If-None-Match', `"nope", ${weak}`]]);
add('etag-star', 'GET', '/etag', [['If-None-Match', '*']]);
add('etag-mismatch', 'GET', '/etag', [['If-None-Match', '"nope"']]);
add('etag-no-cache', 'GET', '/etag', [['If-None-Match', weak], ['Cache-Control', 'no-cache']]);
add('etag-no-cache-in-list', 'GET', '/etag', [['If-None-Match', weak], ['Cache-Control', 'max-age=0, no-cache']]);
add('etag-post-not-fresh', 'POST', '/etag', [['If-None-Match', weak]]);
add('etag-if-modified-since-only', 'GET', '/etag', [['If-Modified-Since', 'Sun, 06 Nov 1994 08:49:37 GMT']]);
add('etag-head-match', 'HEAD', '/etag', [['If-None-Match', weak]]);
add('etag-on-404-json', 'GET', '/v1/nope', [['If-None-Match', tag('{"error":"not_found"}')]]);
add('head-json', 'HEAD', '/users/1');
add('head-text', 'HEAD', '/text');

// Query strings (qs).
add('query-nested', 'GET', '/query?a[b][c]=1&a[d]=2');
add('query-arrays', 'GET', '/query?a[]=1&a[]=2&b=1&b=2&b=3');
add('query-sparse', 'GET', '/query?s[2]=x&s[0]=y');
add('query-overflow-index', 'GET', '/query?a[1001]=x&b[999]=y');
add('query-depth', 'GET', '/query?d[a][b][c][d][e][f][g]=1');
add('query-mixed-merge', 'GET', '/query?a[b]=1&a=2&c=&c[d]=3&e[x]=1&e[0]=2');
add('query-key-order', 'GET', '/query?b=1&2=x&a=3&1=y');
add('query-encoded-brackets', 'GET', '/query?a%5Bb%5D=1&a%5bc%5d=2');
add('query-plus-and-percent', 'GET', '/query?p=a+b&q=a%20b&r=100%25');
add('query-non-ascii', 'GET', '/query?e=%F0%9F%98%80&r=%D7%A9%D7%9C%D7%95%D7%9D&c=e%CC%81&k%C3%A9y=v');
add('query-malformed', 'GET', '/query?bad=%E0%A4%A&ok=1&worse=%');
add('query-prototype', 'GET', '/query?__proto__=x&n[__proto__]=y&hasOwnProperty=z&constructor=c');
add('query-empty-parts', 'GET', '/query?&&=x&noval&k=');
add('query-empty', 'GET', '/query?');
add('query-thousand-limit', 'GET', `/query?${manyQuery}`);

// JSON bodies.
add('json-object', 'POST', '/echo', [JSON_CT], utf8('{"a":1,"b":[true,null,"x"],"c":{"d":"é😀"}}'));
add('json-array', 'POST', '/echo', [JSON_CT], utf8('[1,2,{"x":"y"}]'));
add('json-non-ascii', 'POST', '/echo', [JSON_CT], utf8('{"rtl":"שלום","emoji":"👍🏽","comb":"é"}'));
add('json-escapes', 'POST', '/echo', [JSON_CT], utf8(`{"e":"a${BS}u00e9${BS}ud83d${BS}ude00${BS}n${BS}t${BS}"${BS}${BS}/"}`));
add('json-lone-surrogate', 'POST', '/echo', [JSON_CT], utf8(`{"a":"x${BS}ud800y","b":"${BS}udc00"}`));
add('json-key-order', 'POST', '/echo', [JSON_CT], utf8('{"b":1,"2":2,"a":3,"1":4,"01":5}'));
add('json-duplicate-keys', 'POST', '/echo', [JSON_CT], utf8('{"a":1,"b":2,"a":3}'));
add('json-bom', 'POST', '/echo', [JSON_CT], b64(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"bom":true}')])));
add('json-invalid-utf8', 'POST', '/echo', [JSON_CT], b64(Buffer.concat([Buffer.from('{"x":"a'), Buffer.from([0xff, 0xfe]), Buffer.from('b"}')])));
add('json-empty-body', 'POST', '/echo', [JSON_CT], utf8(''));
add('json-whitespace-only', 'POST', '/echo', [JSON_CT], utf8('  \n'));
add('json-strict-string', 'POST', '/echo', [JSON_CT], utf8('"str"'));
add('json-strict-number', 'POST', '/echo', [JSON_CT], utf8(' 123'));
add('json-malformed', 'POST', '/echo', [JSON_CT], utf8('{"a":'));
add('json-trailing-garbage', 'POST', '/echo', [JSON_CT], utf8('{"a":1} x'));
add('json-charset-upper', 'POST', '/echo', [['Content-Type', 'application/json; charset=UTF-8']], utf8('{"a":1}'));
add('json-charset-latin1', 'POST', '/echo', [['Content-Type', 'application/json; charset=latin1']], utf8('{"a":1}'));
add('json-charset-utf32', 'POST', '/echo', [['Content-Type', 'application/json; charset=utf-32']], utf8('{"a":1}'));
add('json-charset-utf16le', 'POST', '/echo', [['Content-Type', 'application/json; charset=utf-16le']], b64(Buffer.from('{"u":"ü😀"}', 'utf16le')));
add(
  'json-charset-utf16-bom',
  'POST',
  '/echo',
  [['Content-Type', 'application/json; charset=utf-16']],
  b64(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"u":"ü"}', 'utf16le')])),
);
add('json-content-type-suffix', 'POST', '/echo', [['Content-Type', 'application/vnd.api+json']], utf8('{"a":1}'));
add('json-content-type-text', 'POST', '/echo', [['Content-Type', 'text/plain']], utf8('{"a":1}'));
add('json-content-type-invalid', 'POST', '/echo', [['Content-Type', 'application/json;']], utf8('{"a":1}'));
add('json-no-content-type', 'POST', '/echo', [], utf8('{"a":1}'));
add('json-no-body', 'POST', '/echo', [JSON_CT]);
add('json-put', 'PUT', '/echo', [JSON_CT], utf8('{"put":true}'));
add('json-at-limit', 'POST', '/echo', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 } });
add('json-over-limit', 'POST', '/echo', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 + 1 } });
add('json-chunked', 'POST', '/echo', [JSON_CT], utf8('{"chunked":true}'), { chunked: true });
add('json-chunked-over-limit', 'POST', '/echo', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 + 10 } }, { chunked: true });
add('json-gzip', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], b64(zlib.gzipSync('{"gz":"ü"}')));
add('json-deflate', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'deflate']], b64(zlib.deflateSync('{"df":1}')));
add('json-encoding-upper', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'GZIP']], b64(zlib.gzipSync('{"gz":2}')));
add('json-encoding-identity', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'identity']], utf8('{"id":1}'));
add('json-encoding-br', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'br']], utf8('{"a":1}'));
add('json-gzip-garbage', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], utf8('not gzip at all'));
add('json-gzip-truncated', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], b64(zlib.gzipSync('{"gz":"truncated"}').subarray(0, 20)));
add('json-gzip-inflates-over-limit', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], b64(zlib.gzipSync(`{"pad":"${'a'.repeat(110 * 1024)}"}`)));
add('json-gzip-empty', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], utf8(''));
add('json-big-route-1mb', 'POST', '/big/echo', [JSON_CT], { gen: { type: 'json-pad', size: 1024 * 1024 } });
add('json-mid-route-over', 'POST', '/mid/echo', [JSON_CT], { gen: { type: 'json-pad', size: 1024 * 1024 + 1 } });
add('json-mid-route-at', 'POST', '/mid/echo', [JSON_CT], { gen: { type: 'json-pad', size: 1024 * 1024 } });
add('json-four-route-over', 'POST', '/four/echo', [JSON_CT], { gen: { type: 'json-pad', size: 4 * 1024 * 1024 + 1 } });
add('json-big-route-over', 'POST', '/big/echo', [JSON_CT], { gen: { type: 'json-pad', size: 5 * 1024 * 1024 + 1 } });
add('json-get-with-body', 'GET', '/query', [JSON_CT], utf8('{"ignored":true}'));

// urlencoded bodies.
add('form-nested', 'POST', '/echo', [FORM_CT], utf8('a[b][c]=1&a[d]=2&list[]=x&list[]=y&dup=1&dup=2'));
add('form-plus-and-utf8', 'POST', '/echo', [FORM_CT], utf8('q=a+b%2Bc&e=%F0%9F%98%80&raw=😀é'));
add('form-array-limit-100', 'POST', '/echo', [FORM_CT], utf8('a[150]=x&b[50]=y'));
add('form-depth-ok', 'POST', '/form-summary', [FORM_CT], { gen: { type: 'form-depth', depth: 32 } });
add('form-depth-exceeded', 'POST', '/echo', [FORM_CT], { gen: { type: 'form-depth', depth: 33 } });
add('form-params-at-limit', 'POST', '/form-summary', [FORM_CT], { gen: { type: 'form-params', count: 1000 } });
add('form-params-over-limit', 'POST', '/echo', [FORM_CT], { gen: { type: 'form-params', count: 1001 } });
add('form-charset-latin1', 'POST', '/echo', [['Content-Type', 'application/x-www-form-urlencoded; charset=latin1']], utf8('a=1'));
add('form-charset-utf8-upper', 'POST', '/echo', [['Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8']], utf8('a=1'));
add('form-empty', 'POST', '/echo', [FORM_CT], utf8(''));
add('form-over-limit', 'POST', '/echo', [FORM_CT], { gen: { type: 'form-pad', size: 100 * 1024 + 1 } });

// Raw bodies.
add('raw-bytes', 'POST', '/hook', [JSON_CT], b64(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"sig":"é"}'), Buffer.from([0xff])])));
add('raw-wrong-type', 'POST', '/hook', [['Content-Type', 'text/plain']], utf8('{"a":1}'));
add('raw-empty', 'POST', '/hook', [JSON_CT], utf8(''));
add('raw-no-body', 'POST', '/hook', [JSON_CT]);
add('raw-gzip', 'POST', '/hook', [JSON_CT, ['Content-Encoding', 'gzip']], b64(zlib.gzipSync('{"raw":1}')));
add('raw-over-limit', 'POST', '/hook', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 + 1 } });

// Dotted literals in paths ('.' is literal, not a wildcard).
add('dotted-well-known', 'GET', '/.well-known/thing');
add('dotted-well-known-miss', 'GET', '/xwell-known/thing');
add('dotted-segment', 'GET', '/a.b/c');
add('dotted-segment-miss', 'GET', '/aXb/c');
add('dotted-file', 'GET', '/files.json');
add('dotted-file-case', 'GET', '/FILES.JSON');
add('dotted-file-miss', 'GET', '/filesXjson');

// Encoded and malformed parameters through nested mounts.
add('nested-param-encoded-slash', 'GET', '/widgets/a%2Fb/duel/state', [AUTH]);
add('nested-param-emoji', 'GET', '/widgets/%F0%9F%98%80/duel/state', [AUTH]);
add('nested-param-latin-no-merge', 'GET', '/widgets/caf%C3%A9/plain/state', [AUTH]);
add('nested-param-malformed-mount', 'GET', '/widgets/%E0%A4%A/duel/state', [AUTH]);
add('nested-param-malformed-no-auth', 'GET', '/widgets/%E0%A4%A/duel/state');
add('nested-param-malformed-leaf', 'GET', '/widgets/chan/duel/item/%E0%A4%A', [AUTH]);
add('nested-param-encoded-leaf', 'GET', '/widgets/Chan/duel/item/a%20b%2Bc', [AUTH]);
add('nested-param-rtl-leaf', 'GET', '/widgets/%D7%A9%D7%9C%D7%95%D7%9D/duel/item/e%CC%81', [AUTH]);
add('nested-pathless-malformed', 'GET', '/analytics/streams/%E0%A4%A');
add('nested-pathless-encoded', 'GET', '/analytics/streams/%D7%A9%D7%9C%D7%95%D7%9D');

// Numbers as JSON.parse holds them.
add(
  'json-numbers',
  'POST',
  '/echo',
  [JSON_CT],
  utf8('{"n":9007199254740993,"m":-9007199254740993,"big":18446744073709551615,"f":1.0,"e":1e2,"z":-0,"frac":0.1,"arr":[1.5e300,123456789012345678901234567890]}'),
);
add('json-number-infinity', 'POST', '/echo', [JSON_CT], utf8('{"n":1e400}'));

// qs sparse indices (600 keys, each nested 32 times at index 599): cheap in V8 and here.
add('form-sparse-nested', 'POST', '/echo', [FORM_CT], { gen: { type: 'form-sparse', keys: 600, index: 599, depth: 32 } });

// Size boundaries: every body limit exactly at and one over.
add('json-chunked-at-limit', 'POST', '/form-summary', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 } }, { chunked: true });
add('json-chunked-over-by-one', 'POST', '/echo', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 + 1 } }, { chunked: true });
add('json-gzip-inflates-at-limit', 'POST', '/form-summary', [JSON_CT, ['Content-Encoding', 'gzip']], b64(zlib.gzipSync(generate({ type: 'json-pad', size: 100 * 1024 }))));
add('json-gzip-inflates-over-by-one', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], b64(zlib.gzipSync(generate({ type: 'json-pad', size: 100 * 1024 + 1 }))));
add('json-gzip-empty-members', 'POST', '/echo', [JSON_CT, ['Content-Encoding', 'gzip']], {
  gen: { type: 'repeat', base64: zlib.gzipSync('').toString('base64'), count: 10000 },
});
add('form-at-limit', 'POST', '/form-summary', [FORM_CT], { gen: { type: 'form-pad', size: 100 * 1024 } });
add('form-over-by-one', 'POST', '/form-summary', [FORM_CT], { gen: { type: 'form-pad', size: 100 * 1024 + 1 } });
add('raw-at-limit', 'POST', '/raw-length', [['Content-Type', 'application/octet-stream']], { gen: { type: 'json-pad', size: 100 * 1024 } });
add('raw-over-by-one', 'POST', '/raw-length', [['Content-Type', 'application/octet-stream']], { gen: { type: 'json-pad', size: 100 * 1024 + 1 } });
add('raw-hook-at-limit', 'POST', '/hook', [JSON_CT], { gen: { type: 'json-pad', size: 100 * 1024 } });
add('docs-at-limit', 'POST', '/docs/ask', [JSON_CT], { gen: { type: 'json-pad', size: 256 * 1024 } });
add('docs-over-by-one', 'POST', '/docs/ask', [JSON_CT], { gen: { type: 'json-pad', size: 256 * 1024 + 1 } });
add('json-four-route-at', 'POST', '/four/echo', [JSON_CT], { gen: { type: 'json-pad', size: 4 * 1024 * 1024 } });
add('json-big-route-at', 'POST', '/big/echo', [JSON_CT], { gen: { type: 'json-pad', size: 5 * 1024 * 1024 } });
add('json-mid-route-over-by-one-chunked', 'POST', '/mid/echo', [JSON_CT], { gen: { type: 'json-pad', size: 1024 * 1024 + 1 } }, { chunked: true });

// express.static: files, index, directory redirect, fall-through, dotfiles, names.
add('static-file', 'GET', '/hello.txt');
add('static-head', 'HEAD', '/hello.txt');
add('static-index', 'GET', '/');
add('static-index-file', 'GET', '/index.html');
add('static-dir-index', 'GET', '/dir/');
add('static-dir-redirect', 'GET', '/dir');
add('static-dir-redirect-query', 'GET', '/dir?x=1&y=%C3%A9');
add('static-dir-redirect-head', 'HEAD', '/dir');
add('static-dir-redirect-double-slash', 'GET', '//dir');
add('static-dir-redirect-accept-json', 'GET', '/dir', [['Accept', 'application/json']]);
add('static-empty-dir-redirect', 'GET', '/empty-dir');
add('static-empty-dir-slash', 'GET', '/empty-dir/');
add('static-speech-redirect', 'GET', '/speech/chan1');
add('static-speech-slash', 'GET', '/speech/chan1/');
add('static-speech-route', 'GET', '/speech/chan2');
add('static-speech-wav', 'GET', '/speech/chan1/one.wav');
add('static-speech-mp3', 'GET', '/speech/chan1/one.mp3');
add('static-download', 'GET', '/downloads/123-clip.mp4');
add('static-dotfile', 'GET', '/.env');
add('static-dotfile-encoded', 'GET', '/%2eenv');
add('static-dot-directory', 'GET', '/.well-known/thing.txt');
add('static-latin-names', 'GET', '/caf%C3%A9/men%C3%BC.txt');
add('static-emoji-directory', 'GET', '/%F0%9F%98%80/smile.txt');
add('static-emoji-name', 'GET', '/emoji-%F0%9F%98%80.txt');
add('static-rtl-name', 'GET', '/%D7%A9%D7%9C%D7%95%D7%9D.txt');
add('static-space', 'GET', '/with%20space.txt');
add('static-percent', 'GET', '/percent%25.txt');
add('static-upper', 'GET', '/UPPER.TXT');
add('static-upper-miss', 'GET', '/upper.txt');
add('static-no-extension', 'GET', '/noext');
add('static-css', 'GET', '/styles/app.css');
add('static-js', 'GET', '/script.js');
add('static-json', 'GET', '/data.json');
add('static-empty-file', 'GET', '/empty.txt');
add('static-big', 'GET', '/big.bin');
add('static-post-falls-through', 'POST', '/hello.txt');
add('static-options-cors', 'OPTIONS', '/hello.txt');
add('static-traversal', 'GET', '/../hello.txt');
add('static-traversal-encoded', 'GET', '/%2e%2e/hello.txt');
add('static-traversal-nested', 'GET', '/dir/..%2f..%2fhello.txt');
add('static-traversal-inside-root', 'GET', '/dir/%2e%2e/hello.txt');
add('static-traversal-backslash', 'GET', '/dir%5c..%5chello.txt');
add('static-null-byte', 'GET', '/hello.txt%00.png');
add('static-malformed', 'GET', '/hello%E0%A4%A.txt');
add('static-malformed-hex', 'GET', '/%zz');

// Conditional requests.
add('static-etag-match', 'GET', '/hello.txt', [['If-None-Match', fileTag('hello.txt')]]);
add('static-etag-strong-form', 'GET', '/hello.txt', [['If-None-Match', fileTag('hello.txt').slice(2)]]);
add('static-etag-head', 'HEAD', '/hello.txt', [['If-None-Match', fileTag('hello.txt')]]);
add('static-etag-no-cache', 'GET', '/hello.txt', [['If-None-Match', fileTag('hello.txt')], ['Cache-Control', 'no-cache']]);
add('static-ims-match', 'GET', '/hello.txt', [['If-Modified-Since', lastModified]]);
add('static-ims-later', 'GET', '/hello.txt', [['If-Modified-Since', later]]);
add('static-ims-earlier', 'GET', '/hello.txt', [['If-Modified-Since', earlier]]);
add('static-ims-rfc850', 'GET', '/hello.txt', [['If-Modified-Since', 'Friday, 02-Jan-26 03:04:05 GMT']]);
add('static-ims-asctime', 'GET', '/hello.txt', [['If-Modified-Since', 'Fri Jan  2 03:04:05 2026']]);
add('static-ims-garbage', 'GET', '/hello.txt', [['If-Modified-Since', 'not a date']]);
add('static-if-match', 'GET', '/hello.txt', [['If-Match', fileTag('hello.txt')]]);
add('static-if-match-star', 'GET', '/hello.txt', [['If-Match', '*']]);
add('static-if-match-fails', 'GET', '/hello.txt', [['If-Match', '"nope"']]);
add('static-if-match-empty-list', 'GET', '/hello.txt', [['If-Match', ', ,']]);
add('static-ius-fails', 'GET', '/hello.txt', [['If-Unmodified-Since', earlier]]);
add('static-ius-holds', 'GET', '/hello.txt', [['If-Unmodified-Since', lastModified]]);

// Ranges.
add('static-range-first', 'GET', '/hello.txt', [['Range', 'bytes=0-4']]);
add('static-range-suffix', 'GET', '/hello.txt', [['Range', 'bytes=-5']]);
add('static-range-open', 'GET', '/hello.txt', [['Range', 'bytes=30-']]);
add('static-range-one-byte', 'GET', '/hello.txt', [['Range', 'bytes=0-0']]);
add('static-range-past-end', 'GET', '/hello.txt', [['Range', 'bytes=30-1000']]);
add('static-range-multiple', 'GET', '/hello.txt', [['Range', 'bytes=0-4,10-14']]);
add('static-range-overlap', 'GET', '/hello.txt', [['Range', 'bytes=0-4,3-8']]);
add('static-range-adjacent', 'GET', '/hello.txt', [['Range', 'bytes=10-14,0-4,5-9']]);
add('static-range-unsatisfiable', 'GET', '/hello.txt', [['Range', 'bytes=100-200']]);
add('static-range-malformed', 'GET', '/hello.txt', [['Range', 'bytes=abc']]);
add('static-range-reversed', 'GET', '/hello.txt', [['Range', 'bytes=5-2']]);
add('static-range-suffix-zero', 'GET', '/hello.txt', [['Range', 'bytes=-0']]);
add('static-range-no-equals', 'GET', '/hello.txt', [['Range', 'bytes']]);
add('static-range-other-unit', 'GET', '/hello.txt', [['Range', 'items=0-4']]);
add('static-range-empty-file', 'GET', '/empty.txt', [['Range', 'bytes=0-']]);
add('static-range-head', 'HEAD', '/hello.txt', [['Range', 'bytes=0-4']]);
add('static-range-if-range-tag', 'GET', '/hello.txt', [['Range', 'bytes=0-4'], ['If-Range', fileTag('hello.txt')]]);
add('static-range-if-range-stale-tag', 'GET', '/hello.txt', [['Range', 'bytes=0-4'], ['If-Range', '"other"']]);
add('static-range-if-range-date', 'GET', '/hello.txt', [['Range', 'bytes=0-4'], ['If-Range', lastModified]]);
add('static-range-if-range-old-date', 'GET', '/hello.txt', [['Range', 'bytes=0-4'], ['If-Range', earlier]]);
add('static-range-across-chunks', 'GET', '/big.bin', [['Range', 'bytes=65530-65545']]);
add('static-range-not-modified', 'GET', '/hello.txt', [['Range', 'bytes=0-4'], ['If-None-Match', fileTag('hello.txt')]]);

// res.sendFile.
add('sendfile-text', 'GET', '/sendfile/text');
add('sendfile-head', 'HEAD', '/sendfile/text');
add('sendfile-range', 'GET', '/sendfile/text', [['Range', 'bytes=2-5']]);
add('sendfile-range-unsatisfiable', 'GET', '/sendfile/text', [['Range', 'bytes=999-']]);
add('sendfile-not-modified', 'GET', '/sendfile/text', [['If-None-Match', fileTag('hello.txt')]]);
add('sendfile-typed', 'GET', '/sendfile/typed');
add('sendfile-status', 'GET', '/sendfile/status');
add('sendfile-no-store', 'GET', '/sendfile/no-store');
add('sendfile-missing', 'GET', '/sendfile/missing');
add('sendfile-directory', 'GET', '/sendfile/dir');
add('sendfile-dotfile', 'GET', '/sendfile/dotfile');
add('sendfile-relative', 'GET', '/sendfile/relative');
add('sendfile-emoji', 'GET', '/sendfile/emoji');
add('sendfile-big', 'GET', '/sendfile/big');
add('sendfile-router-missing', 'GET', '/files-router/missing');
add('sendfile-router-unsatisfiable', 'GET', '/files-router/range', [['Range', 'bytes=999-']]);

// res.type and res.set with mime 1.6.
add('type-unknown-ext', 'GET', '/type-unknown-ext');
add('type-wav', 'GET', '/type-wav');
add('set-manifest-json', 'GET', '/set-manifest-json');

// multer (1.4.5-lts.2 over busboy 1.6.0). Bodies are built from `{ multipart }` specs (below).
const B = 'XyZ-b0undary';
const MP = ['Content-Type', `multipart/form-data; boundary=${B}`];
const disposition = (name, filename) =>
  `form-data${name === undefined ? '' : `; name="${name}"`}${filename === undefined ? '' : `; filename="${filename}"`}`;
const field = (name, value) => ({ headers: [['Content-Disposition', disposition(name)]], data: { utf8: value } });
const filePart = (name, filename, type, data) => ({
  headers: [['Content-Disposition', disposition(name, filename)], ...(type ? [['Content-Type', type]] : [])],
  data,
});
const mp = (parts, extra = {}) => ({ multipart: { boundary: B, parts, ...extra } });
const pat = (size) => ({ gen: { type: 'pattern', size } });

add('upload-disk-ok', 'POST', '/upload/disk', [MP], mp([field('name', 'Clip ✨'), field('triggerName', 'intro_1'), filePart('trigger', 'clip.mp4', 'video/mp4', pat(40))]));
add('upload-disk-utf8-filename', 'POST', '/upload/disk', [MP], mp([filePart('trigger', '😀 clip.MP4', 'video/mp4', pat(10))]));
add('upload-disk-filename-star', 'POST', '/upload/disk', [MP], mp([
  { headers: [['Content-Disposition', `form-data; name="trigger"; filename="x.png"; filename*=utf-8''%F0%9F%98%80%20caf%C3%A9.png`], ['Content-Type', 'image/png']], data: pat(8) },
]));
add('upload-disk-filtered', 'POST', '/upload/disk', [MP], mp([field('name', 'n'), filePart('trigger', 'notes.txt', 'text/plain', { utf8: 'hello' })]));
add('upload-disk-no-file', 'POST', '/upload/disk', [MP], mp([field('name', 'only fields'), field('triggerName', 't')]));
add('upload-disk-other-field', 'POST', '/upload/disk', [MP], mp([filePart('other', 'clip.mp4', 'video/mp4', pat(4))]));
add('upload-disk-two-files', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'a.mp4', 'video/mp4', pat(4)), filePart('trigger', 'b.mp4', 'video/mp4', pat(4))]));
add('upload-disk-size-under', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'clip.mp4', 'video/mp4', pat(63))]));
add('upload-disk-size-at', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'clip.mp4', 'video/mp4', pat(64))]));
add('upload-disk-size-over', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'clip.mp4', 'video/mp4', pat(65)), field('after', 'x')]));
add('upload-disk-empty-filename', 'POST', '/upload/disk', [MP], mp([filePart('trigger', '', 'application/octet-stream', { utf8: '' })]));
add('upload-disk-empty-filename-typed', 'POST', '/upload/disk', [MP], mp([filePart('trigger', '', 'video/mp4', { utf8: 'becomes a field' })]));
add('upload-disk-octet-without-filename', 'POST', '/upload/disk', [MP], mp([filePart('trigger', undefined, 'application/octet-stream', pat(4))]));
add('upload-disk-windows-path', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'C:\\fakepath\\clip.mp4', 'video/mp4', pat(4))]));
add('upload-disk-traversal-name', 'POST', '/upload/disk', [MP], mp([filePart('trigger', '../../etc/clip.mp4', 'video/mp4', pat(4))]));
add('upload-disk-dotdot-name', 'POST', '/upload/disk', [MP], mp([filePart('trigger', '..', 'video/mp4', pat(4))]));
add('upload-disk-missing-field-name', 'POST', '/upload/disk', [MP], mp([field(undefined, 'orphan')]));
add('upload-disk-nameless-file', 'POST', '/upload/disk', [MP], mp([filePart(undefined, 'clip.mp4', 'video/mp4', pat(4))]));
add('upload-disk-truncated', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'clip.mp4', 'video/mp4', pat(30))], { close: false, cut: 20 }));
add('upload-disk-truncated-headers', 'POST', '/upload/disk', [MP], { multipart: { boundary: B, raw: `--${B}\r\nContent-Disposition: form-data; name="x"` } });
add('upload-disk-malformed-header', 'POST', '/upload/disk', [MP], mp([{ headers: [['Content-Disposition', disposition('name')], ['Bad Header', 'x']], data: { utf8: 'v' } }]));
add('upload-disk-no-boundary', 'POST', '/upload/disk', [['Content-Type', 'multipart/form-data']], mp([field('name', 'x')]));
add('upload-disk-mixed', 'POST', '/upload/disk', [['Content-Type', `multipart/mixed; boundary=${B}`]], mp([field('name', 'x')]));
add('upload-disk-json', 'POST', '/upload/disk', [JSON_CT], utf8('{"a":1}'));
add('upload-disk-no-body', 'POST', '/upload/disk', [MP]);
add('upload-disk-preamble-epilogue', 'POST', '/upload/disk', [MP], mp([field('name', 'x'), filePart('trigger', 'p.png', 'image/png', pat(5))], { preamble: 'This is the preamble.', epilogue: 'and an epilogue\r\n' }));
add('upload-disk-upper-case-headers', 'POST', '/upload/disk', [MP], mp([
  { headers: [['CONTENT-DISPOSITION', 'FORM-DATA; NAME="name"'], ['Content-Type', 'TEXT/PLAIN; CHARSET=LATIN1']], data: { base64: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64') } },
]));
add('upload-disk-quoted-escapes', 'POST', '/upload/disk', [MP], mp([
  { headers: [['Content-Disposition', 'form-data; name="a\\"b"']], data: { utf8: '1' } },
  { headers: [['Content-Disposition', 'form-data; name="c\\\\d"']], data: { utf8: '2' } },
  { headers: [['Content-Disposition', 'form-data; name="e\\f"']], data: { utf8: '3' } },
]));
add('upload-disk-nested-fields', 'POST', '/upload/disk', [MP], mp([
  field('a[b]', '1'), field('a[c]', '2'), field('list[]', 'x'), field('list[]', 'y'), field('arr[1]', 'z'), field('dup', '1'), field('dup', '2'), field('2', 'two'), field('__proto__', 'p'),
]));
add('upload-disk-unicode-fields', 'POST', '/upload/disk', [MP], mp([field('ключ', 'שלום 😀 é'), field('emoji', '👍🏽'), field('rtl', 'مرحبا')]));
add('upload-disk-folded-header', 'POST', '/upload/disk', [MP], mp([{ headers: [['Content-Disposition', 'form-data;\r\n name="folded"']], data: { utf8: 'v' } }]));
add('upload-disk-crlf-in-data', 'POST', '/upload/disk', [MP], mp([filePart('trigger', 'c.csv', 'text/csv', { utf8: `a\r\n--${B.slice(0, 5)}\r\n--\r\nb` })]));
add('upload-disk-quoted-boundary', 'POST', '/upload/disk', [['Content-Type', 'multipart/form-data; boundary="a b:c"']], { multipart: { boundary: 'a b:c', parts: [field('name', 'q')] } });
add('upload-disk-chunked', 'POST', '/upload/disk', [MP], mp([field('name', 'chunked'), filePart('trigger', 'clip.mp4', 'video/mp4', pat(20))]), { chunked: true });
add('upload-disk-stray-after-delimiter', 'POST', '/upload/disk', [MP], { multipart: { boundary: B, raw: `--${B}junk\r\nContent-Disposition: form-data; name="hidden"\r\n\r\nv\r\n--${B}\r\nContent-Disposition: form-data; name="seen"\r\n\r\nw\r\n--${B}--\r\n` } });
add('upload-disk-no-disposition', 'POST', '/upload/disk', [MP], mp([{ headers: [['Content-Type', 'text/plain']], data: { utf8: 'skipped' } }, field('name', 'kept')]));
add('upload-disk-transfer-encoding', 'POST', '/upload/disk', [MP], mp([{ headers: [['Content-Disposition', disposition('trigger', 't.png')], ['Content-Type', 'image/png'], ['Content-Transfer-Encoding', 'BINARY']], data: pat(3) }]));
add('upload-stream-ok', 'POST', '/upload/stream', [MP], mp([filePart('file', 'design.png', 'image/png', pat(30))]));
add('upload-stream-at-limit', 'POST', '/upload/stream', [MP], mp([filePart('file', 'design.png', 'image/png', pat(50))]));
add('upload-stream-over-limit', 'POST', '/upload/stream', [MP], mp([filePart('file', 'design.png', 'image/png', pat(51))]));
add('upload-stream-field', 'POST', '/upload/stream', [MP], mp([field('name', 'x'), filePart('file', 'design.png', 'image/png', pat(3))]));
add('upload-stream-two-files', 'POST', '/upload/stream', [MP], mp([filePart('file', 'one.png', 'image/png', pat(3)), filePart('file', 'two.png', 'image/png', pat(3))]));
add('upload-stream-two-parts', 'POST', '/upload/stream', [MP], mp([filePart('file', 'one.png', 'image/png', pat(3)), { headers: [['X-Nothing', '1']], data: { utf8: 'ignored' } }]));
add('upload-fields-ok', 'POST', '/upload/fields', [MP], mp([field('one', 'a'), field('two', 'b'), field('three', 'c')]));
add('upload-fields-value-under', 'POST', '/upload/fields', [MP], mp([field('v', 'x'.repeat(15))]));
add('upload-fields-value-at', 'POST', '/upload/fields', [MP], mp([field('v', 'x'.repeat(16))]));
add('upload-fields-value-over', 'POST', '/upload/fields', [MP], mp([field('v', 'x'.repeat(17))]));
add('upload-fields-value-utf8-at', 'POST', '/upload/fields', [MP], mp([field('v', 'ü'.repeat(8))]));
add('upload-fields-too-many', 'POST', '/upload/fields', [MP], mp([field('a', '1'), field('b', '2'), field('c', '3'), field('d', '4')]));
add('upload-fields-name-at', 'POST', '/upload/fields', [MP], mp([field('n'.repeat(12), 'v')]));
add('upload-fields-name-over', 'POST', '/upload/fields', [MP], mp([field('n'.repeat(13), 'v')]));
add('upload-fields-name-utf8', 'POST', '/upload/fields', [MP], mp([field('ñ'.repeat(7), 'v')]));
add('upload-fields-parts-under', 'POST', '/upload/fields', [MP], mp([field('a', '1'), field('b', '2'), filePart('x', undefined, 'application/octet-stream', pat(1)), filePart('y', undefined, 'application/octet-stream', pat(1))]));
add('upload-fields-parts-at', 'POST', '/upload/fields', [MP], mp([field('a', '1'), field('b', '2'), filePart('x', undefined, 'application/octet-stream', pat(1)), filePart('y', undefined, 'application/octet-stream', pat(1)), filePart('z', undefined, 'application/octet-stream', pat(1))]));
add('upload-middleware-ok', 'POST', '/upload/middleware', [MP], mp([field('name', 'm'), filePart('trigger', 'm.mp4', 'video/mp4', pat(9))]));
add('upload-middleware-error', 'POST', '/upload/middleware', [MP], mp([filePart('trigger', 'm.mp4', 'video/mp4', pat(65))]));

// ---------------------------------------------------------------------------------------------

function multipartBody(spec) {
  if (spec.raw !== undefined) return Buffer.from(spec.raw);
  const pieces = [];
  if (spec.preamble !== undefined) pieces.push(Buffer.from(`${spec.preamble}\r\n`));
  for (const part of spec.parts) {
    const head = part.headers.map(([name, value]) => `${name}: ${value}\r\n`).join('');
    pieces.push(Buffer.from(`--${spec.boundary}\r\n${head}\r\n`), bodyBytes(part.data), Buffer.from('\r\n'));
  }
  if (spec.close !== false) pieces.push(Buffer.from(`--${spec.boundary}--\r\n`));
  if (spec.epilogue !== undefined) pieces.push(Buffer.from(spec.epilogue));
  const body = Buffer.concat(pieces);
  return spec.cut === undefined ? body : body.subarray(0, body.length - spec.cut);
}

function generate(spec) {
  switch (spec.type) {
    case 'json-pad': {
      const shell = '{"pad":""}';
      return Buffer.from(`{"pad":"${'a'.repeat(spec.size - shell.length)}"}`);
    }
    case 'form-pad':
      return Buffer.from(`pad=${'a'.repeat(spec.size - 4)}`);
    case 'form-params':
      return Buffer.from(Array.from({ length: spec.count }, (_, i) => `k${i}=${i}`).join('&'));
    case 'form-depth':
      return Buffer.from(`a${'[x]'.repeat(spec.depth)}=1`);
    case 'form-sparse':
      return Buffer.from(
        Array.from({ length: spec.keys }, (_, i) => `k${i}${`[${spec.index}]`.repeat(spec.depth)}=v`).join('&'),
      );
    case 'pattern':
      return pattern(spec.size);
    case 'repeat':
      return Buffer.concat(Array(spec.count).fill(Buffer.from(spec.base64, 'base64')));
    default:
      throw new Error(`unknown generator ${spec.type}`);
  }
}

function bodyBytes(body) {
  if (!body) return null;
  if (body.utf8 !== undefined) return Buffer.from(body.utf8, 'utf8');
  if (body.base64 !== undefined) return Buffer.from(body.base64, 'base64');
  if (body.multipart !== undefined) return multipartBody(body.multipart);
  return generate(body.gen);
}

function requestBytes(c) {
  const lines = [`${c.method} ${c.path} HTTP/1.1`, 'Host: localhost', 'Connection: close'];
  for (const [name, value] of c.headers) lines.push(`${name}: ${value}`);
  const body = bodyBytes(c.body);
  let payload = Buffer.alloc(0);
  if (body) {
    if (c.chunked) {
      lines.push('Transfer-Encoding: chunked');
      const parts = [];
      for (let at = 0; at < body.length; at += 16384) {
        const piece = body.subarray(at, at + 16384);
        parts.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'));
      }
      parts.push(Buffer.from('0\r\n\r\n'));
      payload = Buffer.concat(parts);
    } else {
      lines.push(`Content-Length: ${body.length}`);
      payload = body;
    }
  }
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]);
}

function parseResponse(raw, method) {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.subarray(0, split).toString('latin1').split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const headers = {};
  for (const line of head.slice(1)) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim().toLowerCase();
    (headers[name] ??= []).push(line.slice(at + 1).trim());
  }
  let body = raw.subarray(split + 4);
  if (method === 'HEAD') body = Buffer.alloc(0);
  else if ((headers['transfer-encoding'] ?? []).includes('chunked')) {
    const out = [];
    let at = 0;
    for (;;) {
      const eol = body.indexOf('\r\n', at);
      const size = parseInt(body.subarray(at, eol).toString('latin1'), 16);
      if (!size) break;
      out.push(body.subarray(eol + 2, eol + 2 + size));
      at = eol + 2 + size + 2;
    }
    body = Buffer.concat(out);
  }
  return { status, headers, body };
}

function send(port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve(Buffer.concat(chunks)) : reject(e)));
    socket.write(bytes);
  });
}

const server = buildApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address();
const recorded = [];
for (const c of cases) {
  const raw = await send(port, requestBytes(c));
  const { status, headers, body } = parseResponse(raw, c.method);
  const text = body.toString('utf8');
  const response = { status, headers, bodyBase64: body.toString('base64') };
  if (Buffer.from(text, 'utf8').equals(body) && body.length <= 4096) response.bodyText = text;
  recorded.push({ ...c, response });
}
server.close();
rmSync(staticRoot, { recursive: true, force: true });
rmSync(uploadDir, { recursive: true, force: true });

const out = {
  note: 'Generated by record.mjs; do not edit by hand.',
  node: process.version,
  express: require('express/package.json').version,
  bodyParser: require('body-parser/package.json').version,
  qs: require('qs/package.json').version,
  cors: require('cors/package.json').version,
  serveStatic: require('serve-static/package.json').version,
  send: require('send/package.json').version,
  multer: require('multer/package.json').version,
  busboy: require('busboy/package.json').version,
  staticMtimeMs: STATIC_MTIME_MS,
  staticDirs: STATIC_DIRS,
  staticFiles: STATIC_FILES.map(([name, bytes]) => ({ path: name, base64: bytes.toString('base64') })),
  cases: recorded,
};
writeFileSync(path.join(here, 'express.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${recorded.length} cases`);
