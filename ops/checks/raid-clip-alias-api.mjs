// API check: raid chat event settings save from the dashboard (2026-11-17, sedrami report).
// The production raid template names its clip checkbox `dbId: 'enableClip'`, while rows and the
// raid handler use `clipEnabled`; since 9e1e29c2 every page save of a raid was refused with
// 400 "Invalid raid event settings". This builds the request exactly as the page does
// (dimasite getConfigPersistenceKey: dbId, else fallback, else id) and checks it is stored.
// Use with ops/checks/raid-direction-fixtures (test-env.json + providers.mjs mock Twitch).
import assert from 'node:assert/strict';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Eventsub from '/app/dist/schemas/eventsub.schema.js';
import { EventSchema as Events } from '/app/dist/schemas/event.schema.js';

if (process.env.SAAS_TARGET !== 'api') throw new Error('raid-clip-alias-api.mjs runs against the api target only');
await getMongoDBConnection('raid-clip-alias-check');
const redis = await getDragonflyClient('raid-clip-alias-check');
await Promise.all([Eventsub.init(), Events.init()]);

const channel = '99007701', now = Date.now();
await Users.create({ name: 'Raid Clip Fixture', accounts: [{ type: 'twitch', id: channel, name: 'raidclipfixture', actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'raidclipfixture', actived: 'true', has_permissions: 'true', chat_enabled: 'true', access_token: 'dummy', expires_at: String(Math.floor(now / 1000) + 3600) });
await redis.set('app:twitch:token', 'app-token');
await redis.hSet('token:raid-clip-owner', { id: channel, login: 'raidclipfixture', display_name: 'Fixture' });

// The production catalog row for incoming raids, controls copied from db.events (2026-11-17).
await Events.create({
    name: 'Raids', type: 'channel.raid', version: '1', icon: 'Users', color: 'bg-blue-500', textColor: 'text-white',
    releaseStage: 'stable', enabled: false, plan_tier: 'free', condition: { to_broadcaster_user_id: 'user' },
    description: { EN: 'Message to show when another channel raids your channel', ES: 'Mensaje que se enviará cuando otro canal te raide' },
    tierLimits: { free: 0, premium: 2, pro: 5 },
    config: [
        { id: 'raidMessage', dbId: 'message', label: { EN: 'Raid Message', ES: 'Mensaje de Raide' }, type: 'text', value: '$(raid channel) is now raiding $(twitch channel)', canDisable: true },
        { id: 'enableClip', dbId: 'enableClip', label: { EN: 'Enable Clip', ES: 'Habilitar Clip' }, type: 'checkbox', value: false, canDisable: true },
        { id: 'minViewers', dbId: 'minViewers', label: { EN: 'Minimum Viewers', ES: 'Mínimo de Viewers' }, type: 'number', value: 2, canDisable: true, showIf: { controlId: 'enableClip', is: true } }
    ]
});

const api = 'http://127.0.0.1:3000';
const request = async (path, method = 'GET', body) => {
    const response = await fetch(api + path, {
        method, headers: { Authorization: 'Bearer raid-clip-owner', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
};

// Same key mapping as dimasite chat-events.contract.ts getConfigPersistenceKey.
const FALLBACKS = { adBeginMessage: 'message', adBreakMessage: 'message', beginMessage: 'message', enableClip: 'clipEnabled' };
const pageKey = control => control.dbId?.trim() || FALLBACKS[control.id] || control.id;
const catalog = await request('/site/events');
assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
const raid = catalog.body.data.find(row => row.type === 'channel.raid');
assert.ok(raid, 'raid catalog entry');
const pagePayload = values => Object.fromEntries(raid.config.map(control => [pageKey(control), control.id in values ? values[control.id] : control.value]));
assert.ok('enableClip' in pagePayload({}), 'the page still sends enableClip for the raid clip checkbox');

// 1. Turning the event on: the page POSTs the catalog defaults as config.
let res = await request(`/eventsubs/${channel}`, 'POST', { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: channel }, config: pagePayload({ enableClip: true }) });
assert.equal(res.status, 201, JSON.stringify(res.body));
let row = await Eventsub.findOne({ channelID: channel, type: 'channel.raid' }).lean();
assert.equal(row.clipEnabled, true);
assert.equal(row.minViewers, 2);
assert.equal('enableClip' in row, false);
const id = String(row._id);

// 2. Configure → Save: what sedrami sent (every control by its page key).
res = await request(`/eventsubs/${channel}/${id}`, 'PATCH', pagePayload({ raidMessage: 'Welcome $(raid.channel) and $(raid.viewers) raiders!', enableClip: false, minViewers: 7 }));
assert.equal(res.status, 200, JSON.stringify(res.body));
row = await Eventsub.findById(id).lean();
assert.equal(row.message, 'Welcome $(raid.channel) and $(raid.viewers) raiders!');
assert.equal(row.clipEnabled, false);
assert.equal(row.minViewers, 7);
assert.equal('enableClip' in row, false);

// 3. Turning the clip back on through the same form.
res = await request(`/eventsubs/${channel}/${id}`, 'PATCH', pagePayload({ raidMessage: 'Back on', enableClip: true, minViewers: 3 }));
assert.equal(res.status, 200, JSON.stringify(res.body));
row = await Eventsub.findById(id).lean();
assert.deepEqual([row.message, row.clipEnabled, row.minViewers], ['Back on', true, 3]);

// 4. The raid field list still refuses anything else, and the on/off switch still works.
res = await request(`/eventsubs/${channel}/${id}`, 'PATCH', { enableClip: true, endMessage: 'nope' });
assert.deepEqual([res.status, res.body?.message], [400, 'Invalid raid event settings']);
res = await request(`/eventsubs/${channel}/${id}`, 'PATCH', { enabled: false });
assert.equal(res.status, 200, JSON.stringify(res.body));
assert.equal((await Eventsub.findById(id).lean()).enabled, false);

// 5. The page reads it back: GET returns the stored clipEnabled.
res = await request(`/eventsubs/${channel}?type=channel.raid`);
assert.equal(res.status, 200, JSON.stringify(res.body));
assert.equal(res.body.data[0].clipEnabled, true);
assert.equal(res.body.data[0].message, 'Back on');

console.log('PASS API: raid page saves with enableClip store clipEnabled (POST + PATCH), other fields still refused, on/off unchanged');
process.exit(0);
