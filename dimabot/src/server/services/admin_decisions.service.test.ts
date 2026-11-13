import assert from 'node:assert/strict';
import test from 'node:test';
import {
    NOT_REVIEWED_STATUSES, chatterNameFilter, decisionFilter, decisionOutcome, feedbackAgrees, feedbackFilter, mapDecisionRow, mapFeedback,
    modelFilter, normalizeModel, showFilter
} from './admin_decisions.service.js';

const at = new Date('2026-11-12T10:00:00.000Z');
const base: Record<string, any> = {
    _id: 'd1', createdAt: at, channelID: '700000001', userID: '800000001', username: 'Viewer_One', userLogin: 'viewer_one',
    messageText: 'buy viewers', mode: 'semantic' as const, ruleID: 'builtin-spam-protection',
    rule: { id: 'builtin-spam-protection', type: 'blacklist', reason: 'Selected unwanted chat behavior', semantic: { thresholdPercent: 90, policy: 'SECRET' } } as any,
    reviewSource: 'first_message' as const, messageOrdinal: 1, verdict: 'violation' as const, status: 'completed',
    consequence: { status: 'executed', action: 'ban', offenseNumber: 1, success: true, errorMessage: null },
    model: 'openai/gpt-6-luna-decisions-20261006', provider: 'OpenAI', providerRequestID: 'SECRET-REQ',
    scores: { spam: 0.9, ads: 0.95, safe: 0.03, violation: 0.95, junk: 'x' }, inputTokens: 1900, cost: 0.00019,
    charge: { status: 'recorded', credits: 0, externalID: 'SECRET-EXT', customerID: 'SECRET-CUS' }, latencyMs: 812,
    feedback: { label: 'violation', note: 'clear ad', reviewerID: 'SECRET-REVIEWER', reviewedAt: at }
};
const channels = new Map([['700000001', 'some_streamer']]);

test('every status maps to an outcome; the executor\'s answer decides acted vs failed', () => {
    assert.equal(decisionOutcome({ status: 'completed', consequence: { status: 'executed', success: true } }), 'acted');
    assert.equal(decisionOutcome({ status: 'completed', consequence: { status: 'executed', success: false } }), 'action_failed');
    assert.equal(decisionOutcome({ status: 'matched', consequence: { status: 'executed' } }), 'action_failed', 'no answer from Twitch is not a success');
    for (const status of NOT_REVIEWED_STATUSES) assert.equal(decisionOutcome({ status, consequence: { status: 'allowed_fallback' } }), 'not_reviewed', status);
    for (const status of ['completed', 'uncertain', 'matched']) assert.equal(decisionOutcome({ status, consequence: { status: 'allowed' } }), 'allowed', status);
    assert.equal(decisionOutcome({ status: 'completed', consequence: { status: 'cancelled' } }), 'allowed', 'a cancelled ban did nothing');
    assert.equal(decisionOutcome({ status: 'completed', consequence: { status: 'scheduled', action: 'ban' } }), 'allowed');
    assert.equal(decisionOutcome({ status: 'timeout' }), 'not_reviewed');
});

test('model ids lose only a trailing date', () => {
    assert.equal(normalizeModel('openai/gpt-6-luna-decisions-20261006'), 'openai/gpt-6-luna-decisions');
    assert.equal(normalizeModel('openai/gpt-6-luna-decisions'), 'openai/gpt-6-luna-decisions');
    assert.equal(normalizeModel('typesafe/jev-1.13-20260917'), 'typesafe/jev-1.13');
    assert.equal(normalizeModel('respan/span-01-lite'), 'respan/span-01-lite');
    assert.equal(normalizeModel('x-2026101'), 'x-2026101', 'seven digits are not a date');
});

test('agree means the verdict matches what the bot concluded', () => {
    assert.equal(feedbackAgrees('violation', 'violation'), true);
    assert.equal(feedbackAgrees('allow', 'allow'), true);
    assert.equal(feedbackAgrees('allow', 'uncertain'), true);
    assert.equal(feedbackAgrees('violation', 'uncertain'), false);
    assert.equal(feedbackAgrees('allow', 'violation'), false);
});

test('a built-in AI ban maps to the contract row without secrets', () => {
    const row = mapDecisionRow(base, channels);
    assert.deepEqual(row, {
        id: 'd1', at: '2026-11-12T10:00:00.000Z', channelID: '700000001', channel: 'some_streamer',
        chatter: { id: '800000001', login: 'viewer_one', name: 'Viewer_One' }, messageText: 'buy viewers', kind: 'ai', ruleType: 'builtin', ruleReason: null,
        source: 'first_message', messageOrdinal: 1, verdict: 'violation', status: 'completed', outcome: 'acted', action: 'ban', actionError: null,
        model: 'openai/gpt-6-luna-decisions', provider: 'OpenAI', scores: { spam: 0.9, ads: 0.95, safe: 0.03, violation: 0.95 }, thresholdPercent: 90,
        inputTokens: 1900, providerUSD: 0.00019, credits: 0, included: true, latencyMs: 812, nearMiss: false,
        feedback: { label: 'violation', note: 'clear ad', reviewedAt: '2026-11-12T10:00:00.000Z' }
    });
    assert.equal(JSON.stringify(row).includes('SECRET'), false);
});

test('rule hits, charged reviews, refused actions and old rows', () => {
    const rule = mapDecisionRow({ ...base, mode: 'literal', ruleID: 'r-1', rule: { type: 'links', reason: 'No links', semantic: { enabled: false } } as any, reviewSource: undefined,
        messageOrdinal: undefined, verdict: 'violation', status: 'matched', model: '', provider: '', scores: null, cost: 0, latencyMs: 0, userLogin: undefined,
        consequence: { status: 'executed', action: 'delete', success: false, errorMessage: 'Bad Request' }, feedback: null }, new Map());
    assert.deepEqual([rule.kind, rule.ruleType, rule.ruleReason, rule.source, rule.model, rule.provider, rule.thresholdPercent, rule.scores, rule.channel],
        ['rule', 'links', 'No links', 'rule', null, null, null, null, null]);
    assert.deepEqual([rule.outcome, rule.action, rule.actionError, rule.included, rule.feedback], ['action_failed', 'delete', 'Bad Request', false, null]);
    assert.deepEqual(rule.chatter, { id: '800000001', login: null, name: 'Viewer_One' });
    const charged = mapDecisionRow({ ...base, reviewSource: 'first_message', charge: { status: 'recorded', credits: 9, externalID: '', customerID: '' } }, channels);
    assert.deepEqual([charged.included, charged.credits], [false, 9], 'Jev-era first messages were charged');
    const continuous = mapDecisionRow({ ...base, reviewSource: 'spam_continuous', messageOrdinal: undefined, rule: { semantic: {} } as any }, channels);
    assert.deepEqual([continuous.included, continuous.messageOrdinal, continuous.thresholdPercent], [false, null, 85]);
    const timeout = mapDecisionRow({ ...base, verdict: 'uncertain', status: 'timeout', model: 'respan/span-01', scores: null, consequence: { status: 'allowed_fallback' } }, channels);
    assert.deepEqual([timeout.outcome, timeout.action, timeout.model, timeout.scores], ['not_reviewed', null, 'respan/span-01', null]);
    // A near miss is marked on the row with the same test as the `show=near_miss` filter: no ban, answered in time,
    // top score at least 50% and the model not sure it was safe. A ban, a timeout and a confident "safe" are not.
    const near = (scores: Record<string, number> | null, extra: Record<string, unknown> = {}) => mapDecisionRow({
        _id: 'n', channelID: '1', userID: '2', username: 'V', mode: 'semantic', ruleID: 'builtin-spam-protection', verdict: 'uncertain', status: 'uncertain',
        scores, consequence: { status: 'allowed_fallback' }, ...extra } as never, new Map()).nearMiss;
    assert.deepEqual([
        near({ violation: 0.75, safe: 0.2 }), near({ violation: 0.5, safe: 0.9 }), near({ violation: 0.49, safe: 0.2 }), near({ violation: 0.75, safe: 0.95 }),
        near({ violation: 0.95, safe: 0.02 }, { verdict: 'violation', status: 'completed' }), near(null, { status: 'timeout' }),
        near({ violation: 0.75, safe: 0.2 }, { mode: 'literal' })
    ], [true, true, false, false, false, false, false]);
    const off = mapDecisionRow({ ...base, consequence: { status: 'executed', action: 'off', success: true } }, channels);
    assert.equal(off.action, null, '"off" is not an action in chat');
});

test('feedback keeps only the two labels and drops the reviewer', () => {
    assert.equal(mapFeedback(null), null);
    assert.equal(mapFeedback({ label: 'uncertain', reviewerID: 'x', reviewedAt: at }), null);
    assert.deepEqual(mapFeedback({ label: 'allow', reviewerID: 'x', reviewedAt: at }), { label: 'allow', note: null, reviewedAt: at.toISOString() });
});

test('show filters', () => {
    const fallback = [...NOT_REVIEWED_STATUSES];
    assert.deepEqual(showFilter('acted'), { 'consequence.status': 'executed', 'consequence.success': true });
    assert.deepEqual(showFilter('action_failed'), { 'consequence.status': 'executed', 'consequence.success': { $ne: true } });
    assert.deepEqual(showFilter('bans'), { 'consequence.status': 'executed', 'consequence.action': 'ban' });
    assert.deepEqual(showFilter('not_reviewed'), { 'consequence.status': { $ne: 'executed' }, status: { $in: fallback } });
    assert.deepEqual(showFilter('allowed'), { 'consequence.status': { $ne: 'executed' }, status: { $nin: fallback } });
    assert.deepEqual(showFilter('near_miss'), { mode: 'semantic', verdict: { $ne: 'violation' }, status: { $in: ['completed', 'uncertain'] },
        'scores.violation': { $type: 'number', $gte: 0.5 }, 'scores.safe': { $type: 'number', $lte: 0.9 } });
});

test('feedback, model and name filters never build a pattern from input', () => {
    assert.deepEqual(feedbackFilter('none'), { 'feedback.label': { $exists: false } });
    assert.deepEqual(feedbackFilter('any'), { 'feedback.label': { $in: ['violation', 'allow'] } });
    assert.deepEqual(feedbackFilter('agree'), { $or: [{ 'feedback.label': 'violation', verdict: 'violation' }, { 'feedback.label': 'allow', verdict: { $ne: 'violation' } }] });
    assert.deepEqual(feedbackFilter('disagree'), { $or: [{ 'feedback.label': 'violation', verdict: { $ne: 'violation' } }, { 'feedback.label': 'allow', verdict: 'violation' }] });
    assert.deepEqual(modelFilter('a/b'), { $or: [{ model: 'a/b' }, { model: { $gte: 'a/b-00000000', $lte: 'a/b-99999999' }, $expr: { $eq: [{ $strLenCP: '$model' }, 12] } }] });
    assert.deepEqual(chatterNameFilter('Viewer_One'), { $or: [{ userLogin: 'viewer_one' }, { username: 'Viewer_One' },
        { $expr: { $eq: [{ $toLower: { $ifNull: ['$username', ''] } }, { $literal: 'viewer_one' }] } }] });
    // A name that looks like a field path or a variable is compared as text, never evaluated.
    const hostile = chatterNameFilter('$username') as { $or: Array<{ $expr?: { $eq: unknown[] } }> };
    assert.deepEqual(hostile.$or[2].$expr!.$eq[1], { $literal: '$username' });
    assert.deepEqual((chatterNameFilter('$$ROOT') as typeof hostile).$or[2].$expr!.$eq[1], { $literal: '$$root' });
    const json = JSON.stringify(decisionFilter({ from: at, to: at, model: 'a/b', chatterName: 'x', feedback: 'agree', show: 'bans', kind: 'ai', source: 'rule' }));
    assert.equal(json.includes('$regex'), false);
});

test('the combined filter', () => {
    const from = new Date('2026-11-01T00:00:00Z');
    assert.deepEqual(decisionFilter({ from, to: at }), { createdAt: { $gte: from, $lte: at } });
    assert.deepEqual(decisionFilter({ from, to: at, channelID: '1', chatterID: '2', kind: 'rule', source: 'rule' }), {
        createdAt: { $gte: from, $lte: at }, channelID: '1', userID: '2',
        $and: [{ mode: { $in: ['literal', 'regex'] } }, { reviewSource: { $in: ['rule', null] } }]
    });
    assert.deepEqual(decisionFilter({ from, to: at, channelID: null }).channelID, { $in: [] }, 'an unknown channel login matches nothing');
});
