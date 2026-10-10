// Requires saas-ops disposable Mongo/Redis and overlay-fixtures provider mocks.
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('alert-dedupe-check');
const redis = await getDragonflyClient('alert-dedupe-check');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { DomainEventSchema } = await import('/app/dist/schemas/domain_event.schema.js');
const channel = '990301', token = 'alert-dedupe-owner';
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'pro' });
await redis.hSet(`token:${token}`, { id: channel, login: 'fixture', display_name: 'Fixture' });
const base = 'http://127.0.0.1:3000';
const data = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(!(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) }); assert.equal(r.status, 200, await r.clone().text()); return (await r.json()).data; };
const get = (path, headers = {}) => new Promise((resolve, reject) => { http.request(base + path, { headers }, r => { const chunks = []; r.on('data', b => chunks.push(b)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) })); }).on('error', reject).end(); });

// A published alert sound is revalidated like pictures, so OBS can reuse its bytes.
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-threads', '1', '/tmp/alert-dedupe.wav']);
const form = new FormData(); form.append('file', new Blob([await readFile('/tmp/alert-dedupe.wav')]), 'ding.wav');
const sound = await data('POST', '/asset-library/' + channel, form);
let state = await data('GET', '/overlay-studio/' + channel);
state.designs[0].events.sub.sound = { assetId: sound.id, volume: 1, delay: 0, fadeIn: 0, fadeOut: 0 };
state.designs[0].events.sub.widgets[1].text = '$(user)';
state = await data('PUT', '/overlay-studio/' + channel, state);
const scene = state.scenes[0];
state = await data('POST', `/overlay-studio/${channel}/scenes/${scene.id}/publish`, { revision: state.revision });
const soundPath = `/overlay-studio/public/${scene.publicId}/assets/${sound.id}`;
const first = await get(soundPath); assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'private, no-cache'); assert(first.headers.etag);
assert.equal((await get(soundPath, { 'If-None-Match': first.headers.etag })).status, 304);
const access = await data('GET', `/asset-library/${channel}/${sound.id}/access`);
assert.match((await get(access.path)).headers['cache-control'], /no-store/, 'private library previews are unchanged');

const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket'), ns = `/overlay-studio/${scene.publicId}`, messages = [];
ws.addEventListener('message', event => { const m = String(event.data); if (m.startsWith('0')) ws.send(`40${ns},${JSON.stringify({ clientId: crypto.randomUUID() })}`); else if (m === '2') ws.send('3'); else messages.push(m); });
const events = () => messages.filter(m => m.startsWith(`42${ns},`)).map(m => JSON.parse(m.slice(m.indexOf(',') + 1))).filter(e => e[0] === 'overlay-event').map(e => e[1]);
const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(label + ': ' + JSON.stringify(events())); };
await until(() => messages.some(m => m.includes('overlay-state')), 'overlay state');
await new Promise(r => setTimeout(r, 1200));
let n = 0;
const journal = (type, event, at = Date.now()) => DomainEventSchema.create({ eventKey: `dedupe-${++n}`, source: 'twitch-eventsub', sourceEventId: `dedupe-${n}`, type, topic: 'channel', channelID: channel, schemaVersion: 1, occurredAt: new Date(at), journaledAt: new Date(at), expiresAt: new Date(Date.now() + 600000), payload: { event }, metadata: {} });
// A three-sub gift bomb, then one viewer's subscribe + resub message pair, then a follow sentinel.
const gift = await journal('channel.subscription.gifted', { user_id: 'gifter', user_name: 'Gifter', total: 3, tier: '1000', is_anonymous: false });
for (const id of ['r1', 'r2', 'r3']) await journal('channel.subscription.received', { user_id: id, user_name: id, tier: '1000', is_gift: true });
const subscribe = await journal('channel.subscription.received', { user_id: 'u1', user_name: 'Returning', tier: '1000', is_gift: false });
await journal('channel.subscription.received', { user_id: 'u1', user_name: 'Returning', tier: '1000', cumulative_months: 49, message: { text: 'hi' } });
const other = await journal('channel.subscription.received', { user_id: 'u2', user_name: 'Second', tier: '2000', is_gift: false });
const follow = await journal('channel.follow.received', { user_id: 'f1', user_name: 'Follower' });
await until(() => events().some(e => e.id === `alert-${follow._id}`), 'follow sentinel delivered');
const subs = events().filter(e => e.kind === 'sub').map(e => e.id);
assert.deepEqual(subs, [`alert-${gift._id}`, `alert-${subscribe._id}`, `alert-${other._id}`], 'one alert per gift and per subscribing viewer');
const giftAlert = await data('GET', `/overlay-studio/public/${scene.publicId}/events/alert-${gift._id}`);
assert.equal(giftAlert.layouts[state.designs[0].id].widgets[1].text, 'Gifter');
assert.equal(giftAlert.layouts[state.designs[0].id].sound.assetId, sound.id);
ws.close();
console.log('PASS actual API journal: gift bomb plays one gifter alert, subscribe+resub pair plays once, other viewers/follows unaffected; published sound 200/304 with private previews unchanged');
process.exit(0);
