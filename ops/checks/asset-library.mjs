import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const jwt = require('jsonwebtoken');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const mongo = await getMongoDBConnection('asset-test'), redis = await getDragonflyClient('asset-test');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { Libraries, uploadAsset } = await import('/app/dist/assets/library.js');
const { Studio } = await import('/app/dist/overlays/store.js');
await Studio.init();
const base = 'http://127.0.0.1:3000';
const accounts = { free: '991001', premium: '991002', pro: '991003' };
for (const [tier, id] of Object.entries(accounts)) {
  await Users.collection.insertOne({ accounts: [{ type: 'twitch', id }], plan_tier: tier });
  await redis.hSet(`token:asset-${id}`, { id, login: `fixture${id}`, display_name: 'Fixture' });
}
async function req(method, path, body, status = 200, owner = accounts.pro, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...(owner ? { Authorization: `Bearer asset-${owner}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  if (response.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${response.status}: ${await response.text()}`);
  return response;
}
const data = async (...args) => (await (await req(...args)).json()).data;
await req('GET', `/asset-library/${accounts.pro}`, null, 401, '');
await req('GET', `/asset-library/${accounts.pro}`, null, 403, accounts.free);
for (const [tier, limit] of Object.entries({ free: 100_000_000, premium: 500_000_000, pro: 5_000_000_000 })) {
  const library = await data('GET', `/asset-library/${accounts[tier]}`, null, 200, accounts[tier]);
  assert.equal(library.quotaBytes, limit); assert.equal(library.usedBytes, 0); assert.deepEqual(library.assets, []);
}
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=32x32', '-frames:v', '1', '-threads', '1', '/tmp/asset-image.png']);
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=32x32:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '/tmp/asset-video.mp4']);
const png = await readFile('/tmp/asset-image.png'), video = await readFile('/tmp/asset-video.mp4');
const form = (bytes = png, name = 'background.png', mime = 'image/png') => { const body = new FormData(); body.append('file', new Blob([bytes], { type: mime }), name); return body; };
const upload = (owner, bytes = png, name, mime, status = 200) => data('POST', `/asset-library/${owner}`, form(bytes, name, mime), status, owner);
// Disconnect halfway through a multipart upload; the same owner must be able to retry.
await new Promise(resolve => {
  const request = http.request(base + `/asset-library/${accounts.pro}`, { method: 'POST', headers: { Authorization: `Bearer asset-${accounts.pro}`, 'Content-Type': 'multipart/form-data; boundary=asset-abort' } });
  request.on('error', () => resolve());
  request.write('--asset-abort\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n');
  request.write(png.subarray(0, 16));
  setTimeout(() => request.destroy(new Error('Intentional fixture disconnect')), 150);
});
await new Promise(resolve => setTimeout(resolve, 150));
const asset = await upload(accounts.pro);
assert.equal(asset.mime, 'image/png'); assert.equal(asset.width, 32); assert.equal(asset.bytes, png.length);
const movie = await upload(accounts.pro, video, 'loop.mp4', 'video/mp4'); assert.equal(movie.kind, 'video');
const freeAsset = await upload(accounts.free); const premiumAsset = await upload(accounts.premium);
assert.equal((await data('GET', `/asset-library/${accounts.pro}`)).usedBytes, png.length + video.length);
await req('POST', `/asset-library/${accounts.pro}`, new FormData(), 400);
await upload(accounts.pro, Buffer.from('<svg onload="alert(1)"></svg>'), 'fake.png', 'image/png', 415);
await upload(accounts.pro, png.subarray(0, 12), 'broken.png', 'image/png', 415);
await upload(accounts.pro, Buffer.alloc(0), 'empty.png', 'image/png', 413);
const beforeOversize = (await data('GET', `/asset-library/${accounts.pro}`)).usedBytes;
await upload(accounts.pro, Buffer.alloc(50_000_001), 'huge.png', 'image/png', 413);
assert.equal((await data('GET', `/asset-library/${accounts.pro}`)).usedBytes, beforeOversize);
await req('GET', `/asset-library/${accounts.pro}/${freeAsset.id}/access`, null, 404);
await req('DELETE', `/asset-library/${accounts.pro}/${asset.id}`, null, 403, accounts.free);
await req('GET', `/media/${asset.id}`, null, 404, '');
await req('GET', `/asset-library/content/${asset.id}`, null, 401, '');
const access = await data('GET', `/asset-library/${accounts.pro}/${asset.id}/access`);
const content = await req('GET', access.path, null, 200, '');
assert.deepEqual(Buffer.from(await content.arrayBuffer()), png); assert.match(content.headers.get('cache-control'), /no-store/);
assert.equal(content.headers.get('content-type'), 'image/png'); assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
await req('GET', access.path.replace(asset.id, freeAsset.id), null, 401, '');
const expired = jwt.sign({ owner: accounts.pro }, process.env.SECRET_KEY, { audience: 'asset-preview', subject: asset.id, expiresIn: -1 });
await req('GET', `/asset-library/content/${asset.id}?ticket=${expired}`, null, 401, '');
const partial = await req('GET', access.path, null, 206, '', { Range: 'bytes=1-7' }); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(1, 8));
const suffix = await req('GET', access.path, null, 206, '', { Range: 'bytes=-5' }); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), png.subarray(-5));
await req('GET', access.path, null, 416, '', { Range: `bytes=${png.length}-` });
await req('GET', access.path, null, 416, '', { Range: 'bytes=0-1,4-5' });
assert.equal((await req('HEAD', access.path, null, 200, '')).headers.get('content-length'), String(png.length));
// Boundary and concurrent reservation checks use only disposable documents/files.
for (const [tier, limit] of Object.entries({ free: 100_000_000, premium: 500_000_000, pro: 5_000_000_000 })) {
  const owner = accounts[tier], prior = (await Libraries.findById(owner).lean()).usedBytes;
  await Libraries.updateOne({ _id: owner }, { $set: { usedBytes: limit - png.length } });
  const extra = await upload(owner); await upload(owner, png, 'over.png', 'image/png', 413);
  await req('DELETE', `/asset-library/${owner}/${extra.id}`, null, 200, owner);
  assert.equal((await Libraries.findById(owner).lean()).usedBytes, limit - png.length);
  await Libraries.updateOne({ _id: owner }, { $set: { usedBytes: prior } });
}
await Libraries.updateOne({ _id: accounts.free }, { $set: { usedBytes: 100_000_000 - png.length } });
const concurrent = await Promise.allSettled([1, 2].map(() => uploadAsset(accounts.free, { path: '/tmp/asset-image.png', originalname: 'concurrent.png', size: png.length })));
assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await Libraries.findById(accounts.free).lean()).usedBytes, 100_000_000);
await Libraries.updateOne({ _id: accounts.free }, { $set: { usedBytes: png.length * 2 } });
// Draft ownership, compatibility, immutable publication, rotation and deletion guards.
let state = await data('GET', `/overlay-studio/${accounts.pro}`);
const layer = { id: 'private-art', kind: 'image', x: 0, y: 0, width: 320, height: 320, visible: true, locked: false, assetId: asset.id };
state.scenes[0].widgets.push(layer);
state.designs[0].events.follow.widgets.push({ ...layer, id: 'design-art' });
const foreign = structuredClone(state); foreign.scenes[0].widgets.at(-1).assetId = freeAsset.id;
await req('PUT', `/overlay-studio/${accounts.pro}`, foreign, 404);
const wrongKind = structuredClone(state); wrongKind.scenes[0].widgets.at(-1).assetId = movie.id;
await req('PUT', `/overlay-studio/${accounts.pro}`, wrongKind, 400);
state = await data('PUT', `/overlay-studio/${accounts.pro}`, state);
await req('DELETE', `/asset-library/${accounts.pro}/${asset.id}`, null, 409);
const scene = state.scenes[0];
await req('GET', `/overlay-studio/public/${scene.publicId}/assets/${asset.id}`, null, 404, '');
state = await data('POST', `/overlay-studio/${accounts.pro}/scenes/${scene.id}/publish`, { revision: state.revision });
assert.deepEqual(Buffer.from(await (await req('GET', `/overlay-studio/public/${scene.publicId}/assets/${asset.id}`, null, 200, '')).arrayBuffer()), png);
await req('GET', `/overlay-studio/public/${scene.publicId}/assets/${movie.id}`, null, 404, '');
await req('GET', `/overlay-studio/public/${scene.publicId}/assets/${freeAsset.id}`, null, 404, '');
state = await data('POST', `/overlay-studio/${accounts.pro}/scenes/${scene.id}/rotate`, { revision: state.revision });
await req('GET', `/overlay-studio/public/${scene.publicId}/assets/${asset.id}`, null, 404, '');
const rotated = state.scenes[0].publicId;
await req('GET', `/overlay-studio/public/${rotated}/assets/${asset.id}`, null, 200, '');
state.scenes[0].widgets = state.scenes[0].widgets.filter(w => !w.assetId);
state.designs[0].events.follow.widgets = state.designs[0].events.follow.widgets.filter(w => !w.assetId);
state = await data('PUT', `/overlay-studio/${accounts.pro}`, state);
await req('DELETE', `/asset-library/${accounts.pro}/${asset.id}`, null, 409);
state = await data('POST', `/overlay-studio/${accounts.pro}/scenes/${scene.id}/publish`, { revision: state.revision });
await req('GET', `/overlay-studio/public/${rotated}/assets/${asset.id}`, null, 404, '');
await req('DELETE', `/asset-library/${accounts.pro}/${asset.id}`);
await req('GET', access.path, null, 404, '');
assert.equal(await mongo.connection.db.collection('private_assets.chunks').countDocuments({ files_id: new mongo.mongo.ObjectId(asset.id) }), 0);
assert.equal((await data('GET', `/asset-library/${accounts.pro}`)).usedBytes, video.length);
// Downgrade keeps existing assets readable and deletable while rejecting uploads.
await Users.updateOne({ 'accounts.id': accounts.pro }, { $set: { plan_tier: 'free' } });
await Libraries.updateOne({ _id: accounts.pro }, { $set: { usedBytes: 101_000_000 } });
assert.equal((await data('GET', `/asset-library/${accounts.pro}`)).quotaBytes, 100_000_000);
await data('GET', `/asset-library/${accounts.pro}/${movie.id}/access`);
await upload(accounts.pro, png, 'new.png', 'image/png', 413);
await req('DELETE', `/asset-library/${accounts.pro}/${movie.id}`);
// Interrupted uploads are reconciled, including orphan chunks and reserved quota.
const interrupted = new mongo.mongo.ObjectId();
await Libraries.updateOne({ _id: accounts.premium }, { $inc: { usedBytes: 99 }, $push: { assets: { id: interrupted.toHexString(), name: 'interrupted', state: 'uploading', bytes: 99, createdAt: new Date(0).toISOString() } } });
await mongo.connection.db.collection('private_assets.chunks').insertOne({ files_id: interrupted, n: 0, data: Buffer.alloc(99) });
assert.equal((await data('GET', `/asset-library/${accounts.premium}`, null, 200, accounts.premium)).usedBytes, premiumAsset.bytes);
assert.equal(await mongo.connection.db.collection('private_assets.chunks').countDocuments({ files_id: interrupted }), 0);
assert.deepEqual((await readdir('/tmp')).filter(name => name.startsWith('design-asset-')), []);
console.log('PASS Asset Library: actual API upload/read/delete; all tiers and exact boundaries; concurrent reservation; authentication, ownership, signed access/expiry, range/HEAD; invalid/oversize uploads; overlay and alert references, publication, revocation and deletion; downgrade retention and interrupted-upload cleanup.');
process.exit(0);
