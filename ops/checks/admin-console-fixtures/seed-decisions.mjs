// Chat protection decisions for the admin console's decisions ledger check (admin-console-decisions-api.mjs).
// One deliberate decision per case, in three channels (the third has no account here, so no login), with
// SECRET-* markers in every field that must never reach a response. `expected` was counted by hand from
// the table below; it is what the default 30-day window must report.
//
//  #  id                     ch  chatter  kind  source           verdict    status         consequence          model        USD      credits  ms    feedback
//  1  dec-ai-allow           A   U1       ai    first_message    allow      completed      allowed              luna-dated   .00020   0        900
//  2  dec-ai-ban             A   U2       ai    first_message    violation  completed      ban accepted         luna-dated   .00018   0        1100
//  3  dec-ban-refused        B   U1       ai    first_message    violation  completed      ban refused          luna-dated   .00017   0        1000
//  4  dec-near-miss          A   U1       ai    first_message    uncertain  uncertain      allowed_fallback     luna-dated   .00016   0        800   (Review near miss, invited, context)
//  5  dec-contradiction      A   U3       ai    first_message    uncertain  uncertain      allowed_fallback     luna-dated   .00015   0        700   (Review contradiction)
//  6  dec-timeout            B   U4       ai    first_message    uncertain  timeout        allowed_fallback     luna         0        0        0
//  7  dec-unavailable        A   U1       ai    first_message    uncertain  unavailable    allowed_fallback     luna         0        0        150
//  8  dec-rule-warn          A   U1       rule  rule             violation  matched        warn accepted        -            0        0        0
//  9  dec-rule-delete        B   U5       rule  (old row: none)  violation  matched        delete refused       -            0        0        0     (no login)
// 10  dec-rule-timeout       C   U6       rule  rule             violation  matched        timeout accepted     -            0        0        0
// 11  dec-charged            B   U2       ai    spam_continuous  allow      completed      allowed              jev-dated    .00008   9        450
// 12  dec-jev-first          A   U7       ai    first_message    allow      completed      allowed              jev-dated    .00008   9        400   (charged first message)
// 13  dec-labelled-agree     A   U8       ai    first_message    violation  completed      ban accepted         luna-dated   .00019   0        1200  violation + note
// 14  dec-labelled-disagree  B   U9       ai    first_message    allow      completed      allowed              luna-dated   .00014   0        600   violation
// 15  dec-rule-labelled      A   U10      rule  rule             violation  matched        warn accepted        -            0        0        0     allow
// 16  dec-old                A   U1       ai    first_message    allow      completed      allowed              luna-dated   .00010   0        500   (40 days ago)
// 17  dec-lite               A   U11      ai    spam_continuous  allow      completed      allowed              span-lite    0        0        600
// 18  dec-span               B   U12      ai    first_message    allow      completed      allowed              span-dated   .00004   0        700
// 19  dec-pending            A   U13      ai    first_message    uncertain  pending        none                 luna         0        0        0
// 20  dec-plan-required      A   U14      rule  rule             uncertain  plan_required  allowed_fallback     -            0        0        0
export const OWNER = { id: '533538623', login: 'cdom201' };
export const CHANNELS = { A: '710000001', B: '710000002', C: '710000003' };
export const CHANNEL_LOGINS = { A: 'decisions_alpha', B: 'decisions_beta' };
export const U1 = { id: '810000001', login: 'repeat_chatter', name: 'Repeat_Chatter' };
const DAY = 86_400_000;
const LUNA = 'openai/gpt-6-luna-decisions';
const JEV = 'typesafe/jev-1.13';

const said = (username, message, timestamp, isBroadcaster = false) => ({ messageID: `ctx-${username}-${timestamp}`, username, message, timestamp, isBroadcaster });
const builtin = (extra = {}) => ({ id: 'builtin-spam-protection', type: 'blacklist', reason: 'Selected unwanted chat behavior', firstOffense: { action: 'ban', timeoutSeconds: 60 },
    semantic: { enabled: true, categories: ['spam', 'ads', 'self_promotion'], thresholdPercent: 85, policy: 'SECRET-POLICY-TEXT', examples: 'SECRET-EXAMPLES', onUncertain: 'allow_and_log', broadcasterInvitation: false, ...extra } });
const plainRule = (type, reason) => ({ id: `rule-${type}`, type, reason, firstOffense: { action: 'warn', timeoutSeconds: 60 }, semantic: { enabled: false, policy: 'SECRET-POLICY-TEXT' } });
const scored = (violation, safe) => ({ spam: Math.min(violation, 0.5), ads: violation, self_promotion: 0.01, safe, violation });
const executed = (action, success, errorMessage = null) => ({ status: 'executed', action, offenseNumber: 1, success, errorMessage });
const labelled = (label, at, note = null) => ({ label, note, reviewerID: 'SECRET-REVIEWER', reviewedAt: at });

/** Inserts the decisions (replacing the collection's contents: the test database is disposable) and the channels' accounts. */
export async function seedDecisions(db, now = Date.now()) {
    let minute = 0;
    const row = (id, channel, user, fields) => {
        const createdAt = new Date(fields.createdAt ?? now - (40 - ++minute) * 60_000);
        const ai = (fields.mode ?? 'semantic') === 'semantic';
        return {
            _id: id, channelID: CHANNELS[channel], userID: user.id, username: user.name, ...(user.login ? { userLogin: user.login } : {}),
            messageID: `msg-${id}`, messageText: `text of ${id}`, ruleID: 'builtin-spam-protection', rule: builtin(), settingsVersion: 1, matches: [], context: [],
            mode: 'semantic', reviewSource: 'first_message', messageOrdinal: 1, state: 'completed', decisionPolicyVersion: 'contextual-v2',
            verdict: 'allow', status: 'completed', model: `${LUNA}-20261006`, provider: ai ? 'OpenAI' : '', providerRequestID: ai ? `SECRET-PROVIDER-${id}` : '',
            scores: scored(0.02, 0.98), inputTokens: ai ? 1900 : 0, cost: 0, latencyMs: 0,
            charge: { status: ai ? 'recorded' : 'none', credits: 0, billableCostUSD: 0, externalID: `SECRET-EXTERNAL-${id}`, customerID: 'SECRET-CUSTOMER' },
            consequence: { status: 'allowed' }, feedback: null,
            deadline: new Date(createdAt.getTime() + 4000), expiresAt: new Date(createdAt.getTime() + 180 * DAY),
            ...fields, createdAt
        };
    };
    const user = n => ({ id: `8100000${String(n).padStart(2, '0')}`, login: `chatter_${n}`, name: `Chatter_${n}` });
    const rule = (type, reason, consequence, extra = {}) => ({ mode: 'literal', reviewSource: 'rule', messageOrdinal: undefined, ruleID: `rule-${type}`, rule: plainRule(type, reason),
        verdict: 'violation', status: 'matched', model: '', scores: null, consequence, ...extra });
    const docs = [
        row('dec-ai-allow', 'A', U1, { cost: 0.0002, latencyMs: 900 }),
        row('dec-ai-ban', 'A', user(2), { verdict: 'violation', scores: scored(0.95, 0.03), consequence: executed('ban', true), cost: 0.00018, latencyMs: 1100 }),
        row('dec-ban-refused', 'B', U1, { verdict: 'violation', scores: scored(0.97, 0.02), cost: 0.00017, latencyMs: 1000,
            consequence: executed('ban', false, 'The user specified in the user_id field is already banned.') }),
        row('dec-near-miss', 'A', U1, { verdict: 'uncertain', status: 'uncertain', scores: scored(0.7, 0.6), consequence: { status: 'allowed_fallback' }, cost: 0.00016, latencyMs: 800,
            messageOrdinal: 2, rule: builtin({ broadcasterInvitation: true, categories: ['ads', 'self_promotion'] }),
            context: [said('Chatter_20', 'later line', now - 20_000), said('decisions_alpha', 'share your links!', now - 40_000, true)] }),
        row('dec-contradiction', 'A', user(3), { verdict: 'uncertain', status: 'uncertain', scores: scored(0.99, 0.96), consequence: { status: 'allowed_fallback' }, cost: 0.00015, latencyMs: 700 }),
        row('dec-timeout', 'B', user(4), { verdict: 'uncertain', status: 'timeout', model: LUNA, provider: 'openrouter', providerRequestID: '', scores: null, consequence: { status: 'allowed_fallback' },
            charge: { status: 'none', credits: 0, externalID: '', customerID: '' } }),
        row('dec-unavailable', 'A', U1, { verdict: 'uncertain', status: 'unavailable', model: LUNA, scores: null, consequence: { status: 'allowed_fallback' }, latencyMs: 150, messageOrdinal: 3 }),
        row('dec-rule-warn', 'A', U1, rule('caps', 'Too many capital letters', executed('warn', true))),
        // Stored before review sources and chatter logins existed.
        row('dec-rule-delete', 'B', { id: '810000005', name: 'Usuario_Cinco' }, rule('blacklist', 'Blocked word', executed('delete', false, 'Bad Request'),
            { mode: 'regex', reviewSource: undefined, matches: [{ matcherID: 'm1', text: 'bad', start: 0, end: 3 }] })),
        row('dec-rule-timeout', 'C', user(6), rule('links', 'Please do not post links', executed('timeout', true))),
        row('dec-charged', 'B', user(2), { reviewSource: 'spam_continuous', messageOrdinal: undefined, model: `${JEV}-20260917`, provider: 'TypeSafe', cost: 0.00008, latencyMs: 450,
            charge: { status: 'recorded', credits: 9, billableCostUSD: 0.00008, externalID: 'SECRET-EXTERNAL-c', customerID: 'SECRET-CUSTOMER' } }),
        row('dec-jev-first', 'A', user(7), { model: `${JEV}-20260917`, provider: 'TypeSafe', cost: 0.00008, latencyMs: 400,
            charge: { status: 'recorded', credits: 9, billableCostUSD: 0.00008, externalID: 'SECRET-EXTERNAL-j', customerID: 'SECRET-CUSTOMER' } }),
        row('dec-labelled-agree', 'A', user(8), { verdict: 'violation', scores: scored(0.96, 0.02), consequence: executed('ban', true), cost: 0.00019, latencyMs: 1200,
            feedback: labelled('violation', new Date(now - 60_000), 'obvious seller') }),
        row('dec-labelled-disagree', 'B', { id: '810000009', login: 'chatter_9', name: 'ビューア' }, { scores: scored(0.1, 0.9), cost: 0.00014, latencyMs: 600,
            feedback: labelled('violation', new Date(now - 60_000)) }),
        row('dec-rule-labelled', 'A', user(10), rule('caps', 'Too many capital letters', executed('warn', true), { feedback: labelled('allow', new Date(now - 60_000)) })),
        row('dec-old', 'A', U1, { createdAt: now - 40 * DAY, cost: 0.0001, latencyMs: 500 }),
        row('dec-lite', 'A', user(11), { reviewSource: 'spam_continuous', messageOrdinal: undefined, model: 'respan/span-01-lite-20260925', provider: 'Respan', latencyMs: 600 }),
        row('dec-span', 'B', user(12), { model: 'respan/span-01-20260925', provider: 'Respan', cost: 0.00004, latencyMs: 700 }),
        row('dec-pending', 'A', user(13), { state: 'pending', verdict: 'uncertain', status: 'pending', model: LUNA, provider: '', scores: null, consequence: { status: 'none' } }),
        row('dec-plan-required', 'A', user(14), rule('blacklist', 'Blocked word', { status: 'allowed_fallback' }, { verdict: 'uncertain', status: 'plan_required' }))
    ].map(doc => Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined)));
    const decisions = db.collection('moderation_decisions');
    await decisions.deleteMany({});
    await decisions.insertMany(docs);
    for (const [key, login] of Object.entries(CHANNEL_LOGINS)) {
        await db.collection('users').updateOne({ accounts: { $elemMatch: { type: 'twitch', id: CHANNELS[key] } } },
            { $setOnInsert: { accounts: [{ type: 'twitch', id: CHANNELS[key], name: login }], plan_tier: 'free' } }, { upsert: true });
    }
    return docs;
}

/** Hand-counted from the table: the default 30-day window, every channel (row 16 is outside it). */
export const expected = {
    summary: {
        total: 19, aiReviews: 14, ruleHits: 5, violations: 3, bans: 2, bansFailed: 1, notReviewed: 4, included: 11,
        providerUSD: 0.00139, credits: 18, channels: 3, labelled: 3, agree: 1, disagree: 2, verdictsWaiting: 4,
        // Finished AI reviews: 400 450 600 600 700 700 800 900 1000 1100 1200.
        latencyP50Ms: 700
    },
    summaryChannelA: { total: 12, aiReviews: 9, ruleHits: 3, violations: 2, bans: 2, bansFailed: 0, notReviewed: 3, included: 7, providerUSD: 0.00096, credits: 9, channels: 1, labelled: 2, agree: 1, disagree: 1 },
    byModel: [
        // bans = accepted by Twitch (#2 and #13); #3 was refused.
        { model: LUNA, reviews: 10, violations: 3, bans: 2, notReviewed: 3, providerUSD: 0.00119 },
        { model: JEV, reviews: 2, violations: 0, bans: 0, notReviewed: 0, providerUSD: 0.00016 },
        { model: 'respan/span-01', reviews: 1, violations: 0, bans: 0, notReviewed: 0, providerUSD: 0.00004 },
        { model: 'respan/span-01-lite', reviews: 1, violations: 0, bans: 0, notReviewed: 0, providerUSD: 0 }
    ],
    byChannel: [{ key: 'A', reviews: 12, violations: 2 }, { key: 'B', reviews: 6, violations: 1 }, { key: 'C', reviews: 1, violations: 0 }],
    reviewCounts: { contradiction: 1, near_miss: 1, ban: 2 },
    lists: {
        '': 19,
        'show=acted': ['dec-ai-ban', 'dec-rule-warn', 'dec-rule-timeout', 'dec-labelled-agree', 'dec-rule-labelled'],
        'show=action_failed': ['dec-ban-refused', 'dec-rule-delete'],
        'show=bans': ['dec-ai-ban', 'dec-ban-refused', 'dec-labelled-agree'],
        'show=not_reviewed': ['dec-timeout', 'dec-unavailable', 'dec-pending', 'dec-plan-required'],
        'show=allowed': ['dec-ai-allow', 'dec-near-miss', 'dec-contradiction', 'dec-charged', 'dec-jev-first', 'dec-labelled-disagree', 'dec-lite', 'dec-span'],
        'show=near_miss': ['dec-near-miss'],
        'kind=ai': 14,
        'kind=rule': ['dec-rule-warn', 'dec-rule-delete', 'dec-rule-timeout', 'dec-rule-labelled', 'dec-plan-required'],
        'source=rule': ['dec-rule-warn', 'dec-rule-delete', 'dec-rule-timeout', 'dec-rule-labelled', 'dec-plan-required'],
        'source=spam_continuous': ['dec-charged', 'dec-lite'],
        'source=first_message': 12,
        [`model=${LUNA}`]: 10,
        [`model=${JEV}`]: ['dec-charged', 'dec-jev-first'],
        'model=respan/span-01': ['dec-span'],
        'model=respan/span-01-lite': ['dec-lite'],
        'model=typesafe/jev': [],
        'feedback=none': 16,
        'feedback=any': ['dec-labelled-agree', 'dec-labelled-disagree', 'dec-rule-labelled'],
        'feedback=agree': ['dec-labelled-agree'],
        'feedback=disagree': ['dec-labelled-disagree', 'dec-rule-labelled'],
        [`channel=${CHANNELS.A}`]: 12,
        [`channel=${CHANNEL_LOGINS.A}`]: 12,
        [`channel=${CHANNELS.B}`]: 6,
        [`channel=${CHANNELS.C}`]: ['dec-rule-timeout'],
        'channel=nobody_here': [],
        [`chatter=${U1.id}`]: ['dec-ai-allow', 'dec-ban-refused', 'dec-near-miss', 'dec-unavailable', 'dec-rule-warn'],
        'chatterName=REPEAT_CHATTER': 5,
        'chatterName=@Repeat_Chatter': 5,
        'chatterName=usuario_cinco': ['dec-rule-delete'],
        [`chatterName=${encodeURIComponent('ビューア')}`]: ['dec-labelled-disagree'],
        [`chatter=${U1.id}&show=acted`]: ['dec-rule-warn'],
        [`channel=${CHANNELS.A}&kind=ai&show=bans`]: ['dec-ai-ban', 'dec-labelled-agree']
    },
    firstBySort: {
        cost: ['dec-ai-allow', 'dec-labelled-agree', 'dec-ai-ban'],
        score: ['dec-contradiction', 'dec-ban-refused', 'dec-labelled-agree', 'dec-ai-ban'],
        slowest: ['dec-labelled-agree', 'dec-ai-ban', 'dec-ban-refused']
    },
    // The other decisions of U1 in channel A, newest first; the one in channel B is not this channel's.
    nearMissHistory: ['dec-rule-warn', 'dec-unavailable', 'dec-ai-allow', 'dec-old']
};
