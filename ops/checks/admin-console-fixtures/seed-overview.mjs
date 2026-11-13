// Disposable data for the admin console overview and channel debugging APIs (test databases only).
// `seedOverview({ db, redis, ObjectId, now })` takes a native MongoDB `Db`, a node-redis client and the
// driver's ObjectId class, replaces its own rows (fixed seed channel ids) and returns the numbers the
// services must report plus `cleanup()`, which removes exactly what it wrote. One log line carries
// `SECRET-` tokens and one user a `SECRET-` email, so a response that leaks either is caught by a string search.
//
// The global day counters, the docs answer list and the usage dead-letter list are fixed key names: seed
// them only into a disposable Dragonfly (or a database index of your own).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const OVERVIEW_CHANNELS = {
    alpha: { id: '8800000001', login: 'overview_alpha' },
    bravo: { id: '8800000002', login: 'overview_bravo' },
    // Receipts only, no account here: shown with a null login.
    charlie: { id: '8800000003', login: null }
};
const A = OVERVIEW_CHANNELS.alpha.id;
const B = OVERVIEW_CHANNELS.bravo.id;
const C = OVERVIEW_CHANNELS.charlie.id;
export const OVERVIEW_SEED_CHANNEL_IDS = [A, B, C];
const SPAM_RULE_ID = 'builtin-spam-protection';
const DOCS_IDS = ['overview-docs-1', 'overview-docs-2'];

const day = date => date.toISOString().slice(0, 10);

export async function seedOverview({ db, redis, ObjectId, now = new Date() }) {
    const at = offset => new Date(now.getTime() - offset);
    const oid = date => {
        const random = new ObjectId().toHexString().slice(8);
        return new ObjectId(Math.floor(date.getTime() / 1000).toString(16).padStart(8, '0') + random);
    };

    // ---- Activity log ----
    let activityId = 0;
    const activity = (offset, channelID, kind, name, outcome = 'ok', reason = '', data = {}) => ({
        _id: `overview-activity-${++activityId}`, at: at(offset), channelID, kind, name, outcome, reason,
        actorID: '', actorLogin: '', actorName: '', text: '', ref: '', durationMs: null, data, service: 'api',
        expiresAt: new Date(at(offset).getTime() + 30 * DAY)
    });
    const activityRows = [
        activity(1 * HOUR, A, 'command', '!so'),
        activity(30 * MINUTE, A, 'command', '!so', 'skipped', 'cooldown'),
        activity(2 * HOUR, A, 'command', '!so', 'blocked', 'permission_denied'),
        activity(3 * DAY, A, 'command', '!hi'),
        activity(10 * DAY, A, 'command', '!hi', 'failed', 'timeout'),
        activity(2 * HOUR, A, 'twitch_event', 'channel.ban'),
        // A handler crash on a journaled type: a problem row, but not a second notification.
        activity(1 * HOUR, A, 'twitch_event', 'channel.follow', 'failed', 'handler_error', { error: 'boom' }),
        activity(50 * MINUTE, A, 'alert', 'channel.follow', 'skipped', 'alert_disabled'),
        activity(3 * DAY, A, 'alert', 'channel.follow'),
        activity(2 * HOUR, A, 'voice', 'fish', 'failed', 'provider_error'),
        activity(5 * HOUR, A, 'system', 'eventsub.revoked', 'failed', 'authorization_revoked', { type: 'channel.follow', subscriptionId: 'sub-1', version: '2' }),
        activity(4 * HOUR, A, 'bot_message', 'command', 'blocked', 'held_for_moderation'),
        activity(20 * HOUR, B, 'command', '!dice'),
        activity(6 * HOUR, B, 'twitch_event', 'channel.channel_points_custom_reward_redemption.add'),
        activity(1 * HOUR, '', 'system', 'stream.steps')
    ];

    // ---- Journaled Twitch events and their deliveries ----
    const event = (key, offset, channelID, type, original, source = 'twitch-eventsub', topic = 'channel') => ({
        _id: oid(at(offset)), eventKey: `overview:${key}`, source, sourceEventId: key, type, topic, schemaVersion: 1,
        ...(channelID ? { channelID } : {}), occurredAt: at(offset), journaledAt: at(offset),
        payload: { event: { broadcaster_user_id: channelID } }, metadata: original ? { originalEventType: original } : {},
        expiresAt: new Date(at(offset).getTime() + 90 * DAY)
    });
    const events = {
        follow1: event('follow1', 1 * HOUR, A, 'channel.follow.received', 'channel.follow'),
        follow2: event('follow2', 3 * DAY, A, 'channel.follow.received', 'channel.follow'),
        cheer: event('cheer', 2 * HOUR, A, 'channel.bits.received', 'channel.cheer'),
        // Written before originalEventType existed: the journal type maps back to stream.online.
        online: event('online', 10 * DAY, A, 'stream.started', null),
        // A dashboard test: journaled, but not something Twitch sent.
        test: event('test', 30 * MINUTE, A, 'channel.follow.received', 'channel.follow', 'twitch-eventsub-test'),
        raid: event('raid', 5 * HOUR, B, 'channel.raid.received', 'channel.raid'),
        polar: event('polar', 1 * HOUR, null, 'billing.customer.state.changed', 'customer.state_changed', 'polar', 'domain')
    };
    const delivery = (eventDoc, consumer, status, deadOffset = null) => ({
        consumer, topic: eventDoc.topic, eventID: eventDoc._id, eventKey: eventDoc.eventKey, status, attempts: status === 'dead' ? 5 : 1,
        nextAttemptAt: null, lockedUntil: null, leaseToken: null, lastError: '', lastErrorCode: status === 'dead' ? 'handler_failed' : '',
        lastPrerequisiteKind: '', lastAttemptDurationMs: 10, lastDeadLetterError: '', firstAttemptAt: eventDoc.journaledAt,
        completedAt: eventDoc.journaledAt, skipReason: '', deadLetteredAt: deadOffset === null ? null : at(deadOffset),
        replayCount: 0, lastReplayedAt: null, expiresAt: new Date(now.getTime() + 30 * DAY), createdAt: eventDoc.journaledAt, updatedAt: eventDoc.journaledAt
    });
    const deliveries = [
        delivery(events.follow1, 'chat-announcements-v1', 'dead', 1 * HOUR),
        delivery(events.follow1, 'stream-analytics-v1', 'succeeded'),
        delivery(events.cheer, 'widget-actions-v1', 'dead', 2 * HOUR),
        delivery(events.raid, 'stream-analytics-v1', 'dead', 5 * HOUR),
        delivery(events.online, 'stream-operations-v1', 'dead', 9 * DAY),
        // Given up on 40 days ago: outside every window.
        { ...delivery(events.follow2, 'stream-timeline-v1', 'dead', 40 * DAY) }
    ];

    // ---- Chat protection decisions ----
    const decision = (id, offset, channelID, fields) => ({
        _id: `overview-decision-${id}`, channelID, userID: '8900000001', username: 'Seed_Chatter', messageID: `m-${id}`,
        messageText: `seed message ${id}`, ruleID: SPAM_RULE_ID, rule: {}, mode: 'semantic', reviewSource: 'first_message',
        state: 'completed', verdict: 'allow', status: 'completed', model: 'openai/gpt-6-luna-decisions', provider: 'OpenAI',
        scores: null, providerRequestID: '', inputTokens: 100, cost: 0, latencyMs: 300,
        charge: { status: 'none', credits: 0, externalID: '', customerID: '' }, consequence: { status: 'none' }, feedback: null,
        deadline: new Date(at(offset).getTime() + 4000), createdAt: at(offset),
        expiresAt: new Date(at(offset).getTime() + 180 * DAY), ...fields
    });
    const decisions = [
        decision(1, 1 * HOUR, A, { cost: 0.001, scores: { violation: 0.1, safe: 0.9 } }),
        // Charged: also a receipt (contextual_moderation) below; the decision is what counts.
        decision(2, 2 * HOUR, A, {
            reviewSource: 'spam_continuous', verdict: 'violation', cost: 0.002, scores: { violation: 0.95, safe: 0.05 },
            charge: { status: 'recorded', credits: 300, externalID: 'moderation:overview-decision-2', customerID: 'SECRET-customer' },
            consequence: { status: 'executed', action: 'ban', success: true }
        }),
        decision(3, 3 * HOUR, A, { verdict: 'uncertain', status: 'timeout' }),
        decision(4, 4 * HOUR, A, {
            mode: 'literal', reviewSource: 'rule', ruleID: 'seed-rule', verdict: 'violation', status: 'matched', model: '', provider: '',
            consequence: { status: 'executed', action: 'timeout', success: false, errorMessage: 'already banned' }
        }),
        decision(5, 3 * DAY, B, { verdict: 'uncertain', status: 'uncertain', cost: 0.0005 }),
        decision(6, 10 * DAY, B, { cost: 0.004 })
    ];

    // ---- AI usage receipts ----
    const receipt = (id, offset, channelID, fields) => ({
        channelID, customerId: 'SECRET-customer', entryId: `overview-receipt-${id}`, requestId: null, occurredAt: at(offset),
        entryKind: 'usage', category: 'tts', operation: 'synthesize', source: 'ast', adjustmentType: null, provider: 'fish', model: null,
        quantity: 100, unit: 'characters', credits: 0, resourceType: null, resourceId: null, actorId: null, actorLogin: null, actorName: null,
        costUsd: null, voice: null, itemized: true, retentionTier: 'pro', expiresAt: new Date(at(offset).getTime() + 90 * DAY),
        created_at: at(offset), updated_at: at(offset), ...fields
    });
    const receipts = [
        receipt(1, 1 * HOUR, A, { credits: 1500 }),
        receipt(2, 3 * DAY, A, { credits: 500 }),
        receipt(3, 2 * HOUR, A, { category: 'ai_chat', operation: 'final_response', source: 'chat', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', unit: 'tokens', credits: 4000, costUsd: 0.04 }),
        receipt(4, 10 * DAY, A, { category: 'memory', operation: 'stream_summary', source: 'stream_summary', provider: 'openrouter', unit: 'tokens', credits: 2000 }),
        receipt(5, 2 * HOUR, A, { category: 'other', operation: 'contextual_moderation', source: 'moderation', provider: 'openrouter', unit: 'tokens', credits: 300, costUsd: 0.002 }),
        receipt(6, 5 * HOUR, A, { entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', source: 'admin_credit_grant', adjustmentType: 'manual_grant', provider: 'polar', unit: null, quantity: null, credits: -100_000 }),
        receipt(7, 20 * HOUR, B, { category: 'other', operation: 'pet_ask', source: 'pet', provider: 'openrouter', unit: 'tokens', credits: 700, costUsd: 0.007 }),
        receipt(8, 6 * HOUR, C, { credits: 1000 })
    ];

    // ---- Assistant turns ----
    const turn = (id, offset, status, costUsd) => ({
        _id: `overview-turn-${id}`, at: at(offset), endedAt: at(offset - 10_000), channelId: A, channelLogin: OVERVIEW_CHANNELS.alpha.login,
        user: { id: A, login: OVERVIEW_CHANNELS.alpha.login, name: 'Overview_Alpha', role: 'owner' }, plan: 'pro', level: 'standard',
        fellBack: false, models: ['seed/model'], status, errorCode: status === 'completed' ? '' : 'seed_error', lang: 'en', pageRoute: '/dashboard',
        steps: 2, tools: [], units: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 5, reasoningTokens: 0, costUsd,
        unknownCostSteps: 0, durationMs: 10_000, activeMs: 9000, feedback: null, expiresAt: new Date(at(offset).getTime() + 90 * DAY)
    });
    const turns = [turn(1, 1 * HOUR, 'completed', 0.01), turn(2, 3 * DAY, 'failed', 0.02), turn(3, 10 * DAY, 'interrupted', 0.005)];

    const gifts = [
        { _id: new ObjectId(), buyerLogin: 'seed_buyer', recipientLogin: OVERVIEW_CHANNELS.alpha.login, recipientChannelId: A, credits: 250_000, priceAmount: 500, priceCurrency: 'usd', status: 'needs_support', attempts: 6, createdAt: at(2 * DAY), updatedAt: at(2 * DAY), seedOverview: true },
        { _id: new ObjectId(), buyerLogin: 'seed_buyer', recipientLogin: OVERVIEW_CHANNELS.bravo.login, recipientChannelId: B, credits: 100_000, priceAmount: 200, priceCurrency: 'usd', status: 'delivered', attempts: 1, createdAt: at(2 * DAY), updatedAt: at(2 * DAY), seedOverview: true }
    ];
    const users = [OVERVIEW_CHANNELS.alpha, OVERVIEW_CHANNELS.bravo].map(channel => ({
        _id: new ObjectId(), email: `SECRET-${channel.login}@example.com`, seedOverview: true,
        accounts: [{ type: 'twitch', id: channel.id, name: channel.login, chat_enabled: true }]
    }));

    // ---- Dragonfly: logger lines, day counters, docs answers, usage dead letters ----
    const logKey = (channel, level, offset, rand) => `logger:twitch:${channel}:${level}:${now.getTime() - offset}-${rand}`;
    const logLines = [
        [logKey(A, 'error', 1 * MINUTE, 'ov01'), {
            function: 'redemptionHandler', error: 'connect mongodb://dima:SECRET-PASS@mongo:27017/db failed', rewardID: 'r1',
            eventKey: 'twitch-eventsub:abc:channel.follow.received', accessToken: 'SECRET-TOKEN-1',
            nested: { refresh_token: 'SECRET-TOKEN-2', step: 'lookup' }, contact: 'viewer SECRET-mail@example.com',
            request: { twitchAccessToken: 'SECRET-TOKEN-4', note: 'api_key=SECRETabcdefgh12 rejected', id: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SECRETsignature' }
        }],
        [logKey(A, 'error', 2 * MINUTE, 'ov02'), { function: 'sendTwitchChatMessage.heldForModeration', message: 'Message held', httpStatus: 200 }],
        [logKey(A, 'warn', 3 * MINUTE, 'ov03'), { message: 'AI usage queue requires attention', Authorization: 'Bearer SECRET-TOKEN-3' }],
        [logKey(A, 'info', 4 * MINUTE, 'ov04'), { function: 'talk', message: 'Pet talked' }],
        [logKey(A, 'info', 5 * MINUTE, 'ov05'), 'plain text line'],
        [logKey(A, 'debug', 6 * MINUTE, 'ov06'), { function: 'TwitchStreamers.getAccountTokenById' }],
        [logKey(B, 'error', 1 * MINUTE, 'ov07'), { function: 'other channel' }]
    ];
    const today = day(now);
    const tenDaysAgo = day(at(10 * DAY));
    const counterKeys = [`docs_assistant:stats:${today}`, `docs_assistant:stats:${tenDaysAgo}`];
    const docsAnswers = [
        [DOCS_IDS[0], { at: at(2 * HOUR).toISOString(), cost_usd: '0.020000', lang: 'en', question: 'seed', answer: 'seed' }],
        [DOCS_IDS[1], { at: at(30 * HOUR).toISOString(), cost_usd: '0.010000', lang: 'en', question: 'seed', answer: 'seed' }]
    ];
    const deadLetters = ['{"seed":"overview-1"}', '{"seed":"overview-2"}'];

    async function cleanup() {
        await Promise.all([
            db.collection('activity_logs').deleteMany({ _id: { $regex: '^overview-activity-' } }),
            db.collection('domain_events').deleteMany({ eventKey: { $regex: '^overview:' } }),
            db.collection('domain_event_deliveries').deleteMany({ eventKey: { $regex: '^overview:' } }),
            db.collection('moderation_decisions').deleteMany({ _id: { $regex: '^overview-decision-' } }),
            db.collection('ai_usage_receipts').deleteMany({ entryId: { $regex: '^overview-receipt-' } }),
            db.collection('site_agent_turn_logs').deleteMany({ _id: { $regex: '^overview-turn-' } }),
            db.collection('creditgifts').deleteMany({ seedOverview: true }),
            db.collection('users').deleteMany({ seedOverview: true })
        ]);
        const keys = [...logLines.map(([key]) => key), ...counterKeys, ...DOCS_IDS.map(id => `docs_assistant:answer:${id}`)];
        await redis.del(keys);
        for (const id of DOCS_IDS) await redis.lRem('docs_assistant:recent', 0, id);
        for (const item of deadLetters) await redis.lRem('cron:ai-usage-backfills:dead', 0, item);
    }

    await cleanup();
    await db.collection('activity_logs').insertMany(activityRows);
    await db.collection('domain_events').insertMany(Object.values(events));
    await db.collection('domain_event_deliveries').insertMany(deliveries);
    await db.collection('moderation_decisions').insertMany(decisions);
    await db.collection('ai_usage_receipts').insertMany(receipts);
    await db.collection('site_agent_turn_logs').insertMany(turns);
    await db.collection('creditgifts').insertMany(gifts);
    await db.collection('users').insertMany(users);
    for (const [key, data] of logLines) {
        await redis.set(key, JSON.stringify({ data, timestamp: 'seed', level: key.split(':')[3], platform: 'twitch', channelId: key.split(':')[2] }), { EX: 3600 });
    }
    await redis.hSet(counterKeys[0], { asked: '4', answered: '2', failed: '1', cost_micro_usd: '30000' });
    await redis.hSet(counterKeys[1], { asked: '1', answered: '1', cost_micro_usd: '5000' });
    for (const key of counterKeys) await redis.expire(key, 3600);
    for (const [id, fields] of docsAnswers) await redis.hSet(`docs_assistant:answer:${id}`, fields);
    for (const [id] of docsAnswers) await redis.expire(`docs_assistant:answer:${id}`, 3600);
    // Newest first, like the docs assistant writes it.
    await redis.lPush('docs_assistant:recent', [DOCS_IDS[1], DOCS_IDS[0]]);
    await redis.rPush('cron:ai-usage-backfills:dead', deadLetters);

    const iso = offset => at(offset).toISOString();
    return {
        cleanup,
        logKeys: logLines.map(([key]) => key),
        expected: {
            // Last 24 hours, per seeded channel. Events: activity rows + journal (tests included) + decisions +
            // receipts other than the chat protection one; problems: activity problems + decisions not
            // reviewed or whose action failed; credits: usage receipts.
            topChannels: {
                [A]: { channel: OVERVIEW_CHANNELS.alpha.login, events: 19, problems: 9, credits: 5800 },
                [B]: { channel: OVERVIEW_CHANNELS.bravo.login, events: 4, problems: 0, credits: 700 },
                [C]: { channel: null, events: 1, problems: 0, credits: 1000 }
            },
            activeChannels: 3,
            dayCredits: 7500,
            // Decisions 0.003 + receipts 0.047 (the charged review's receipt is not counted again) + assistant 0.01 + docs 0.02.
            dayProviderUSD: 0.08,
            daily: {
                totals: { events: 34, problems: 10, credits: 10_000, providerUSD: 0.1245 },
                [tenDaysAgo]: { events: 4, problems: 1, credits: 2000, providerUSD: 0.014 }
            },
            features: {
                ai_chat: { count: 1, failed: 0, credits: 4000, providerUSD: 0.04 },
                voice: { count: 3, failed: 1, credits: 3000, providerUSD: null },
                assistant: { count: 2, failed: 1, credits: 0, providerUSD: 0.03 },
                docs: { count: 2, failed: 1, credits: 0, providerUSD: 0.03 },
                other: { count: 1, failed: 0, credits: 700, providerUSD: 0.007 },
                protection: { count: 4, failed: 1, credits: 300, providerUSD: 0.0035 },
                memory: { count: 0, failed: 0, credits: 0, providerUSD: null }
            },
            featureOrder: ['ai_chat', 'voice', 'assistant', 'docs', 'other', 'protection', 'memory'],
            attention: { verdicts_waiting: 1, dead_deliveries: 4, usage_import_stuck: 2, gifts_need_support: 1 },
            logs: {
                counts: { debug: 1, info: 2, warn: 1, error: 2, fatal: 0 },
                problemFunctions: ['redemptionHandler', 'sendTwitchChatMessage.heldForModeration', null],
                firstMessage: 'connect mongodb://[redacted]@mongo:27017/db failed',
                firstData: {
                    rewardID: 'r1', eventKey: 'twitch-eventsub:abc:channel.follow.received', 'nested.step': 'lookup', contact: 'viewer [email]',
                    'request.note': 'api_key=[redacted] rejected', 'request.id': '[redacted token]'
                }
            },
            commands7d: [
                { name: '!so', runs: 3, ok: 1, skipped: 1, blocked: 1, failed: 0, lastAt: iso(30 * MINUTE), lastOutcome: 'skipped', lastReason: 'cooldown', reasons: [{ reason: 'cooldown', count: 1 }, { reason: 'permission_denied', count: 1 }] },
                { name: '!hi', runs: 1, ok: 1, skipped: 0, blocked: 0, failed: 0, lastAt: iso(3 * DAY), lastOutcome: 'ok', lastReason: null, reasons: [] }
            ],
            commands30dHi: { runs: 2, ok: 1, failed: 1, lastOutcome: 'ok', reasons: [{ reason: 'timeout', count: 1 }] },
            recordsSince: iso(10 * DAY),
            eventsub: [
                { type: 'channel.follow', lastReceivedAt: iso(1 * HOUR), received7d: 2, lastAlert: { at: iso(50 * MINUTE), outcome: 'skipped', reason: 'alert_disabled' }, failedDeliveries: 1 },
                // Same time: ties are ordered by type.
                { type: 'channel.ban', lastReceivedAt: iso(2 * HOUR), received7d: 1, lastAlert: null, failedDeliveries: 0 },
                { type: 'channel.cheer', lastReceivedAt: iso(2 * HOUR), received7d: 1, lastAlert: null, failedDeliveries: 1 },
                { type: 'stream.online', lastReceivedAt: iso(10 * DAY), received7d: 0, lastAlert: null, failedDeliveries: 1 }
            ],
            revoked: [{ at: iso(5 * HOUR), type: 'channel.follow', reason: 'authorization_revoked' }]
        }
    };
}
