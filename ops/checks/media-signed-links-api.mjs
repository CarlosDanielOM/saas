// Signed media links against the real candidate API: disposable Mongo/Redis, no S3 (redirect targets are fixture URLs).
// Run with --fixtures ops/checks/overlay-fixtures --test-env ops/checks/overlay-fixtures/test-env.json (sets SECRET_KEY).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { MediaAssetSchema } = await import('/app/dist/schemas/media_asset.schema.js');
const { UserMediaLibraryItemSchema } = await import('/app/dist/schemas/user_media_library_item.schema.js');
const { ChannelExtensionItemSchema } = await import('/app/dist/schemas/channel_extension_item.schema.js');
const mongo = await getMongoDBConnection('media-signed-links-check'), redis = await getDragonflyClient('media-signed-links-check');
assert(process.env.SECRET_KEY, 'the candidate signs media links (SECRET_KEY set in the test env)');
const sign = id => createHmac('sha256', process.env.SECRET_KEY).update(`media:${id}`).digest('base64url').slice(0, 22);
const signed = id => `https://api.domdimabot.com/media/${id}?k=${sign(id)}`;

const channel = '990401', token = 'media-signed-owner';
const ownerUser = await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel, name: 'mediafixture' }], plan_tier: 'pro' });
await redis.hSet(`token:${token}`, { id: channel, login: 'mediafixture', display_name: 'Fixture' });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'mediafixture', plan_tier: 'pro' });

const now = new Date();
const assetDoc = (key, scope, extra = {}) => ({ ownerUserID: String(ownerUser.insertedId), ownerChannelID: channel, ownerChannelName: 'mediafixture',
  uploadedByUserID: String(ownerUser.insertedId), originalName: `${key}.png`, displayName: `Signed_${key}`, fileName: `${key}.png`, extension: 'png', mimeType: 'image/png', mediaType: 'image', bytes: 100,
  bucket: 'fixture', s3Key: `fixture/media-signed/${key}.png`, storageUrl: `https://fixture.invalid/${key}.png`, proxyPath: null, scope, marketplaceStatus: scope === 'public' ? 'published' : 'not_listed',
  // thumbnailStatus 'skipped': the DimaFX list starts no background thumbnail job for these fixtures.
  thumbnailStatus: 'skipped', libraryCount: 1, triggerReferenceCount: 0, alertReferenceCount: 0, extensionReferenceCount: 0, deletedAt: null, createdAt: now, updatedAt: now, ...extra });
const docs = { private: assetDoc('private', 'private'), public: assetDoc('public', 'public'), system: assetDoc('system', 'system'), gone: assetDoc('gone', 'private', { deletedAt: now }) };
const { getS3PublicObjectUrl } = await import('/app/dist/utils/s3.js');
const stored = key => getS3PublicObjectUrl(`fixture/media-signed/${key}.png`);
const rawIds = Object.fromEntries(Object.entries((await MediaAssetSchema.collection.insertMany(Object.values(docs))).insertedIds).map(([i, id]) => [Object.keys(docs)[i], id]));
const ids = Object.fromEntries(Object.entries(rawIds).map(([key, id]) => [key, String(id)]));
await UserMediaLibraryItemSchema.collection.insertMany(['private', 'public'].map(key => ({ channelID: channel, channelName: 'mediafixture', addedByUserID: String(ownerUser.insertedId),
  assetID: rawIds[key], relationType: 'owner_upload', localAlias: null, quotaBytesCharged: key === 'private' ? 100 : 0, assetScope: key, mediaType: 'image', isActive: true, deletedAt: null, createdAt: now, updatedAt: now })));

const base = 'http://127.0.0.1:3000';
async function data(path) {
  const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const json = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(json).slice(0, 300)}`); return json.data;
}
async function media(path) {
  const response = await fetch(base + path, { redirect: 'manual', headers: { 'User-Agent': 'media-signed-links-check' } });
  return { status: response.status, location: response.headers.get('location') };
}
const local = url => { const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.domdimabot.com'); return parsed.pathname + parsed.search; };

// Responses carry signed playback URLs.
const library = await data(`/triggers/library/${channel}`);
assert.equal(library.length, 2);
for (const item of library) assert.equal(item.asset.playbackUrl, signed(String(item.asset._id)), 'library playbackUrl is signed');
const catalogue = await data(`/triggers/assets/public?id=${ids.public}`);
assert.equal(catalogue.length, 1); assert.equal(catalogue[0].playbackUrl, signed(ids.public), 'public catalogue playbackUrl is signed');
console.log('PASS signed playbackUrl in library and public catalogue responses');

// GET /media/:id. Private: valid k served, wrong k 404, missing k still served (grace period).
assert.deepEqual(await media(local(signed(ids.private))), { status: 307, location: stored('private') });
assert.equal((await media(`/media/${ids.private}?k=${sign(ids.public)}`)).status, 404, 'another asset signature');
assert.equal((await media(`/media/${ids.private}?k=wrong`)).status, 404);
assert.equal((await media(`/media/${ids.private}?k=${sign(ids.private).slice(0, 21)}`)).status, 404, 'truncated signature');
assert.deepEqual(await media(`/media/${ids.private}`), { status: 307, location: stored('private') }, 'grace: unsigned private links still play');
// Public and system: with and without k (even a wrong one).
for (const key of ['public', 'system']) for (const query of ['', `?k=${sign(ids[key])}`, '?k=wrong'])
  assert.deepEqual(await media(`/media/${ids[key]}${query}`), { status: 307, location: stored(key) }, key + query);
// Deleted, unknown and malformed ids.
for (const path of [`/media/${ids.gone}`, local(signed(ids.gone)), `/media/${'f'.repeat(24)}`, `/media/${'f'.repeat(24)}?k=${sign('f'.repeat(24))}`, '/media/not-an-id'])
  assert.equal((await media(path)).status, 404, path);
console.log('PASS GET /media/:id: private valid k 307, wrong k 404, missing k 307 (grace); public/system 307 with or without k; deleted/unknown/malformed 404');

// DimaFX dashboard routes build their links with the same function, and those links resolve.
await ChannelExtensionItemSchema.collection.insertOne({ channelID: channel, channelName: 'mediafixture', createdByUserID: channel, assetID: rawIds.private, name: 'Signed item',
  description: '', category: 'gif', mediaType: 'image', thumbnailUrl: '', durationMs: 0, bitsPrice: 100, sku: 'fixture_sku', volume: 100, isEnabled: true, sortOrder: 0, deletedAt: null, createdAt: now, updatedAt: now });
const [fx] = await data(`/extensions/dimafx/${channel}/items`);
assert.equal(fx.asset.playbackUrl, signed(ids.private)); assert.equal(fx.mediaUrl, signed(ids.private)); assert.equal(fx.thumbnailUrl, signed(ids.private), 'image item: its own playback URL as thumbnail');
for (const url of [fx.asset.playbackUrl, fx.mediaUrl, fx.thumbnailUrl]) assert.equal((await media(local(url))).status, 307, url);
console.log('PASS DimaFX dashboard item URLs are signed and resolve (viewer/internal routes use the same mapper; they need Twitch/service auth and are not exercised here)');

await mongo.connection.close(); redis.destroy();
process.exit(0);
