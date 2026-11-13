// Disposable AI usage receipts for the admin console usage API (test databases only).
// `seedUsage(db, now)` takes a native MongoDB `Db`, replaces its own rows (fixed seed channel ids) and returns
// the numbers the API must report. Every row carries a `SECRET-` Polar customer id and the users carry a
// `SECRET-` email, so a response that leaks either is caught by a plain string search.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const USAGE_CHANNELS = {
    alpha: { id: '7100000001', login: 'usage_alpha', tier: 'pro' },
    beta: { id: '7100000002', login: 'usage_beta', tier: 'premium' },
    gamma: { id: '7100000003', login: 'usage_gamma', tier: 'free' },
    // No account here: the API shows it with a null login and plan.
    delta: { id: '7100000004', login: null, tier: null },
    // 520 cheap rows 8–9 days ago, for paging. Outside the default window so the 7-day numbers stay small.
    bulk: { id: '7100000005', login: 'usage_bulk', tier: 'free' }
};
export const USAGE_ACTORS = {
    one: { id: '7200000001', login: 'viewer_one', name: 'Viewer_One' },
    two: { id: '7200000002', login: 'viewer_two', name: 'Viewer_Two' },
    three: { id: '7200000003', login: 'viewer_three', name: null }
};
export const USAGE_BULK_ROWS = 520;
const SEED_CHANNEL_IDS = Object.values(USAGE_CHANNELS).map(channel => channel.id);
const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
const MUSE = 'meta/muse-spark-1.2-contributor';
const LUNA = 'openai/gpt-6-luna-decisions-20261006';

const C = USAGE_CHANNELS, A = USAGE_ACTORS;
const actor = person => ({ actorId: person.id, actorLogin: person.login, actorName: person.name });

/** Rows inside the default 7-day window unless noted. `hoursAgo` places them; `expired` puts expiresAt in the past. */
function seedRows() {
    return [
        { n: 1, channel: C.alpha, hoursAgo: 1, category: 'tts', provider: 'fish', source: 'ast', credits: 150, quantity: 100, unit: 'characters', costUsd: 0.002, voice: 'voice-a', ...actor(A.one) },
        // No actor/cost/voice fields at all, like today's production rows.
        { n: 2, channel: C.alpha, hoursAgo: 2, category: 'tts', provider: 'fish', source: 'ast', credits: 75, quantity: 50, unit: 'characters', omitNew: true },
        { n: 3, channel: C.alpha, hoursAgo: 26, category: 'tts', provider: 'piper', source: 'pet', credits: 2, quantity: 100, unit: 'characters', omitCost: true, ...actor(A.two) },
        { n: 4, channel: C.alpha, hoursAgo: 27, category: 'ai_chat', operation: 'final_response', provider: 'openrouter', model: DEEPSEEK, source: 'chat', credits: 44, quantity: 6931, unit: 'tokens', costUsd: 0.00044, ...actor(A.two) },
        { n: 5, channel: C.beta, hoursAgo: 50, category: 'memory', operation: 'stream_summary', provider: 'openrouter', model: MUSE, source: 'stream_offline', credits: 300, quantity: 20000, unit: 'tokens', costUsd: 0.003 },
        // An included review: no credits, a real provider cost. Older name for viewer one: the summary shows the newest.
        { n: 6, channel: C.beta, hoursAgo: 74, category: 'other', operation: 'contextual_moderation', provider: 'openrouter', model: LUNA, source: 'moderation', credits: 0, quantity: 1755, unit: 'tokens', costUsd: 0.00001, actorId: A.one.id, actorLogin: 'viewer_one_old', actorName: 'OldName' },
        // Explicit nulls must read like missing fields.
        { n: 7, channel: C.gamma, hoursAgo: 75, category: 'tts', provider: 'kokoro', source: 'voice_preview', credits: 4, quantity: 60, unit: 'characters', actorId: null, actorLogin: null, actorName: null, costUsd: null, voice: null },
        // Legacy, un-itemized: no source, no model.
        { n: 8, channel: C.gamma, hoursAgo: 98, category: 'uncategorized', operation: 'usage', provider: 'unknown', source: null, credits: 10, quantity: null, unit: null, itemized: false },
        { n: 9, channel: C.delta, hoursAgo: 122, category: 'ai_chat', operation: 'final_response', provider: 'openrouter', model: DEEPSEEK, source: 'chat', credits: 20, quantity: 900, unit: 'tokens', ...actor(A.three) },
        // Same instant in two channels: the newest-first order breaks the tie by entry id.
        { n: 10, id: 'usage-tie-a', channel: C.alpha, at: 'tie', category: 'tts', provider: 'fish', source: 'ast', credits: 75, quantity: 50, unit: 'characters' },
        { n: 11, id: 'usage-tie-b', channel: C.beta, at: 'tie', category: 'tts', provider: 'fish', source: 'ast', credits: 75, quantity: 50, unit: 'characters' },
        // Past its plan's retention but not yet removed by the TTL monitor: never shown.
        { n: 12, id: 'usage-expired', channel: C.gamma, hoursAgo: 2, category: 'tts', provider: 'fish', source: 'ast', credits: 9999, quantity: 6666, unit: 'characters', expired: true, ...actor(A.one) },
        // Outside the default window, inside a 30-day one.
        { n: 13, channel: C.alpha, hoursAgo: 240, category: 'tts', provider: 'fish', source: 'ast', credits: 5000, quantity: 3333, unit: 'characters' },
        // Adjustments.
        { n: 14, channel: C.alpha, hoursAgo: 28, entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', provider: 'polar', source: 'admin_credit_grant', credits: -50000 },
        { n: 15, channel: C.gamma, hoursAgo: 51, entryKind: 'adjustment', category: 'credit_adjustment', operation: 'monthly_reset', provider: 'polar', source: 'free_credit_reset_worker', adjustmentType: 'monthly_reset', credits: -25000 },
        // A debit is not a grant.
        { n: 16, channel: C.beta, hoursAgo: 76, entryKind: 'adjustment', category: 'credit_adjustment', operation: 'correction', provider: 'polar', source: 'admin_credit_grant', credits: 100 },
        { n: 17, channel: C.beta, hoursAgo: 480, entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', provider: 'polar', source: 'admin_credit_grant', credits: -1000 }
    ];
}

function receipt(row, now, tieAt) {
    const occurredAt = row.at === 'tie' ? tieAt : new Date(now.getTime() - row.hoursAgo * HOUR);
    const doc = {
        channelID: row.channel.id,
        customerId: `SECRET-cus-${row.channel.id}`,
        entryId: row.id || `usage-seed-${String(row.n).padStart(2, '0')}`,
        requestId: `SECRET-req-${row.n}`,
        occurredAt,
        entryKind: row.entryKind || 'usage',
        category: row.category,
        operation: row.operation || 'synthesize',
        source: row.source,
        adjustmentType: row.adjustmentType || null,
        provider: row.provider,
        model: row.model || null,
        quantity: row.quantity ?? null,
        unit: row.unit ?? null,
        credits: row.credits,
        resourceType: row.category === 'tts' ? 'speech' : null,
        resourceId: `SECRET-res-${row.n}`,
        itemized: row.itemized ?? true,
        retentionTier: row.channel.tier || 'free',
        expiresAt: row.expired ? new Date(now.getTime() - 60_000) : new Date(occurredAt.getTime() + 90 * DAY),
        created_at: occurredAt,
        updated_at: occurredAt
    };
    if (!row.omitNew) {
        for (const field of ['actorId', 'actorLogin', 'actorName', 'voice']) if (field in row) doc[field] = row[field];
        if (!row.omitCost && 'costUsd' in row) doc.costUsd = row.costUsd;
    }
    return doc;
}

function bulkRows(now) {
    const start = now.getTime() - 9 * DAY;
    return Array.from({ length: USAGE_BULK_ROWS }, (_, i) => {
        // Pairs share an instant so page boundaries land inside ties.
        const occurredAt = new Date(start + Math.floor(i / 2) * 60_000);
        return {
            channelID: C.bulk.id, customerId: `SECRET-cus-${C.bulk.id}`, entryId: `usage-bulk-${String(i).padStart(4, '0')}`,
            requestId: null, occurredAt, entryKind: 'usage', category: 'tts', operation: 'synthesize', source: 'ast',
            adjustmentType: null, provider: 'piper', model: null, quantity: 50, unit: 'characters', credits: (i % 7) + 1,
            resourceType: 'speech', resourceId: null, itemized: true, retentionTier: 'free',
            expiresAt: new Date(occurredAt.getTime() + 30 * DAY), created_at: occurredAt, updated_at: occurredAt
        };
    });
}

const t = (count, credits, providerUSD = 0, providerKnown = 0) => ({ count, credits, providerUSD, providerKnown });

/** Hand-computed from the rows above (default 7-day window, entryKind usage, expired row left out). */
export const USAGE_EXPECTED = {
    // withActor: the five calls that name a viewer (2 + 2 + 1 in byActor).
    totals: { ...t(11, 755, 0.00545, 4), channels: 4, chatters: 3, withActor: 5 },
    granted: 75000,
    byCategory: [
        { category: 'tts', ...t(6, 381, 0.002, 1) },
        { category: 'memory', ...t(1, 300, 0.003, 1) },
        { category: 'ai_chat', ...t(2, 64, 0.00044, 1) },
        { category: 'uncategorized', ...t(1, 10) },
        { category: 'other', ...t(1, 0, 0.00001, 1) }
    ],
    byModel: [
        { category: 'tts', provider: 'fish', model: null, ...t(4, 375, 0.002, 1) },
        { category: 'memory', provider: 'openrouter', model: MUSE, ...t(1, 300, 0.003, 1) },
        { category: 'ai_chat', provider: 'openrouter', model: DEEPSEEK, ...t(2, 64, 0.00044, 1) },
        { category: 'uncategorized', provider: 'unknown', model: null, ...t(1, 10) },
        { category: 'tts', provider: 'kokoro', model: null, ...t(1, 4) },
        { category: 'tts', provider: 'piper', model: null, ...t(1, 2) },
        { category: 'other', provider: 'openrouter', model: LUNA, ...t(1, 0, 0.00001, 1) }
    ],
    bySource: [
        { category: 'tts', source: 'ast', ...t(4, 375, 0.002, 1) },
        { category: 'memory', source: 'stream_offline', ...t(1, 300, 0.003, 1) },
        { category: 'ai_chat', source: 'chat', ...t(2, 64, 0.00044, 1) },
        { category: 'uncategorized', source: 'unknown', ...t(1, 10) },
        { category: 'tts', source: 'voice_preview', ...t(1, 4) },
        { category: 'tts', source: 'pet', ...t(1, 2) },
        { category: 'other', source: 'moderation', ...t(1, 0, 0.00001, 1) }
    ],
    byChannel: [
        { channelID: C.beta.id, channel: C.beta.login, planTier: 'premium', ...t(3, 375, 0.00301, 2) },
        { channelID: C.alpha.id, channel: C.alpha.login, planTier: 'pro', ...t(5, 346, 0.00244, 2) },
        { channelID: C.delta.id, channel: null, planTier: null, ...t(1, 20) },
        { channelID: C.gamma.id, channel: C.gamma.login, planTier: 'free', ...t(2, 14) }
    ],
    byActor: [
        { actor: { id: A.one.id, login: A.one.login, name: A.one.name }, ...t(2, 150, 0.00201, 2) },
        { actor: { id: A.two.id, login: A.two.login, name: A.two.name }, ...t(2, 46, 0.00044, 1) },
        { actor: { id: A.three.id, login: A.three.login, name: null }, ...t(1, 20) }
    ],
    /** query → [count, credits] of the summary totals. */
    filters: [
        [{ channel: C.alpha.id }, 5, 346],
        [{ actor: A.one.id }, 2, 150],
        [{ category: 'tts' }, 6, 381],
        [{ provider: 'fish' }, 4, 375],
        [{ model: DEEPSEEK }, 2, 64],
        [{ source: 'unknown' }, 1, 10],
        [{ source: 'ast', channel: C.beta.id }, 1, 75],
        [{ category: 'tts', actor: A.two.id }, 1, 2],
        [{ provider: 'nobody' }, 0, 0]
    ],
    /** Newest first, default filters. */
    newestIds: ['usage-seed-01', 'usage-seed-02', 'usage-tie-b', 'usage-tie-a', 'usage-seed-03', 'usage-seed-04', 'usage-seed-05',
        'usage-seed-06', 'usage-seed-07', 'usage-seed-08', 'usage-seed-09'],
    /** Most expensive first, default filters. */
    creditsIds: ['usage-seed-05', 'usage-seed-01', 'usage-seed-02', 'usage-tie-b', 'usage-tie-a', 'usage-seed-04', 'usage-seed-09',
        'usage-seed-08', 'usage-seed-07', 'usage-seed-03', 'usage-seed-06'],
    adjustmentIds: ['usage-seed-14', 'usage-seed-15', 'usage-seed-16'],
    /** The last 30 days add row 13 (alpha) to usage and row 17 (beta) to grants; [query, count, credits, granted]. */
    thirtyDays: [
        [{ channel: C.alpha.id }, 6, 5346, 50000],
        [{ channel: C.beta.id }, 3, 375, 1000]
    ]
};

/** Expected `daily` for the default window, bucketed independently of the API code. */
function expectedDaily(rows, now, tieAt, from) {
    const credits = new Map(), counts = new Map(), usd = new Map();
    for (const row of rows) {
        if (row.entryKind || row.expired || row.hoursAgo > 7 * 24) continue;
        const date = (row.at === 'tie' ? tieAt : new Date(now.getTime() - row.hoursAgo * HOUR)).toISOString().slice(0, 10);
        credits.set(date, (credits.get(date) || 0) + row.credits);
        counts.set(date, (counts.get(date) || 0) + 1);
        if (typeof row.costUsd === 'number' && !row.omitNew && !row.omitCost) usd.set(date, (usd.get(date) || 0) + row.costUsd);
    }
    const days = [];
    for (let at = Date.parse(from.toISOString().slice(0, 10)); at < now.getTime(); at += DAY) {
        const date = new Date(at).toISOString().slice(0, 10);
        days.push({ date, count: counts.get(date) || 0, credits: credits.get(date) || 0, providerUSD: Math.round((usd.get(date) || 0) * 1e8) / 1e8 });
    }
    return days;
}

export async function seedUsage(db, now = new Date()) {
    const receipts = db.collection('ai_usage_receipts');
    const users = db.collection('users');
    await receipts.deleteMany({ channelID: { $in: SEED_CHANNEL_IDS } });
    await users.deleteMany({ accounts: { $elemMatch: { type: 'twitch', id: { $in: SEED_CHANNEL_IDS } } } });
    const tieAt = new Date(Math.floor((now.getTime() - 6 * HOUR) / 1000) * 1000);
    const rows = seedRows();
    await receipts.insertMany([...rows.map(row => receipt(row, now, tieAt)), ...bulkRows(now)]);
    await users.insertMany(Object.values(USAGE_CHANNELS).filter(channel => channel.login).map(channel => ({
        name: channel.login, email: `SECRET-${channel.login}@example.invalid`, polar_sh_customer_id: `SECRET-cus-${channel.id}`,
        plan_tier: channel.tier, plan_tier_until: null,
        accounts: [{ type: 'twitch', id: channel.id, name: channel.login, display_name: channel.login, access_token: 'SECRET-token', refresh_token: 'SECRET-refresh' }],
        created_at: now, updated_at: now
    })));
    return {
        channels: USAGE_CHANNELS, actors: USAGE_ACTORS, expected: USAGE_EXPECTED,
        dailyFor: from => expectedDaily(rows, now, tieAt, from),
        bulk: { channel: C.bulk.id, rows: USAGE_BULK_ROWS, from: new Date(now.getTime() - 9 * DAY - 60_000), to: new Date(now.getTime() - 8 * DAY) },
        seedChannelIds: SEED_CHANNEL_IDS
    };
}
