/** Records the frozen reference `utils/thumbnail_generator.ts` for tests/thumbnails.rs.
 *
 * Run from the main checkout's dimabot directory, with the local stores' environment loaded
 * (`eval "$(dima-rust/tools/test-env)"`) and the fake ffmpeg first on PATH for this run only:
 *
 *   BIN=$(mktemp -d) && cp <worktree>/dima-rust/crates/platform/tests/fake-ffmpeg.sh $BIN/ffmpeg &&
 *   chmod 755 $BIN/ffmpeg && cd "$DIMABOT_DIR" && TZ=UTC PATH="$BIN:$PATH" GEN_TMPDIR=$(mktemp -d) \
 *   FAKE_FFMPEG_LOG=$BIN/log node_modules/.bin/tsx \
 *   <worktree>/dima-rust/crates/platform/tests/record-thumbnails.mts \
 *   <worktree>/dima-rust/crates/platform/tests/thumbnails-reference.json
 *
 * Imports only the generator, its schema and `utils/s3.ts` (an S3 client object, no I/O on
 * import). S3 and the source fetch go to a mock on 127.0.0.1:18744; MongoDB is a throwaway
 * `dima_test_platform_<random>` database, dropped at the end. `crypto.randomBytes` for the
 * generator's 6- and 8-byte names returns a per-case byte, and `mongoose.now` a fixed instant.
 * GEN_TMPDIR becomes the generator's `os.tmpdir()` (tsx itself keeps the system one: its IPC
 * socket path must stay short).
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
const root = process.cwd();
const require = createRequire(`${root}/package.json`);
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const NOW = 1794355200000;
const PORT = 18744;
const PUBLIC = 'https://cdn.test/examplebucket';
if (process.env.GEN_TMPDIR) process.env.TMPDIR = process.env.GEN_TMPDIR;
Object.assign(process.env, {
  S3_REGION: 'us-east-1', S3_ENDPOINT_URL: `http://127.0.0.1:${PORT}`, S3_BUCKET: 'examplebucket',
  S3_ACCESS_KEY: 'AKIDEXAMPLE', S3_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', S3_PUBLIC_URL: PUBLIC,
});
let caseByte = 0;
const realRandomBytes = crypto.randomBytes;
(crypto as any).randomBytes = (n: number, cb?: unknown) =>
  (n === 6 || n === 8) && cb === undefined ? Buffer.alloc(n, caseByte) : (realRandomBytes as any)(n, cb);
mongoose.now = () => new Date(NOW);

const oid = (n: number) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const base = (n: number, mediaType: string, mimeType: string, extension: string, extra: Record<string, unknown> = {}) => ({
  _id: oid(n), ownerUserID: '656ec726be85da7a473664ad', ownerChannelID: '533538623', ownerChannelName: 'cdom201',
  uploadedByUserID: '656ec726be85da7a473664ad', originalName: `Clip_${n}.${extension}`, displayName: `Clip_${n}`,
  fileName: `abababababab-Clip_${n}-1773261735099.${extension}`, extension, mimeType, mediaType, bytes: 1000 + n,
  bucket: 'examplebucket', s3Key: `533538623/triggers/abababababab-Clip_${n}-1773261735099.${extension}`,
  storageUrl: `http://127.0.0.1:${PORT}/examplebucket/533538623/triggers/abababababab-Clip_${n}-1773261735099.${extension}`,
  scope: 'private', ...extra,
});
// [name, random byte, parent (null: id 99 is never stored), source status, source body]
const cases: [string, number, any, number, string][] = [
  ['video', 0x11, base(1, 'video', 'video/mp4', 'mp4'), 200, 'VIDEO-SOURCE'],
  ['image', 0x22, base(2, 'image', 'image/png', 'png'), 200, 'PNG-SOURCE'],
  ['gif', 0x33, base(3, 'gif', 'image/gif', 'gif', { scope: 'public', marketplaceStatus: 'published' }), 200, 'GIF-SOURCE'],
  ['audio', 0x44, base(4, 'audio', 'audio/mpeg', 'mp3'), 200, 'AUDIO'],
  ['already_ready', 0x55, base(5, 'video', 'video/mp4', 'mp4', { thumbnailStatus: 'ready', thumbnailAssetID: oid(500) }), 200, 'X'],
  ['ready_without_asset', 0x66, base(6, 'video', 'video/mp4', 'mp4', { thumbnailStatus: 'ready', thumbnailAttempts: 2 }), 200, 'VIDEO-AGAIN'],
  ['missing_parent', 0x77, null, 200, 'X'],
  ['ffmpeg_fails', 0x88, base(8, 'video', 'video/mp4', 'mp4'), 200, 'FAIL-SOURCE'],
  ['tiny_output', 0x99, base(9, 'image', 'image/jpeg', 'jpg'), 200, 'TINY-SOURCE'],
  ['no_output', 0xaa, base(10, 'image', 'image/webp', 'webp'), 200, 'NONE-SOURCE'],
  ['source_404', 0xbb, base(11, 'video', 'video/webm', 'webm'), 404, '<Error><Code>NoSuchKey</Code></Error>'],
  ['text_names', 0xcc, base(12, 'image', 'image/png', 'png', {
    originalName: 'Mejor País 🇨🇱 שלום é.png', displayName: 'Mejor_País_é_😀', fileName: 'abababababab-x-1.png',
  }), 200, 'PNG-TEXT'],
];

async function main() {
  const out = process.argv[2];
  const log = process.env.FAKE_FFMPEG_LOG!;
  if (!out || !log) throw new Error('usage: record-thumbnails.mts <out.json> (FAKE_FFMPEG_LOG set)');
  const sources = new Map<string, [number, string]>();
  let requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    // The SDK's own diagnostics, host, date and signature vary per run and machine.
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) =>
      !['user-agent', 'x-amz-user-agent', 'amz-sdk-invocation-id', 'amz-sdk-request', 'authorization', 'x-amz-date', 'host', 'connection'].includes(k)));
    requests.push({ method: req.method, target: req.url, headers, body: body.toString('base64') });
    const source = req.method === 'GET' ? sources.get(req.url ?? '') : undefined;
    if (source) { res.statusCode = source[0]; res.end(source[1]); return; }
    res.statusCode = req.method === 'PUT' ? 200 : 404;
    res.end();
  });
  await new Promise<void>(r => server.listen(PORT, '127.0.0.1', r));
  const db = `dima_test_platform_${randomUUID().replaceAll('-', '')}`;
  const generatorPath = `${root}/src/utils/thumbnail_generator.ts`;
  try {
    await mongoose.connect(process.env.DIMA_TEST_MONGO_URI, { dbName: db });
    const { MediaAssetSchema: M } = await import(`${root}/src/schemas/media_asset.schema.ts`);
    const { generateAndStoreThumbnail } = await import(generatorPath);
    await M.init();
    const docs = async () => EJSON.serialize(await M.collection.find({}, { promoteValues: false }).sort({ _id: 1 }).toArray(), { relaxed: false });
    const recorded = [];
    for (const [name, byte, parent, status, body] of cases) {
      await M.deleteMany({});
      if (parent) {
        await M.create(parent);
        sources.set(`/examplebucket/${parent.s3Key}`, [status, body]);
      }
      const seed = await docs();
      caseByte = byte;
      requests = [];
      await writeFile(log, '');
      let error = null;
      try { await generateAndStoreThumbnail(parent ? parent._id : oid(99)); } catch (e: any) { error = String(e?.message ?? e); }
      const ffmpeg = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(l => l.split('\0').filter(Boolean));
      recorded.push({ name, byte, parentID: (parent ? parent._id : oid(99)).toHexString(), source: body, sourceStatus: status, seed, error, ffmpeg, requests, documents: await docs() });
    }
    const sha256 = createHash('sha256').update(await readFile(generatorPath)).digest('hex');
    const json = JSON.stringify({ sha256, now: NOW, publicUrl: PUBLIC, cases: recorded }, null, 2);
    const tmp = process.env.GEN_TMPDIR;
    await writeFile(out, (tmp ? json.replaceAll(tmp, '<tmp>') : json) + '\n');
  } finally {
    if (mongoose.connection.readyState) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise<void>(r => server.close(() => r()));
  }
}
main().then(() => process.exit(process.exitCode ?? 0), e => { console.error(e); process.exit(1); });
