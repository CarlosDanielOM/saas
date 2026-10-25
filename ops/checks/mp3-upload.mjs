// Exact-image HTTP check. Use only saas-ops disposable MongoDB/Redis and the
// mp3-upload fixture provider; no production credentials or object storage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { MediaAssetSchema } from '/app/dist/schemas/media_asset.schema.js';
import { UserMediaLibraryItemSchema } from '/app/dist/schemas/user_media_library_item.schema.js';

await getMongoDBConnection('mp3-upload-check');
const redis = await getDragonflyClient('mp3-upload-check');
const free = '997731', pro = '997732';
for (const [id, tier] of [[free, 'free'], [pro, 'pro']]) {
    await Users.collection.insertOne({ accounts: [{ type: 'twitch', id, name: `fixture_${id}` }], plan_tier: tier });
    await redis.hSet(`token:mp3-${id}`, { id, login: `fixture_${id}`, display_name: 'Fixture' });
    await redis.hSet(`accounts:twitch:${id}:data`, { id, name: `fixture_${id}`, plan_tier: tier });
}
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '/tmp/upload-fixture.mp3']);
const bytes = await readFile('/tmp/upload-fixture.mp3');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const form = (mime = 'audio/mpeg', name = 'Chime', body = bytes) => {
    const data = new FormData();
    data.append('trigger', new Blob([body], { type: mime }), 'sindignidad.mp3');
    data.append('name', name);
    data.append('scope', 'private');
    return data;
};
async function request(body, status, channel = free, actor = channel) {
    const response = await fetch(`http://127.0.0.1:3000/triggers/library/${channel}/upload`, {
        method: 'POST', body, headers: actor ? { Authorization: `Bearer mp3-${actor}` } : {}
    });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json;
}
for (const [mime, channel, name] of [['audio/mpeg', free, 'Standard_MP3'], ['audio/mp3', free, 'Legacy_MP3'], ['audio/mpeg', pro, 'Private_MP3']]) {
    const result = await request(form(mime, name), 201, channel);
    assert.equal(result.error, false);
    const asset = await MediaAssetSchema.findOne({ ownerChannelID: channel, displayName: name }).lean();
    assert.ok(asset, 'asset persisted');
    assert.equal(asset.mimeType, mime);
    assert.equal(asset.mediaType, 'audio');
    assert.equal(asset.extension, 'mp3');
    assert.equal(asset.bytes, bytes.length);
    assert.equal(asset.thumbnailStatus, 'skipped');
    assert.equal(asset.scope, channel === free ? 'public' : 'private');
    const item = await UserMediaLibraryItemSchema.findOne({ assetID: asset._id }).lean();
    assert.equal(item.quotaBytesCharged, channel === free ? 0 : bytes.length);
    assert.equal(item.relationType, 'owner_upload');
}
console.log('PASS standard and legacy MP3 multipart uploads, free/public and pro/private persistence and quota');
const rejected = await request(form('application/x-msdownload'), 400);
assert.equal(rejected.message, 'No file uploaded or file type not allowed');
assert.equal((await request(new FormData(), 400)).message, rejected.message);
await request(form('audio/mpeg', 'Too_large', Buffer.alloc(5 * 1024 * 1024 + 1)), 400);
await request(form(), 401, free, '');
await request(form(), 403, pro, free);
await request(form('audio/mpeg', 'Storage_failure'), 500);
assert.equal(await MediaAssetSchema.countDocuments(), 3, 'failures do not persist assets');
assert.equal(await UserMediaLibraryItemSchema.countDocuments(), 3, 'failures do not persist library items');
// Give the response callback's finally block a bounded opportunity to unlink.
for (let pass = 0; pass < 20; pass++) {
    if ((await readdir('/tmp/dimabot-trigger-uploads')).length === 0) break;
    await new Promise(resolve => setTimeout(resolve, 25));
}
assert.deepEqual(await readdir('/tmp/dimabot-trigger-uploads'), [], 'temporary uploads cleaned after success and failure');
const stored = (await readFile('/tmp/saas-fixtures/storage.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(stored.length, 3);
for (const entry of stored) {
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, sha256);
    assert.ok(['audio/mpeg', 'audio/mp3'].includes(entry.contentType));
}
console.log('PASS unsupported/missing/oversize rejection, auth/permissions, storage failure, unchanged MP3 bytes and temp cleanup');
process.exit(0);
