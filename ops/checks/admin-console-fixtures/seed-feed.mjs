// Seed for the admin activity feed (`/admin-site/feed`, `/feed/summary`, `/events/:eventKey`).
// A deliberate data set across every store the feed reads: two channels, one chatter active in both, every
// kind, problems of each sort, five rows from five stores in the same millisecond, rows outside the window, an
// expired receipt, a chat protection receipt that must not appear twice, a progress update and a billing event
// that must not appear, docs answers (one whose hash is gone). `expected` is the feed as the spec defines it:
// newest first, ties by id descending, with the facts each filter needs. Everything uses ids no other seed uses,
// and `cleanup` removes exactly what was written (the docs list is shared: only our ids are removed from it).
import { createHash } from 'node:crypto';

export const FEED_CHANNELS = { alpha: '920000001', bravo: '920000002' };
export const FEED_LOGINS = { alpha: 'feed_alpha', bravo: 'feed_bravo' };
export const FEED_CHATTER = { id: '820000001', login: 'feed_chatter', name: 'Feed_Chatter' };
const RAIDER = { id: '820000002', login: 'feed_raider', name: 'Feed_Raider' };
/** A login no Twitch user has (the check's provider mock answers every unknown Helix GET with no users). */
export const FEED_UNKNOWN_LOGIN = 'feed_nobody_here';
const X_LOGIN_KEYS = ['feed_chatter', FEED_UNKNOWN_LOGIN].map(login => `admin-feed:login:${login}`);
export const FEED_DOCS_IDS = {
    first: 'fee00000-0000-4000-8000-000000000001',
    second: 'fee00000-0000-4000-8000-000000000002',
    gone: 'fee00000-0000-4000-8000-000000000003',
    old: 'fee00000-0000-4000-8000-000000000004',
    failed: 'fee00000-0000-4000-8000-000000000005'
};
/** Sits inside a sentence of the stream start payload: event detail must return it masked. */
export const FEED_SENTENCE_SECRET = 'SECRETabcdefghij0123456789';
const OID = n => `65f0000000000000000000${String(n).padStart(2, '0')}`;
const key = (source, id, type) => [source, id, type].map(encodeURIComponent).join(':');
export const FEED_EVENT_KEYS = {
    follow: key('twitch-eventsub', 'feed-msg:1', 'channel.follow.received'),
    bits: key('twitch-eventsub', 'feed-msg-2', 'channel.bits.received'),
    raid: key('twitch-eventsub', 'feed-msg-3', 'channel.raid.received'),
    stream: key('twitch-eventsub-test', 'feed-msg-4', 'stream.started'),
    pollBegan: key('twitch-eventsub', 'feed-msg-5', 'channel.poll.began'),
    pollUpdated: key('twitch-eventsub', 'feed-msg-6', 'channel.poll.updated'),
    old: key('twitch-eventsub', 'feed-msg-7', 'channel.follow.received'),
    billing: key('polar-webhook', 'feed-msg-8', 'billing.order.paid'),
    resub: key('twitch-eventsub', 'feed-msg-9', 'channel.chat.notification'),
    viewerRaid: key('twitch-eventsub', 'feed-msg-10', 'channel.raid.received')
};
const sha = value => createHash('sha256').update(value).digest('hex').slice(0, 40);

/**
 * @param {import('mongodb').Db} db  the app's test database
 * @param {any} redis               node-redis client
 * @param {Date} now
 * @param {new (hex: string) => unknown} ObjectId  the app's ObjectId (the fixtures folder has no node_modules)
 */
export async function seedFeed(db, redis, now, ObjectId) {
    const t = minutes => new Date(now.getTime() - minutes * 60_000);
    const tie = new Date(now.getTime() - 30 * 60_000);
    const tooOld = new Date(now.getTime() - 8 * 86_400_000);
    const { alpha: A, bravo: B } = FEED_CHANNELS;
    const X = FEED_CHATTER;
    const expected = [];
    const expect = (id, at, kind, outcome, channelID, actor = null, extra = {}) =>
        expected.push({ id, at: at.getTime(), kind, outcome, channelID, actorID: actor?.id ?? null, actorLogin: actor?.login ?? null, ...extra });

    await cleanup(db, redis);

    await db.collection('users').insertMany([
        { login: FEED_LOGINS.alpha, accounts: [{ type: 'twitch', id: A, name: FEED_LOGINS.alpha }] },
        { login: FEED_LOGINS.bravo, accounts: [{ type: 'twitch', id: B, name: FEED_LOGINS.bravo }] }
    ]);

    // ---- activity_logs ----
    const activity = (n, at, fields) => ({
        _id: sha(`feed-activity-${n}`), at, channelID: '', kind: 'command', name: '!x', outcome: 'ok', reason: '', actorID: '', actorLogin: '',
        actorName: '', text: '', ref: '', durationMs: null, data: {}, service: 'bot', expiresAt: new Date(at.getTime() + 30 * 86_400_000), ...fields
    });
    const actor = { actorID: X.id, actorLogin: X.login, actorName: X.name };
    const activityRows = [
        activity(1, t(10), { channelID: A, kind: 'command', name: '!so', text: '!so @friend', ...actor, durationMs: 14, data: { func: 'shoutout', trigger: 'chat', live: true } }),
        activity(2, t(20), { channelID: A, kind: 'command', name: '!so', outcome: 'skipped', reason: 'cooldown', text: '!so again', ...actor }),
        activity(3, t(40), { channelID: B, kind: 'bot_message', name: 'command', outcome: 'blocked', reason: 'held_for_moderation', text: 'Thanks for the follow!', data: { origin: 'command', httpStatus: 200 } }),
        activity(4, t(55), { channelID: A, kind: 'alert', name: 'channel.follow', ref: FEED_EVENT_KEYS.follow, data: { event: 'channel.follow', eventKey: FEED_EVENT_KEYS.follow } }),
        activity(5, t(70), { channelID: B, kind: 'voice', name: 'fish', outcome: 'failed', reason: 'provider_error', ...actor, text: 'read this aloud' }),
        activity(6, t(80), { channelID: '', kind: 'system', name: 'eventsub.revoked', data: { type: 'channel.follow' } }),
        activity(7, t(90), { channelID: A, kind: 'twitch_event', name: 'channel.channel_points_custom_reward_redemption.add', ...actor, data: { rewardTitle: 'Hydrate', rewardCost: 100 } }),
        activity(8, tie, { channelID: A, kind: 'command', name: '!hug', ...actor, text: '!hug' }),
        // Settings at work, never problems: a viewer without the role, and a command that is turned off.
        activity(10, t(25), { channelID: A, kind: 'command', name: '!mod', outcome: 'blocked', reason: 'permission_denied', ...actor, text: '!mod' }),
        activity(11, t(30), { channelID: B, kind: 'command', name: '!s', outcome: 'skipped', reason: 'disabled', ...actor, text: '!s hi' }),
        activity(9, tooOld, { channelID: A, kind: 'command', name: '!old', ...actor })
    ];
    await db.collection('activity_logs').insertMany(activityRows);
    const actorOf = row => row.actorID ? { id: row.actorID, login: row.actorLogin } : null;
    for (const row of activityRows.slice(0, 10)) expect(`activity:${row._id}`, row.at, row.kind, row.outcome, row.channelID || null, actorOf(row), { reason: row.reason || null });

    // ---- domain_events (+ deliveries and the stream start receipt) ----
    const event = (n, eventKey, source, type, topic, channelID, occurredAt, payloadEvent, metadata = {}) => ({
        eventKey, source, sourceEventId: decodeURIComponent(eventKey.split(':')[1]), type, topic, schemaVersion: 1, channelID, occurredAt,
        journaledAt: new Date(occurredAt.getTime() + 150), payload: { subscription: { type: metadata.originalEventType || type, transport: { method: 'webhook', secret: 'SECRET-transport' } }, event: payloadEvent },
        metadata, expiresAt: new Date(occurredAt.getTime() + 90 * 86_400_000), _n: n
    });
    const events = [
        event(1, FEED_EVENT_KEYS.follow, 'twitch-eventsub', 'channel.follow.received', 'channel', A, t(56),
            { broadcaster_user_id: A, user_id: X.id, user_login: X.login, user_name: X.name, followed_at: t(56).toISOString() }, { originalEventType: 'channel.follow' }),
        event(2, FEED_EVENT_KEYS.bits, 'twitch-eventsub', 'channel.bits.received', 'channel', B, tie,
            { broadcaster_user_id: B, user_id: X.id, user_login: X.login, user_name: X.name, bits: 250, message: { text: 'Cheer250 great stream' } }, { originalEventType: 'channel.bits.use' }),
        event(3, FEED_EVENT_KEYS.raid, 'twitch-eventsub', 'channel.raid.received', 'channel', B, t(100),
            { from_broadcaster_user_id: RAIDER.id, from_broadcaster_user_login: RAIDER.login, from_broadcaster_user_name: RAIDER.name, to_broadcaster_user_id: B, viewers: 42 }, { originalEventType: 'channel.raid' }),
        event(4, FEED_EVENT_KEYS.stream, 'twitch-eventsub-test', 'stream.started', 'channel', A, t(120),
            { id: 'stream-1', broadcaster_user_id: A, type: 'live', started_at: t(120).toISOString(), access_token: 'SECRET-access', user_email: 'SECRET@example.com', nested: { client_secret: 'SECRET-client', signature: 'sha256=SECRET', note: `retry with Bearer ${FEED_SENTENCE_SECRET} later` } },
            { originalEventType: 'stream.online', observability: { traceId: 'feedtrace0001', spanId: 's1', sampled: true } }),
        event(5, FEED_EVENT_KEYS.pollBegan, 'twitch-eventsub', 'channel.poll.began', 'channel', A, t(130),
            { broadcaster_user_id: A, title: 'Best snack?' }, { originalEventType: 'channel.poll.begin' }),
        event(6, FEED_EVENT_KEYS.pollUpdated, 'twitch-eventsub', 'channel.poll.updated', 'channel', A, t(131),
            { broadcaster_user_id: A, title: 'Best snack?' }, { originalEventType: 'channel.poll.progress' }),
        event(7, FEED_EVENT_KEYS.old, 'twitch-eventsub', 'channel.follow.received', 'channel', A, tooOld,
            { broadcaster_user_id: A, user_id: X.id, user_login: X.login, user_name: X.name }, { originalEventType: 'channel.follow' }),
        event(8, FEED_EVENT_KEYS.billing, 'polar-webhook', 'billing.order.paid', 'domain', undefined, t(15), { customer_email: 'SECRET@example.com', user_id: X.id }),
        // The viewer in the two other fields that can name them: a chat notification in bravo, a raid into alpha.
        event(9, FEED_EVENT_KEYS.resub, 'twitch-eventsub', 'channel.chat.notification', 'channel', B, t(75),
            { broadcaster_user_id: B, chatter_user_id: X.id, chatter_user_login: X.login, chatter_user_name: X.name, chatter_is_anonymous: false, notice_type: 'resub', resub: { cumulative_months: 7, sub_tier: '1000' }, message: { text: 'seven months!' } }, { originalEventType: 'channel.chat.notification' }),
        event(10, FEED_EVENT_KEYS.viewerRaid, 'twitch-eventsub', 'channel.raid.received', 'channel', A, t(105),
            { from_broadcaster_user_id: X.id, from_broadcaster_user_login: X.login, from_broadcaster_user_name: X.name, to_broadcaster_user_id: A, viewers: 3 }, { originalEventType: 'channel.raid' })
    ];
    for (const row of events) { row._id = new ObjectId(OID(row._n)); delete row._n; if (row.channelID === undefined) delete row.channelID; }
    await db.collection('domain_events').insertMany(events);
    const eventActor = { 1: X, 2: X, 3: RAIDER, 9: X, 10: X };
    for (const [n, row] of events.entries()) {
        if (![0, 1, 2, 3, 4, 8, 9].includes(n)) continue;
        expect(`event:${OID(n + 1)}`, row.occurredAt, 'twitch_event', 'ok', row.channelID, eventActor[n + 1] || null, { eventKey: row.eventKey });
    }
    const delivery = (consumer, eventKey, status, extra = {}) => ({
        consumer, topic: 'channel', eventID: events.find(row => row.eventKey === eventKey)._id, eventKey, status, attempts: 1, nextAttemptAt: null, lockedUntil: null,
        leaseToken: null, lastError: '', lastErrorCode: '', lastDeadLetterError: '', firstAttemptAt: t(55), completedAt: t(55), skipReason: '', deadLetteredAt: null,
        replayCount: 0, lastReplayedAt: null, lastAttemptDurationMs: 12, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: t(55), updatedAt: t(55), ...extra
    });
    await db.collection('domain_event_deliveries').insertMany([
        delivery('stream-timeline-v1', FEED_EVENT_KEYS.follow, 'succeeded'),
        delivery('chat-announcements-v1', FEED_EVENT_KEYS.follow, 'skipped', { skipReason: 'event_too_old' }),
        delivery('stream-analytics-v1', FEED_EVENT_KEYS.follow, 'dead', {
            attempts: 5, completedAt: null, lastErrorCode: 'handler_failed', deadLetteredAt: t(50),
            lastError: 'MongoServerError: connect ECONNREFUSED mongodb://SECRET-user:SECRET-pass@10.1.2.3:27017/prod?authSource=admin'
        }),
        delivery('stream-operations-v1', FEED_EVENT_KEYS.stream, 'succeeded', { lastAttemptDurationMs: 840 })
    ]);
    await db.collection('stream_operations_receipts').insertOne({
        _id: FEED_EVENT_KEYS.stream, channelID: A, expiresAt: new Date(now.getTime() + 86_400_000),
        steps: { timers: { status: 'completed', at: t(119) }, editors: { status: 'failed', reason: 'Twitch said 401 at https://api.twitch.tv/helix/channels/editors', at: t(118) } }
    });

    // ---- moderation_decisions ----
    const decision = (n, at, fields) => ({
        _id: sha(`feed-decision-${n}`), channelID: A, userID: X.id, userLogin: X.login, username: X.name, messageID: `feed-m-${n}`, messageText: 'free followers at example dot com',
        ruleID: 'builtin-spam-protection', rule: { type: 'blacklist', semantic: { thresholdPercent: 70 } }, settingsVersion: 1, matches: [], context: [{ messageID: 'c', username: 'other', message: 'SECRET-context', timestamp: 1 }],
        mode: 'semantic', reviewSource: 'first_message', messageOrdinal: 1, state: 'completed', verdict: 'violation', status: 'completed',
        model: 'openai/gpt-6-luna-decisions-20261006', provider: 'OpenAI', decisionPolicyVersion: 'contextual-v2', scores: { self_promotion: 0.93, safe: 0.07, violation: 0.93 },
        providerRequestID: 'SECRET-provider-request', inputTokens: 1700, cost: 0.00021, latencyMs: 900,
        charge: { status: 'recorded', credits: 0, externalID: 'SECRET-external', customerID: 'SECRET-customer' },
        consequence: { status: 'executed', action: 'ban', offenseNumber: 1, success: true }, feedback: null, deadline: at, createdAt: at,
        expiresAt: new Date(at.getTime() + 180 * 86_400_000), ...fields
    });
    const decisions = [
        decision(1, t(25), {}),
        decision(2, tie, { channelID: B, verdict: 'uncertain', status: 'timeout', scores: null, cost: 0, latencyMs: 0, consequence: { status: 'allowed_fallback' } }),
        decision(3, t(45), { consequence: { status: 'executed', action: 'ban', offenseNumber: 1, success: false, errorMessage: 'The user is a moderator' } }),
        decision(4, t(65), { userID: '820000009', userLogin: 'someone_else', username: 'Someone_Else', reviewSource: 'spam_continuous', verdict: 'uncertain', status: 'credits_unavailable', scores: null, cost: 0, latencyMs: 0, consequence: { status: 'allowed_fallback' } }),
        decision(5, t(85), { userID: '820000009', userLogin: 'someone_else', username: 'Someone_Else', ruleID: 'rule-caps', rule: { type: 'caps' }, mode: 'literal', reviewSource: 'rule', model: '', provider: '', scores: null, cost: 0, latencyMs: 0, charge: { status: 'none', credits: 0, externalID: '', customerID: '' }, consequence: { status: 'executed', action: 'delete', success: true } }),
        decision(6, tooOld, {})
    ];
    await db.collection('moderation_decisions').insertMany(decisions);
    const decisionOutcome = { 1: 'ok', 2: 'failed', 3: 'failed', 4: 'skipped', 5: 'ok' };
    for (const [n, row] of decisions.slice(0, 5).entries()) {
        expect(`decision:${row._id}`, row.createdAt, 'protection', decisionOutcome[n + 1], row.channelID, { id: row.userID, login: row.userLogin });
    }

    // ---- ai_usage_receipts ----
    const receipt = (entryId, at, fields) => ({
        channelID: A, customerId: 'SECRET-customer-a', entryId, requestId: 'SECRET-request', occurredAt: at, entryKind: 'usage', category: 'tts', operation: 'synthesize',
        source: 'ast', adjustmentType: null, provider: 'fish', model: null, quantity: 49, unit: 'characters', credits: 74, resourceType: 'speech', resourceId: 'SECRET-resource',
        actorId: null, actorLogin: null, actorName: null, costUsd: null, voice: null, itemized: true, retentionTier: 'pro', expiresAt: new Date(at.getTime() + 90 * 86_400_000), ...fields
    });
    const receipts = [
        receipt('feed-usage-1', tie, { actorId: X.id, actorLogin: X.login, actorName: X.name, costUsd: 0.0006, voice: 'voice-1' }),
        receipt('feed-usage-2', t(35), { channelID: B, customerId: 'SECRET-customer-b', category: 'ai_chat', operation: 'final_response', source: 'chat', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', quantity: 6900, unit: 'tokens', credits: 44, actorId: X.id, actorLogin: X.login, actorName: X.name }),
        receipt('feed-usage-3', t(50), { entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', source: 'admin_credit_grant', adjustmentType: 'manual_grant', provider: 'polar', quantity: null, unit: null, credits: -800000 }),
        receipt('feed-usage-4', t(25), { category: 'other', operation: 'contextual_moderation', source: 'moderation', provider: 'openrouter', model: 'openai/gpt-6-luna-decisions-20261006', quantity: 1700, unit: 'tokens', credits: 0, actorId: X.id }),
        receipt('feed-usage-5', t(60), { expiresAt: t(1) }),
        receipt('feed-usage-6', tooOld, {})
    ];
    await db.collection('ai_usage_receipts').insertMany(receipts);
    const usageKind = { 'feed-usage-1': 'voice', 'feed-usage-2': 'ai', 'feed-usage-3': 'credits' };
    for (const row of receipts.slice(0, 3)) {
        expect(`usage:${row.entryId}`, row.occurredAt, usageKind[row.entryId], 'ok', row.channelID, row.actorId ? { id: row.actorId, login: row.actorLogin } : null);
    }

    // ---- site_agent_turn_logs ----
    const turn = (n, at, fields) => ({
        _id: `feed-turn-${n}`, at, endedAt: at, channelId: A, channelLogin: FEED_LOGINS.alpha, user: { id: A, login: FEED_LOGINS.alpha, name: 'Feed_Alpha', role: 'owner' },
        plan: 'pro', level: 'expert', fellBack: false, models: ['anthropic/claude-haiku-5-5'], status: 'completed', errorCode: '', lang: 'en', pageRoute: '/dashboard',
        steps: 2, message: `FEEDQ-${n} how do I add a timer?`, steers: ['SECRET-steer'], answer: 'SECRET-answer',
        tools: [{ name: 'list_commands', state: 'done', ms: 20, approval: null, args: 'SECRET-tool-args', result: 'SECRET-tool-result' }], units: 2, promptTokens: 100, cachedTokens: 0, completionTokens: 50, reasoningTokens: 0,
        costUsd: 0.0031, unknownCostSteps: 0, durationMs: 4100, activeMs: 4000, feedback: null, expiresAt: new Date(at.getTime() + 90 * 86_400_000), ...fields
    });
    const turns = [
        turn(1, t(5), {}),
        turn(2, t(95), { channelId: B, channelLogin: FEED_LOGINS.bravo, user: { id: B, login: FEED_LOGINS.bravo, name: 'Feed_Bravo', role: 'owner' }, level: 'standard', status: 'failed', errorCode: 'provider_error' }),
        turn(3, tie, { status: 'cancelled' }),
        turn(4, tooOld, {})
    ];
    await db.collection('site_agent_turn_logs').insertMany(turns);
    const turnOutcome = { 1: 'ok', 2: 'failed', 3: 'skipped' };
    for (const [n, row] of turns.slice(0, 3).entries()) expect(`assistant:${row._id}`, row.at, 'assistant', turnOutcome[n + 1], row.channelId, { id: row.user.id, login: row.user.login }, { text: row.message });

    // ---- mcp_call_logs (AI apps over MCP) ----
    const mcpCall = (n, at, fields) => ({
        _id: `feed-mcp-${n}`, at, ms: 640, channelId: A, channelLogin: FEED_LOGINS.alpha, user: { id: A, login: FEED_LOGINS.alpha, role: 'owner' },
        client: { id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', name: 'Claude' }, sessionId: 'SECRET-session', tool: 'list_commands', kind: 'read',
        outcome: 'ok', code: '', reason: '', problem: false, charged: 1, changeId: null, late: null, expiresAt: new Date(at.getTime() + 90 * 86_400_000), ...fields
    });
    const mcpCalls = [
        mcpCall(1, t(7), {}),
        mcpCall(2, t(97), { channelId: B, channelLogin: FEED_LOGINS.bravo, user: { id: X.id, login: X.login, role: 'admin' }, tool: 'create_command', kind: 'write',
            outcome: 'blocked', code: 'unsafe_content', reason: 'Not applied: $(ban): bans a viewer.', problem: true, charged: 0 }),
        mcpCall(3, tie, { tool: 'update_command', kind: 'write', outcome: 'failed', code: 'outcome_unknown', reason: 'This change took too long.', problem: true, charged: 0, late: 'applied' }),
        mcpCall(4, t(99), { tool: 'get_command', outcome: 'blocked', code: 'permission_denied', reason: 'No permission.', problem: false, charged: 0 }),
        mcpCall(5, tooOld, {})
    ];
    await db.collection('mcp_call_logs').insertMany(mcpCalls);
    for (const row of mcpCalls.slice(0, 4)) {
        expect(`mcp:${row._id}`, row.at, 'mcp', row.outcome, row.channelId, { id: row.user.id, login: row.user.login }, { reason: row.code || undefined, text: row.reason || null });
    }

    // ---- docs assistant (Dragonfly) ----
    const answer = (id, at, question) => redis.hSet(`docs_assistant:answer:${id}`, {
        at: at.toISOString(), lang: 'en', page: 'https://docs.example.test/en/commands/?ref=SECRET', turn: '1', question, answer: 'SECRET-answer-body',
        sources: '[]', duration_ms: '5200', input_tokens: '100', output_tokens: '50', cost_usd: '0.001100', stop_reason: 'end_turn', rounds: '1', tool_calls: '[]'
    });
    await answer(FEED_DOCS_IDS.first, t(12), 'How do I add a command?');
    await answer(FEED_DOCS_IDS.second, tie, 'What is a timer?');
    await answer(FEED_DOCS_IDS.old, tooOld, 'Old question');
    // A question that could not be answered, stored the way the docs writer stores it.
    await redis.hSet(`docs_assistant:answer:${FEED_DOCS_IDS.failed}`, {
        at: t(18).toISOString(), lang: 'es', page: 'https://docs.example.test/es/timers/', turn: '1', question: '¿Por qué mi timer no habla?', answer: '',
        sources: '[]', duration_ms: '30000', input_tokens: '0', output_tokens: '0', cost_usd: '0.000000', stop_reason: 'timeout', failed: 'timeout'
    });
    for (const id of Object.values(FEED_DOCS_IDS)) await redis.expire(`docs_assistant:answer:${id}`, 3600);
    // Newest first, as the app writes it; `gone` has no hash (expired).
    await redis.lPush('docs_assistant:recent', [FEED_DOCS_IDS.old, FEED_DOCS_IDS.gone, FEED_DOCS_IDS.second, FEED_DOCS_IDS.failed, FEED_DOCS_IDS.first]);
    expect(`docs:${FEED_DOCS_IDS.first}`, t(12), 'docs', 'ok', null);
    expect(`docs:${FEED_DOCS_IDS.second}`, tie, 'docs', 'ok', null);
    expect(`docs:${FEED_DOCS_IDS.failed}`, t(18), 'docs', 'failed', null, null, { reason: 'timeout' });

    expected.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return {
        expected,
        tie: tie.getTime(),
        window: { from: new Date(now.getTime() - 7 * 86_400_000), to: now },
        ids: new Set(expected.map(entry => entry.id)),
        cleanup: () => cleanup(db, redis)
    };
}

/** Removes exactly what `seedFeed` writes. Safe to run twice. */
export async function cleanup(db, redis) {
    const channels = Object.values(FEED_CHANNELS);
    await Promise.all([
        db.collection('users').deleteMany({ 'accounts.id': { $in: channels } }),
        db.collection('activity_logs').deleteMany({ _id: { $in: Array.from({ length: 9 }, (_, i) => sha(`feed-activity-${i + 1}`)) } }),
        db.collection('domain_events').deleteMany({ eventKey: { $in: Object.values(FEED_EVENT_KEYS) } }),
        db.collection('domain_event_deliveries').deleteMany({ eventKey: { $in: Object.values(FEED_EVENT_KEYS) } }),
        db.collection('stream_operations_receipts').deleteMany({ _id: FEED_EVENT_KEYS.stream }),
        db.collection('moderation_decisions').deleteMany({ _id: { $in: Array.from({ length: 6 }, (_, i) => sha(`feed-decision-${i + 1}`)) } }),
        db.collection('ai_usage_receipts').deleteMany({ entryId: { $regex: '^feed-usage-' } }),
        db.collection('site_agent_turn_logs').deleteMany({ _id: { $regex: '^feed-turn-' } }),
        db.collection('mcp_call_logs').deleteMany({ _id: { $regex: '^feed-mcp-' } })
    ]);
    // The feed caches login lookups; our logins only.
    await redis.del(X_LOGIN_KEYS).catch(() => null);
    for (const id of Object.values(FEED_DOCS_IDS)) {
        await redis.del(`docs_assistant:answer:${id}`);
        await redis.lRem('docs_assistant:recent', 0, id);
    }
}

/**
 * A problem is a failure, or a refusal that is not a setting (Twitch held the bot's message). Skipped rows
 * (cooldown, turned off, a review skipped for credits, a stopped assistant) and a viewer without the role never are.
 */
const isProblem = entry => entry.outcome === 'failed' || (entry.outcome === 'blocked' && entry.reason !== 'permission_denied');

/**
 * The seed's rows a feed query must return, in order, from the spec alone: kinds, channel, chatter and
 * outcome filters. A viewer id is searched everywhere. A login that did not resolve to an id is searched
 * by login only where that is indexed or bounded by a channel (see `expectedPartial` for the rest).
 */
export function expectedFeed(seed, query = {}) {
    return seed.expected.filter(entry => {
        const source = entry.id.split(':')[0];
        if (query.kinds && !query.kinds.includes(entry.kind)) return false;
        if (query.channel && entry.channelID !== query.channel) return false;
        if (query.actor) {
            if (entry.actorID !== query.actor) return false;
        } else if (query.actorLogin) {
            if (entry.actorLogin !== query.actorLogin) return false;
            if (['event', 'usage', 'assistant', 'mcp'].includes(source) && !query.channel) return false;
        }
        if (query.outcome === 'problems' && !isProblem(entry)) return false;
        if (query.outcome === 'failed' && entry.outcome !== 'failed') return false;
        return true;
    });
}

/** Per-kind counts the summary must give for the seed's rows (kinds and outcome ignored). */
export function expectedCounts(seed, query = {}) {
    const counts = {};
    for (const entry of expectedFeed(seed, { channel: query.channel, actor: query.actor, actorLogin: query.actorLogin })) {
        const row = counts[entry.kind] ||= { total: 0, problems: 0, failed: 0 };
        row.total++;
        if (isProblem(entry)) row.problems++;
        if (entry.outcome === 'failed') row.failed++;
    }
    return counts;
}

const KIND_ORDER = ['command', 'bot_message', 'twitch_event', 'alert', 'protection', 'voice', 'ai', 'assistant', 'mcp', 'docs', 'credits', 'system'];

/**
 * Kinds the response must list in `partial` for a login that did not resolve: stores that cannot search
 * that login (Twitch events, usage receipts and assistant turns without a channel; chat protection always,
 * since older decisions have no login). Nothing is missing for an id, or for a kind that cannot be a problem.
 */
export function expectedPartial(query = {}) {
    if (query.actor || !query.actorLogin) return [];
    const gaps = new Set(['protection']);
    if (!query.channel) {
        gaps.add('assistant');
        gaps.add('mcp');
        if (!query.outcome) for (const kind of ['twitch_event', 'voice', 'ai', 'credits']) gaps.add(kind);
    }
    return KIND_ORDER.filter(kind => gaps.has(kind) && (!query.kinds || query.kinds.includes(kind)));
}
