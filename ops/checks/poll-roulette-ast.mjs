// Poll / prediction read functions, roulette create / delete / clear / fill, and the "Poll ended" and
// "Prediction ended" chat events, through the real engine, roulette service, signed Twitch webhook and
// snapshot cache. Twitch itself is mocked in this process; MongoDB and Dragonfly are disposable.
//
// Runs inside an api, bot or cron candidate (the same code runs commands in all three), with the
// fixtures that already boot each service in isolation:
//   scripts/saas-ops verify api-<run-id> --check ops/checks/poll-roulette-ast.mjs --dependency mongo --dependency redis \
//     --test-env ops/checks/roulette-fixtures/test-env.json --fixtures ops/checks/roulette-fixtures
//   scripts/saas-ops verify bot-<run-id> ... --test-env ops/checks/keywords-fixtures/test-env.json --fixtures ops/checks/keywords-fixtures
//   scripts/saas-ops verify cron-<run-id> ... --test-env ops/checks/roulette-fixtures/cron-env.json --fixtures ops/checks/roulette-fixtures
// Locally: APP_DIST=<dimabot>/src with tsx, MONGO_URI / DRAGONFLY_HOST / DRAGONFLY_PORT pointing at
// disposable databases, and the same TWITCH_EVENTSUB_SECRET / CLIENT_ID / SECRET_KEY test values.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const dist = process.env.APP_DIST || '/app/dist';
const target = process.env.SAAS_TARGET || 'local';
const load = path => import(`${dist}/${path}`);

// --- Twitch, mocked for this process only -------------------------------------------------------
const channel = '99107701', login = 'pollcheck';
const twitch = {
    poll: null, prediction: null, pollReads: 0, predictionReads: 0, chat: [], subs: [], subscribed: [], patches: [],
    /** Run once while Twitch is "answering" a poll read / a poll PATCH (to deliver a notification first). */
    duringPollRead: null, duringPatch: null, refusePatch: false,
    scopes: ['channel:read:polls', 'channel:manage:polls', 'channel:read:predictions', 'channel:manage:predictions', 'channel:bot']
};
const originalFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(options.method || 'GET').toUpperCase();
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, options);
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'app-token', expires_in: 3600, token_type: 'bearer' });
    if (url.hostname === 'api.twitch.tv') {
        const path = url.pathname.replace('/helix/', '');
        if (path === 'chat/messages') { twitch.chat.push(JSON.parse(options.body).message); return json({ data: [{ is_sent: true, message_id: `mock-${twitch.chat.length}` }] }); }
        if (path === 'polls' && method === 'GET') {
            twitch.pollReads++;
            const answer = { data: twitch.poll ? [twitch.poll] : [] };
            if (twitch.duringPollRead) { const hook = twitch.duringPollRead; twitch.duringPollRead = null; await hook(); }
            return json(answer);
        }
        if (path === 'predictions' && method === 'GET') { twitch.predictionReads++; return json({ data: twitch.prediction ? [twitch.prediction] : [] }); }
        if (path === 'polls' && method === 'PATCH') {
            const body = JSON.parse(options.body); twitch.patches.push(body);
            if (twitch.duringPatch) { const hook = twitch.duringPatch; twitch.duringPatch = null; await hook(); }
            if (twitch.refusePatch) { twitch.refusePatch = false; return json({ error: 'Bad Request', status: 400, message: 'poll is not active' }, 400); }
            twitch.poll = { ...twitch.poll, status: body.status, ended_at: new Date().toISOString() };
            return json({ data: [twitch.poll] });
        }
        if (path === 'authorization/users') return json({ data: [{ user_id: channel, user_login: login, scopes: twitch.scopes }] });
        if (path === 'eventsub/subscriptions' && method === 'GET') return json({ data: twitch.subs, total: twitch.subs.length, pagination: {} });
        if (path === 'eventsub/subscriptions' && method === 'POST') {
            const body = JSON.parse(options.body);
            const sub = { id: `sub-${body.type}`, status: 'enabled', type: body.type, version: body.version, condition: body.condition,
                transport: { method: 'webhook', callback: body.transport.callback }, created_at: new Date().toISOString(), cost: 0 };
            twitch.subs.push(sub); twitch.subscribed.push(body.type);
            return json({ data: [sub], total: 1, total_cost: 0, max_total_cost: 10000 }, 202);
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname.endsWith('posthog.com')) return json({ status: 1 });
    throw new Error(`External request blocked in poll/roulette check: ${method} ${url.origin}${url.pathname}`);
};

const { getMongoDBConnection } = await load('utils/databases/mongodb.database.js');
const { getDragonflyClient } = await load('utils/databases/dragonfly.database.js');
const { default: UsersSchema } = await load('schemas/users.schema.js');
const { default: EventsubSchema } = await load('schemas/eventsub.schema.js');
const { DomainEventSchema } = await load('schemas/domain_event.schema.js');
const { ActivityLog } = await load('schemas/activity_log.schema.js');
const { InteractionDisposition } = await load('schemas/interaction_disposition.schema.js');
const { flushActivityLog } = await load('utils/activity_log.js');
const { createTwitchEventsubApp } = await load('bot/eventsub.twitch.js');
const { eventsubHandler } = await load('handlers/eventsub.handler.js');
const { parseSpecialCommands } = await load('handlers/special_parser.handler.js');
const roulette = await load('roulette/service.js');
const { createChannelEventsub, deleteChannelEventsub } = await load('server/services/eventsub_config.service.js');
const { getBuiltinChatEvent, withBuiltinChatEvents } = await load('utils/chat_event_catalog.js');
const { simulateCommand: simulate } = await load('utils/ast_parser/simulate.js');

const mongo = await getMongoDBConnection('PollRouletteCheck');
const redis = await getDragonflyClient('PollRouletteCheck');
await Promise.all([DomainEventSchema.init(), EventsubSchema.init(), ActivityLog.init(), InteractionDisposition.init(), roulette.RouletteChannel.init()]);
const disposition = async id => (await InteractionDisposition.findById(`${channel}:poll:${id}`).lean())?.disposition ?? null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
    assert.fail(`Timed out: ${label}`);
}
const settle = () => sleep(300);

await UsersSchema.create({ name: login, plan_tier: 'free', accounts: [{ type: 'twitch', id: channel, name: login, actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${channel}:data`, {
    id: channel, name: login, actived: 'true', has_permissions: 'true', chat_enabled: 'true',
    access_token: 'dummy-streamer-token', expires_at: String(Math.floor(Date.now() / 1000) + 3600)
});
const priorAppToken = await redis.get('app:twitch:token');
await redis.set('app:twitch:token', 'app-token');

/** Runs command text the way a saved command does, as the streamer. */
async function run(source, argument = '') {
    return (await parseSpecialCommands(source, {
        channelID: channel, scopeType: 'command', scopeName: 'pollcheck', userPlan: 'free', userLevel: 10, argument,
        eventData: { chatter_user_id: channel, chatter_user_login: login, chatter_user_name: 'PollCheck',
            broadcaster_user_id: channel, broadcaster_user_login: login, broadcaster_user_name: 'PollCheck' }
    })).parsedText.trim();
}
const state = () => roulette.snapshot(channel);
const wheel = async alias => (await state()).roulettes.find(item => item.alias === alias);
const labels = async alias => (await wheel(alias)).items.map(item => item.label);
const ttl = key => redis.ttl(key);
const POLL_KEY = `twitch:${channel}:poll:snapshot`, PREDICTION_KEY = `twitch:${channel}:prediction:snapshot`;
const iso = offset => new Date(Date.now() + offset).toISOString();

const helixPoll = (id, status, votes, titles = ['Nuke', 'Mirage', 'Taco Bell']) => ({
    id, broadcaster_id: channel, broadcaster_login: login, title: 'Best map?', status, duration: 7200,
    started_at: startOf(id), ...(status === 'ACTIVE' ? {} : { ended_at: iso(0) }),
    choices: titles.map((title, index) => ({ id: `${id}-c${index + 1}`, title, votes: votes[index], channel_points_votes: 0, bits_votes: 0 }))
});
// Each poll starts a minute after the previous one (poll-a, poll-b, ...), as on Twitch.
const base = Date.now() - 3_600_000;
const startOf = id => new Date(base + (id.charCodeAt(id.length - 1) - 97) * 60_000).toISOString();
const pollEvent = (id, status, votes, titles = ['Nuke', 'Mirage', 'Taco Bell']) => ({
    id, broadcaster_user_id: channel, broadcaster_user_login: login, broadcaster_user_name: 'PollCheck', title: 'Best map?',
    started_at: startOf(id), ...(status ? { status, ended_at: iso(0) } : { ends_at: iso(270_000) }),
    choices: titles.map((title, index) => ({ id: `${id}-c${index + 1}`, title, votes: votes[index], channel_points_votes: 0, bits_votes: 0 }))
});

// --- 1. Roulette functions ------------------------------------------------------------------------
assert.equal(await run('$(roulette.create Polls "Poll tie-breaker")'), '', 'create is silent');
let polls = await wheel('polls');
assert.deepEqual([polls.alias, polls.name, polls.design, polls.items.length], ['polls', 'Poll tie-breaker', 'wheel', 0]);
assert.equal(await run('$(roulette.create polls Another name)'), 'Error: roulette.create: Roulette with that name already exists');
assert.equal((await state()).roulettes.length, 1);
assert.equal(await run('$(roulette.create plain)'), '');
assert.equal((await wheel('plain')).name, 'plain', 'the name defaults to the ID');
assert.match(await run('$(roulette.create "Bad Alias")'), /^Error: roulette\.create: Alias must start with a lowercase letter/);
assert.match(await run('$(roulette.create)'), /^Error: roulette\.create: Usage: \$\(roulette\.create roulette_id \["Name"\]\)$/);

assert.equal(await run('$(roulette.fill polls %[Pizza, "Tacos al pastor"])'), '');
assert.deepEqual(await labels('polls'), ['Pizza', 'Tacos al pastor']);
assert.equal(await run('$(roulette.fill polls "Sushi" "Ramen" "Pho")'), '');
assert.deepEqual(await labels('polls'), ['Sushi', 'Ramen', 'Pho'], 'fill replaces, it does not add');
polls = await wheel('polls');
assert.ok(polls.items.every(item => item.multiplier === 1 && item.weight === 1 && item.copies.length === 1) && polls.order.length === 3);
assert.equal(await run('%(names[] Ana)%(names[] Luis)$(roulette.fill polls %(names))'), '');
assert.deepEqual(await labels('polls'), ['Ana', 'Luis']);
assert.equal(await run('$(roulette.fill polls)'), 'Error: roulette.fill: Usage: $(roulette.fill roulette_id list)');
assert.equal(await run('$(roulette.fill polls "")'), 'Error: roulette.fill: the list is empty; give at least one prize');
assert.deepEqual(await labels('polls'), ['Ana', 'Luis'], 'a refused fill changes nothing');
assert.equal(await run('$(roulette.fill missing "A")'), 'Error: roulette.fill: Roulette not found in this channel');

const added = await run('$(roulette.add polls "Extra" 2 3)');
assert.match(added, /^[\w-]{6,}$/, 'add still returns the new prize ID');
assert.equal(await run('$(roulette.clear polls)'), '');
polls = await wheel('polls');
assert.deepEqual([polls.items.length, polls.order.length, polls.name, polls.design], [0, 0, 'Poll tie-breaker', 'wheel'], 'clear keeps the roulette');
assert.equal(await run('$(roulette.clear missing)'), 'Error: roulette.clear: Roulette not found in this channel');

// Nothing is emptied or deleted under a spin; adding stays allowed (it joins the next spin).
await roulette.execute(channel, { operation: 'configure', roulette: 'polls', data: { durationSeconds: 2 } });
assert.equal(await run('$(roulette.fill polls "Left" "Right")'), '');
assert.equal(await run('$(roulette.start polls)'), '');
const spinning = (await state()).draw;
assert.ok(spinning && spinning.completedAt === null && ['Left', 'Right'].includes(spinning.winner.label));
assert.equal(await run('$(roulette.fill polls "A" "B")'), 'Error: roulette.fill: Roulette is spinning');
assert.equal(await run('$(roulette.clear polls)'), 'Error: roulette.clear: Roulette is spinning');
assert.equal(await run('$(roulette.delete polls)'), 'Error: roulette.delete: Roulette is spinning');
assert.equal(await run('$(roulette.delete plain)'), 'Error: roulette.delete: Roulette is spinning', 'one spin per channel: no deletes meanwhile');
assert.match(await run('$(roulette.add polls "Late entry")'), /^[\w-]{6,}$/);
assert.deepEqual(await labels('polls'), ['Left', 'Right', 'Late entry']);
await until(async () => (await state()).draw?.completedAt !== null, 'the spin finishes', 8_000);
assert.equal(await run('$(roulette.result polls)'), spinning.winner.label);
assert.equal(await run('$(roulette.clear polls)'), '');
assert.equal((await wheel('polls')).items.length, 0);

// Delete: gone for good, and the owner can see which command did it.
assert.equal(await run('$(roulette.fill plain "One" "Two" "Three")'), '');
assert.equal(await run('$(roulette.delete plain)'), '');
assert.equal(await wheel('plain'), undefined);
assert.equal(await run('$(roulette.delete plain)'), 'Error: roulette.delete: Roulette not found in this channel');
await flushActivityLog();
await until(async () => await ActivityLog.countDocuments({ channelID: channel, kind: 'system', name: 'roulette.delete' }) === 1, 'delete recorded once');
const deleted = await ActivityLog.findOne({ channelID: channel, name: 'roulette.delete' }).lean();
assert.deepEqual([deleted.outcome, deleted.data.alias, deleted.data.roulette, deleted.data.prizes, deleted.data.command, deleted.data.source, deleted.actorLogin],
    ['ok', 'plain', 'plain', 3, 'pollcheck', 'command', login]);
assert.match(deleted.text, /Roulette “plain” \(plain\) was deleted by a command/);

// --- 2. Poll reads: one snapshot, no poll, no permission ------------------------------------------
assert.deepEqual([await run('$(poll.status)'), await run('$(poll.options)'), await run('$(poll.total)'), await run('$(poll.result)'), await run('$(poll.tied)')],
    ['none', '', '0', '', '']);
assert.equal(twitch.pollReads, 1, 'five reads of "no poll" asked Twitch once');
await redis.del(POLL_KEY);

twitch.poll = helixPoll('poll-a', 'ACTIVE', [5, 5, 2]);
const pollReads = twitch.pollReads;
const summary = await run('$(poll.title)|$(poll.status)|$(poll.options)|$(poll.values)|$(poll.total)|$(poll.votes Taco Bell)|$(poll.votes 1)|$(poll.result)|$(poll.tied)');
assert.equal(summary, 'Best map?|active|["Nuke","Mirage","Taco Bell"]|[5,5,2]|12|2|5||["Nuke","Mirage"]');
assert.equal(twitch.pollReads, pollReads + 1, 'nine poll functions in one command share one Twitch read');
// Not every notification is subscribed yet: the running snapshot is only kept 5 s, and they get turned on.
assert.ok(await ttl(POLL_KEY) <= 5 && await ttl(POLL_KEY) > 0);
await until(() => twitch.subscribed.length === 3, 'poll notifications subscribed in the background');
assert.deepEqual([...twitch.subscribed].sort(), ['channel.poll.begin', 'channel.poll.end', 'channel.poll.progress']);
assert.equal(await EventsubSchema.countDocuments({ channelID: channel, type: /^channel\.poll\./ }), 3);
await settle();
// Loops and conditions: weighted wheel from the votes, per-option lines.
assert.equal(await run('*(for #o in $(poll.options) { %(lines[] "${#o}: ${$(poll.votes #o)}") })%(lines)'), '["Nuke: 5","Mirage: 5","Taco Bell: 2"]');
assert.equal(await run('$(roulette.clear polls)*(for #o in $(poll.options) { %(ids[] $(roulette.add polls #o 1 $(poll.votes #o))) })done'), 'done');
assert.deepEqual((await wheel('polls')).items.map(item => [item.label, item.weight]), [['Nuke', 5], ['Mirage', 5], ['Taco Bell', 2]]);
assert.equal(await run('*($(poll.total) == 0 ? "nobody voted" : *($(poll.tied) ? "tie" : "leader"))'), 'tie');

// The channel now gets every notification: a Twitch read of a running poll is trusted for the hour.
await redis.del(POLL_KEY);
twitch.poll = helixPoll('poll-a', 'ACTIVE', [6, 5, 2]);
assert.equal(await run('$(poll.result)'), 'Nuke');
assert.ok(await ttl(POLL_KEY) > 3000, 'fed running snapshot lasts up to an hour');
twitch.poll = helixPoll('poll-a', 'ACTIVE', [6, 9, 2]);
assert.equal(await run('$(poll.result)'), 'Nuke', 'no Twitch read while the snapshot is fed');

// A Twitch read overtaken by a notification is dropped (the store script compares generations).
await redis.del(POLL_KEY);
twitch.poll = helixPoll('poll-a', 'ACTIVE', [6, 9, 2]);
const { noteInteractionEvent, readInteraction } = await load('utils/twitch_interactions.js');
twitch.duringPollRead = () => noteInteractionEvent(channel, 'channel.poll.progress', pollEvent('poll-a', null, [7, 9, 3]));
assert.deepEqual((await readInteraction(channel, 'poll')).options.map(option => option.value), [7, 9, 3], 'the reader gets the newer view');
assert.equal(await run('$(poll.values)'), '[7,9,3]', 'and the older Twitch answer was not stored over it');
// Votes only go up: a delayed older progress notification (or a delayed begin) never lowers them.
await noteInteractionEvent(channel, 'channel.poll.progress', pollEvent('poll-a', null, [3, 4, 1]));
await noteInteractionEvent(channel, 'channel.poll.begin', pollEvent('poll-a', null, [0, 0, 0]));
assert.equal(await run('$(poll.values)'), '[7,9,3]');
// A Twitch read still in flight when the snapshot is dropped (a poll was started or ended from here)
// is not stored: the next read asks Twitch again instead of trusting the old answer for an hour.
const { forgetInteraction } = await load('utils/twitch_interactions.js');
await redis.del(POLL_KEY);
twitch.poll = helixPoll('poll-a', 'ACTIVE', [7, 9, 3]);
twitch.duringPollRead = async () => { await forgetInteraction(channel, 'poll'); twitch.poll = helixPoll('poll-a', 'ACTIVE', [8, 9, 3]); };
assert.deepEqual((await readInteraction(channel, 'poll')).options.map(option => option.value), [7, 9, 3], 'the early caller gets what Twitch said then');
assert.equal(await run('$(poll.values)'), '[8,9,3]', 'but it was not stored: the next command reads Twitch again');
// Nine functions of one command read one snapshot, even when a vote lands between them.
twitch.poll = helixPoll('poll-a', 'ACTIVE', [6, 5, 2]);
await redis.del(POLL_KEY);
const slow = run('$(poll.result)|$(delay 1)|$(poll.result)|$(poll.values)');
await sleep(300);
await noteInteractionEvent(channel, 'channel.poll.progress', pollEvent('poll-a', null, [6, 9, 2]));
assert.equal(await slow, 'Nuke||Nuke|[6,5,2]', 'votes arriving mid-command do not split its answers');
assert.equal(await run('$(poll.result)'), 'Mirage', 'the next command sees it');

// --- 3. The signed webhook keeps the snapshot current and runs "Poll ended" -----------------------
const server = createTwitchEventsubApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const webhookURL = `http://127.0.0.1:${server.address().port}/eventsub`;
let sequence = 0;
async function notify(type, event) {
    const payload = { subscription: { id: `sub-${type}`, status: 'enabled', type, version: '1', cost: 0,
        condition: { broadcaster_user_id: channel }, transport: { method: 'webhook', callback: 'https://subscriptions.domdimabot.com/eventsub' },
        created_at: iso(-60_000) }, event };
    const body = JSON.stringify(payload), messageId = `poll-roulette-check-${++sequence}`, timestamp = new Date().toISOString();
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET).update(messageId).update(timestamp).update(body).digest('hex');
    const response = await fetch(webhookURL, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': messageId, 'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Type': 'notification', 'Twitch-Eventsub-Message-Signature': signature
    }, body });
    assert.equal(response.status, 204, `${type} accepted`);
    await settle();
}

const readsBefore = twitch.pollReads;
await notify('channel.poll.progress', pollEvent('poll-a', null, [6, 9, 2]));
assert.equal(await run('$(poll.result)|$(poll.values)|$(poll.status)'), 'Mirage|[6,9,2]|active', 'a progress notification replaces the snapshot');
assert.equal(twitch.pollReads, readsBefore, 'still no Twitch read');
assert.ok(await ttl(POLL_KEY) > 3000);

// The catalog offers the two events, and turning one on stores its default message.
const catalog = withBuiltinChatEvents([]);
for (const type of ['channel.poll.end', 'channel.prediction.end']) {
    const entry = catalog.find(item => item.type === type);
    assert.ok(entry && entry === getBuiltinChatEvent(type));
    assert.deepEqual([entry.version, entry.plan_tier, entry.condition, entry.config[0].id, entry.config[0].canDisable], ['1', 'free', { broadcaster_user_id: 'user' }, 'message', true]);
    assert.ok(entry.description.EN && entry.description.ES && entry.config[0].value.includes(type === 'channel.poll.end' ? 'poll.tied' : 'prediction.result'));
}
// "Poll ended" already has its Twitch subscription (turned on above): the page updates that row.
const endRow = await EventsubSchema.findOne({ channelID: channel, type: 'channel.poll.end' });
assert.deepEqual([endRow.enabled, endRow.message], [true, '']);
const TIE_BREAK = '*($(poll.total) == 0 ? "Nobody voted." : *($(poll.tied) ? "${$(roulette.fill polls $(poll.tied))}${$(roulette.start polls)}Tie! The wheel decides between ${$(poll.tied)}." : "${$(poll.result)} won the poll with ${$(poll.votes $(poll.result))} votes!"))';
await EventsubSchema.updateOne({ _id: endRow._id }, { $set: { message: TIE_BREAK } });

// A clear winner.
twitch.chat.length = 0;
await notify('channel.poll.end', pollEvent('poll-a', 'completed', [6, 9, 2]));
await until(() => twitch.chat.length === 1, 'Poll ended announced the winner');
assert.equal(twitch.chat[0], 'Mirage won the poll with 9 votes!');
// Twitch sends a second end notification when the finished poll is dismissed: nothing runs again.
await notify('channel.poll.end', pollEvent('poll-a', 'archived', [6, 9, 2]));
await sleep(700);
assert.equal(twitch.chat.length, 1, 'one announcement per poll');
// Two deliveries racing for the same poll: exactly one may announce it.
const { claimInteraction } = await load('utils/interaction_dispositions.js');
const racing = await Promise.all(Array.from({ length: 8 }, () => claimInteraction(channel, 'poll', 'race-poll', 'announced')));
assert.equal(racing.filter(Boolean).length, 1, 'one winner among concurrent claims');
// The claim is a database record of its own, not in the cache and not on the editable settings row: it also holds days later.
assert.equal(await disposition('poll-a'), 'announced');
assert.equal((await EventsubSchema.findById(endRow._id).lean()).announcedInteractions, undefined);
for await (const batch of redis.scanIterator({ MATCH: `twitch:${channel}:poll:*`, COUNT: 200 })) for (const key of [batch].flat()) await redis.del(key);
await notify('channel.poll.end', pollEvent('poll-a', 'archived', [6, 9, 2]));
await sleep(700);
assert.equal(twitch.chat.length, 1, 'still one announcement after the cache forgot the poll');
assert.equal(await run('$(poll.status)|$(poll.result)'), 'ended|Mirage');
// A late progress notification never reopens it.
await notify('channel.poll.progress', pollEvent('poll-a', null, [9, 9, 9]));
assert.equal(await run('$(poll.status)|$(poll.result)'), 'ended|Mirage');

// A tie: the tied options go on the wheel and it spins, with the event's final numbers.
twitch.chat.length = 0;
assert.equal(await run('$(roulette.clear polls)'), '');
await notify('channel.poll.begin', pollEvent('poll-b', null, [0, 0, 0]));
assert.equal(await run('$(poll.status)|$(poll.total)'), 'active|0', 'a new poll replaces the finished one');
// The previous poll's late end notification neither replaces the new poll nor runs again.
await notify('channel.poll.end', pollEvent('poll-a', 'archived', [6, 9, 2]));
assert.equal(await run('$(poll.status)|$(poll.total)'), 'active|0');
assert.equal(twitch.chat.length, 0);
await notify('channel.poll.end', pollEvent('poll-b', 'terminated', [4, 1, 4]));
await until(() => twitch.chat.length === 1, 'Poll ended broke the tie');
assert.equal(twitch.chat[0], 'Tie! The wheel decides between ["Nuke","Taco Bell"].');
assert.deepEqual(await labels('polls'), ['Nuke', 'Taco Bell'], 'only the tied options are on the wheel');
const tieSpin = (await state()).draw;
assert.ok(tieSpin && tieSpin.completedAt === null && ['Nuke', 'Taco Bell'].includes(tieSpin.winner.label), 'the wheel is spinning for the tie');
assert.equal(twitch.pollReads, readsBefore, 'the whole flow ran on notifications, without a Twitch read');
await until(async () => (await state()).draw?.completedAt !== null, 'the tie spin finishes', 8_000);
assert.equal(await run('$(roulette.result polls)'), tieSpin.winner.label);

// Nobody voted: the script decides, here with poll.total.
twitch.chat.length = 0;
await notify('channel.poll.begin', pollEvent('poll-c', null, [0, 0, 0]));
await notify('channel.poll.end', pollEvent('poll-c', 'completed', [0, 0, 0]));
await until(() => twitch.chat.length === 1, 'Poll ended for a poll without votes');
assert.equal(twitch.chat[0], 'Nobody voted.');
assert.deepEqual(await labels('polls'), ['Nuke', 'Taco Bell'], 'the wheel was left alone');

// cancel.poll: no result, and "Poll ended" stays silent for its end notification.
twitch.chat.length = 0;
twitch.poll = helixPoll('poll-d', 'ACTIVE', [3, 3, 1]);
await notify('channel.poll.begin', pollEvent('poll-d', null, [0, 0, 0]));
await notify('channel.poll.progress', pollEvent('poll-d', null, [3, 3, 1]));
// Worst case: Twitch delivers the end notification before it answers the cancel request.
twitch.duringPatch = () => notify('channel.poll.end', pollEvent('poll-d', 'terminated', [3, 3, 1]));
assert.equal(await run('$(cancel.poll)'), '');
assert.deepEqual(twitch.patches.at(-1), { broadcaster_id: channel, id: 'poll-d', status: 'TERMINATED' });
await sleep(700);
assert.equal(twitch.chat.length, 0, 'a canceled poll announces nothing');
assert.equal(await run('$(poll.status)|$(poll.result)|$(poll.tied)|$(poll.values)'), 'canceled|||[3,3,1]');
// Remembered for good: when the cache marker is long gone, the poll's "archived" notification still announces nothing.
assert.equal(await disposition('poll-d'), 'canceled');
for await (const batch of redis.scanIterator({ MATCH: `twitch:${channel}:poll:canceled:*`, COUNT: 200 })) for (const key of [batch].flat()) await redis.del(key);
await notify('channel.poll.end', pollEvent('poll-d', 'archived', [3, 3, 1]));
await sleep(700);
assert.equal(twitch.chat.length, 0, 'a canceled poll is never announced later either');

// cancel.poll loses the race: the poll ends by itself, and Twitch refuses the cancellation (400).
twitch.poll = helixPoll('poll-e', 'ACTIVE', [5, 1, 0]);
await notify('channel.poll.begin', pollEvent('poll-e', null, [0, 0, 0]));
twitch.refusePatch = true;
assert.match(await run('$(cancel.poll)'), /^Error cancelling poll: poll is not active/);
twitch.poll = helixPoll('poll-e', 'COMPLETED', [5, 1, 0]);
assert.equal(await disposition('poll-e'), null, 'the refused cancellation left nothing behind');
assert.equal(await run('$(poll.status)|$(poll.result)'), 'ended|Nuke', 'the poll keeps its result');
twitch.chat.length = 0;
await notify('channel.poll.end', pollEvent('poll-e', 'completed', [5, 1, 0]));
await until(() => twitch.chat.length === 1, 'the poll that was not canceled is announced');
assert.equal(twitch.chat[0], 'Nuke won the poll with 5 votes!');
twitch.chat.length = 0;

// Turned off, and "deleted" from the page: silent, and the Twitch subscription the overlays share stays.
await EventsubSchema.updateOne({ _id: endRow._id }, { $set: { enabled: false } });
await notify('channel.poll.begin', pollEvent('poll-g', null, [0, 0, 0]));
await notify('channel.poll.end', pollEvent('poll-g', 'completed', [1, 0, 0]));
await sleep(700);
assert.equal(twitch.chat.length, 0, 'a turned-off event sends nothing');
assert.equal(await run('$(poll.result)'), 'Nuke', 'the functions still see the result');
await EventsubSchema.updateOne({ _id: endRow._id }, { $set: { enabled: true, message: TIE_BREAK } });
const subsBefore = twitch.subs.length;
const removed = await deleteChannelEventsub(channel, String(endRow._id));
assert.deepEqual([removed.status, removed.body.error], [200, false]);
const kept = await EventsubSchema.findById(endRow._id).lean();
assert.deepEqual([kept.enabled, kept.message, kept.id], [false, TIE_BREAK, 'sub-channel.poll.end']);
assert.equal(twitch.subs.length, subsBefore, 'nothing was unsubscribed on Twitch');
// Setting it up again (the page after a delete, or the assistant's undo) turns the same row back on.
const again = await createChannelEventsub(channel, { type: 'channel.poll.end', version: '1', condition: { broadcaster_user_id: channel }, config: { message: 'Poll over: $(poll.result)' } });
assert.equal(again.status, 201);
const revived = await EventsubSchema.find({ channelID: channel, type: 'channel.poll.end' }).lean();
assert.deepEqual([revived.length, String(revived[0]._id), revived[0].enabled, revived[0].message], [1, String(endRow._id), true, 'Poll over: $(poll.result)']);
assert.equal(twitch.subs.length, subsBefore, 'no second Twitch subscription');

// A manual event test (Chat events "test", no Twitch message id) runs the message with the test poll's
// numbers every time, and never becomes the channel's poll.
twitch.chat.length = 0;
const testEvent = () => eventsubHandler({ id: 'test', type: 'channel.poll.end', version: '1', status: 'enabled', cost: 0, condition: { broadcaster_user_id: channel },
    transport: { method: 'webhook', callback: '' }, created_at: iso(0) },
    { id: 'test-poll', broadcaster_user_id: channel, broadcaster_user_login: login, broadcaster_user_name: 'PollCheck', title: 'What should we play?',
        started_at: iso(-30_000), status: 'completed', ended_at: iso(0), choices: [{ id: 'one', title: 'Adventure', votes: 12 }, { id: 'two', title: 'Racing', votes: 8 }] });
await testEvent(); await testEvent();
await until(() => twitch.chat.length === 2, 'two manual tests ran');
assert.deepEqual(twitch.chat, ['Poll over: Adventure', 'Poll over: Adventure']);
assert.equal(await run('$(poll.title)|$(poll.result)'), 'Best map?|Nuke', 'the channel\'s real poll is untouched');
assert.equal(await InteractionDisposition.countDocuments({ _id: /test-poll/ }), 0, 'a manual test claims nothing');
// Malformed settings never turn a retained event on.
await EventsubSchema.updateOne({ _id: endRow._id }, { $set: { enabled: false } });
const malformed = await createChannelEventsub(channel, { type: 'channel.poll.end', version: '1', condition: { broadcaster_user_id: channel }, config: { enabled: 'false' } });
assert.equal(malformed.status, 400);
assert.equal((await EventsubSchema.findById(endRow._id).lean()).enabled, false);

// --- 4. Predictions --------------------------------------------------------------------------------
assert.deepEqual([await run('$(prediction.status)'), await run('$(prediction.result)'), await run('$(prediction.total)')], ['none', '', '0']);
await redis.del(PREDICTION_KEY);
const outcomes = (yes, no) => [{ id: 'o1', title: 'Yes', users: 18, channel_points: yes, color: 'BLUE' }, { id: 'o2', title: 'No', users: 7, channel_points: no, color: 'PINK' }];
twitch.prediction = { id: 'pred-a', broadcaster_id: channel, broadcaster_login: login, title: 'Will we win?', status: 'ACTIVE',
    prediction_window: 120, created_at: iso(-10_000), outcomes: outcomes(6400, 3600) };
assert.equal(await run('$(prediction.title)|$(prediction.status)|$(prediction.options)|$(prediction.values)|$(prediction.total)|$(prediction.points No)|$(prediction.users 1)|$(prediction.result)'),
    'Will we win?|active|["Yes","No"]|[6400,3600]|10000|3600|18|');
assert.equal(twitch.predictionReads, 2, 'eight prediction functions share one Twitch read');
await until(() => twitch.subscribed.length === 7, 'prediction notifications subscribed in the background');
await settle();
const predictionEvent = extra => ({ id: 'pred-a', broadcaster_user_id: channel, broadcaster_user_login: login, broadcaster_user_name: 'PollCheck',
    title: 'Will we win?', started_at: iso(-10_000), outcomes: outcomes(7000, 3600).map(outcome => ({ ...outcome, color: outcome.color.toLowerCase() })), ...extra });
await notify('channel.prediction.lock', predictionEvent({ locked_at: iso(0) }));
assert.equal(await run('$(prediction.status)|$(prediction.points Yes)|$(prediction.result)'), 'locked|7000|');
const predictionEnd = await EventsubSchema.findOne({ channelID: channel, type: 'channel.prediction.end' });
await EventsubSchema.updateOne({ _id: predictionEnd._id }, { $set: { message: getBuiltinChatEvent('channel.prediction.end').config[0].value } });
twitch.chat.length = 0;
await notify('channel.prediction.end', predictionEvent({ status: 'resolved', winning_outcome_id: 'o2', ended_at: iso(0) }));
await until(() => twitch.chat.length === 1, 'Prediction ended announced the winner');
assert.equal(twitch.chat[0], 'No won the prediction!');
assert.equal(await run('$(prediction.status)|$(prediction.result)'), 'ended|No');
// A canceled prediction announces nothing.
twitch.chat.length = 0;
await notify('channel.prediction.begin', { ...predictionEvent({ locks_at: iso(60_000) }), id: 'pred-b' });
await notify('channel.prediction.end', { ...predictionEvent({ status: 'canceled', ended_at: iso(0) }), id: 'pred-b' });
await sleep(700);
assert.equal(twitch.chat.length, 0);
assert.equal(await run('$(prediction.status)|$(prediction.result)'), 'canceled|');

// --- 5. Turning "Poll ended" on for a channel that has no subscription yet -----------------------
await EventsubSchema.deleteOne({ _id: endRow._id });
twitch.subs = twitch.subs.filter(sub => sub.type !== 'channel.poll.end');
const created = await createChannelEventsub(channel, { type: 'channel.poll.end', version: '1', condition: { broadcaster_user_id: channel },
    config: { message: getBuiltinChatEvent('channel.poll.end').config[0].value } });
assert.equal(created.status, 201, JSON.stringify(created.body));
const fresh = await EventsubSchema.findOne({ channelID: channel, type: 'channel.poll.end' }).lean();
assert.deepEqual([fresh.enabled, fresh.message], [true, '*($(poll.tied) ? "The poll ended in a tie!" : "${$(poll.result)} won the poll!")']);
assert.ok(twitch.subscribed.filter(type => type === 'channel.poll.end').length === 2, 'a channel without the subscription gets it from Twitch');
twitch.chat.length = 0;
await notify('channel.poll.begin', pollEvent('poll-h', null, [0, 0, 0]));
await notify('channel.poll.end', pollEvent('poll-h', 'completed', [2, 2, 0]));
await until(() => twitch.chat.length === 1, 'the default message announced the tie');
assert.equal(twitch.chat[0], 'The poll ended in a tie!');

// --- 6. The command tester never touches Twitch or the roulette -------------------------------------
const saved = async () => { const { revision, roulettes } = await state(); return JSON.stringify({ revision, roulettes }); };
const before = await saved(), readsNow = twitch.pollReads;
const tested = await simulate({ body: TIE_BREAK });
assert.equal(tested.runs[0].reply, 'Tie! The wheel decides between ["Nuke","Mirage"].');
assert.deepEqual(tested.runs[0].actions.map(action => action.function), ['roulette.fill', 'roulette.start']);
assert.deepEqual(tested.runs[0].actions[0].args, ['polls', '["Nuke","Mirage"]']);
assert.deepEqual(tested.runs[0].problems, []);
const danger = await simulate({ body: '$(roulette.delete polls)$(roulette.clear polls)$(roulette.create x)' });
assert.deepEqual(danger.runs[0].actions.map(action => action.function), ['roulette.delete', 'roulette.clear', 'roulette.create']);
assert.ok(await saved() === before, 'testing a command changes no roulette');
assert.equal(twitch.pollReads, readsNow, 'testing a command reads no poll');

// Alert rows for the owner: sent ones are ok, the turned-off one is a plain skip.
await flushActivityLog();
await until(async () => await ActivityLog.countDocuments({ channelID: channel, kind: 'alert', name: 'channel.poll.end', outcome: 'ok' }) >= 4, 'poll end alerts recorded');
const alerts = await ActivityLog.find({ channelID: channel, kind: 'alert', name: /^channel\.(poll|prediction)\.end$/ }).lean();
assert.equal(alerts.filter(row => row.name === 'channel.prediction.end' && row.outcome === 'ok').length, 1);
assert.ok(alerts.some(row => row.outcome === 'skipped' && row.reason === 'alert_disabled'));
assert.ok(!alerts.some(row => row.outcome === 'failed'), 'no failed alert rows');

console.log(`PASS ${target}: roulette create/fill/clear/delete (spin-safe, delete recorded), poll.* and prediction.* from one snapshot (${twitch.pollReads} poll reads, ${twitch.predictionReads} prediction reads), notifications feed the snapshot, Poll ended once per poll (winner, tie → wheel, no votes, canceled, off, deleted keeps the subscription), Prediction ended, tester has no side effects`);
await new Promise(resolve => server.close(resolve));
if (process.env.APP_DIST) {
    for await (const batch of redis.scanIterator({ MATCH: `*${channel}*`, COUNT: 500 })) for (const key of [batch].flat()) await redis.del(key);
    if (priorAppToken === null) await redis.del('app:twitch:token'); else await redis.set('app:twitch:token', priorAppToken);
    await mongo.connection.db.dropDatabase();
}
await mongo.disconnect();
await redis.quit();
process.exit(0);
