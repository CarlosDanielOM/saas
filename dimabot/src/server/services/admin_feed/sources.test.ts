import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Types } from 'mongoose';
import type { IActivityLog } from '../../../schemas/activity_log.schema.js';
import type { IAiUsageReceipt } from '../../../schemas/ai_usage_receipt.schema.js';
import type { ISiteAgentTurnLog } from '../../../site_agent/turn_log.schema.js';
import { activityFilter, activityItem, activitySource } from './sources/activity.js';
import { assistantSource, turnFilter, turnItem } from './sources/assistant.js';
import { docsItem, docsPage, docsPageItems, docsSource } from './sources/docs.js';
import { localBound } from './source.js';
import { eventFilter, eventItem, eventsSource, FEED_EVENT_TYPES, viewerFilters } from './sources/events.js';
import { decisionFilter, decisionItem, modelWithoutDate, protectionSource, topScore, type DecisionRow } from './sources/protection.js';
import { usageFilter, usageItem, usageSource } from './sources/usage.js';
import type { FeedFilters } from './types.js';

const from = new Date('2026-11-01T00:00:00.000Z');
const to = new Date('2026-11-08T00:00:00.000Z');
const now = new Date('2026-11-08T00:00:00.000Z');
const scope: FeedFilters = { from, to };
const at = new Date('2026-11-05T10:00:00.123Z');

describe('activity source', () => {
    const row: IActivityLog = {
        _id: 'a1', at, channelID: '100', kind: 'command', name: '!so', outcome: 'skipped', reason: 'cooldown',
        actorID: '7', actorLogin: 'viewer', actorName: 'Viewer', text: '!so @friend', ref: '', durationMs: 12,
        data: { func: 'shoutout', trigger: 'chat', live: true }, service: 'bot', expiresAt: at
    };
    it('maps a row one to one', () => {
        assert.deepEqual(activityItem(row), {
            id: 'activity:a1', at: at.toISOString(), kind: 'command', name: '!so', outcome: 'skipped', reason: 'cooldown',
            channelID: '100', channel: null, actor: { id: '7', login: 'viewer', name: 'Viewer' }, text: '!so @friend',
            credits: null, providerUSD: null, durationMs: 12, data: { func: 'shoutout', trigger: 'chat', live: true },
            ref: { type: 'activity', id: 'a1' }
        });
    });
    it('points an alert at its journaled event and blanks empty fields', () => {
        const alert = activityItem({ ...row, kind: 'alert', outcome: 'ok', reason: '', channelID: '', actorID: '', actorLogin: '', actorName: '', text: '', durationMs: null, ref: 'twitch-eventsub:abc%3A1:channel.follow.received' });
        assert.deepEqual(alert.ref, { type: 'event', id: 'twitch-eventsub:abc%3A1:channel.follow.received' });
        assert.equal(alert.channelID, null);
        assert.equal(alert.actor, null);
        assert.equal(alert.text, null);
        assert.equal(alert.reason, null);
        assert.deepEqual(activityItem({ ...row, kind: 'alert', ref: 'speech-1' }).ref, { type: 'activity', id: 'a1' });
    });
    it('filters by kind, channel, chatter and outcome with index-friendly predicates', () => {
        assert.deepEqual(activityFilter(scope, ['command', 'bot_message', 'twitch_event', 'alert', 'voice', 'system']), {});
        assert.deepEqual(activityFilter({ ...scope, channelID: '1', actorLogin: 'x', outcome: 'failed' }, ['alert']), {
            kind: 'alert', channelID: '1', actorLogin: 'x', outcome: { $in: ['skipped', 'blocked', 'failed'], $eq: 'failed' }
        });
        // Problems: failed, or refused for a reason that is not a setting. Skipped (turned off, cooldown) never is.
        assert.deepEqual(activityFilter({ ...scope, actorID: '5', actorLogin: 'x', outcome: 'problems' }, ['command', 'voice']), {
            kind: { $in: ['command', 'voice'] }, actorID: '5', outcome: { $in: ['skipped', 'blocked', 'failed'], $ne: 'skipped' },
            $nor: [{ outcome: 'blocked', reason: { $in: ['permission_denied'] } }]
        });
        assert.deepEqual(activitySource.plan({ ...scope, kinds: ['voice', 'docs', 'protection'] }), ['voice']);
    });
});

describe('events source', () => {
    const row = (type: string, event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId('65a000000000000000000001'), eventKey: `twitch-eventsub:m1:${type}`, source: 'twitch-eventsub',
        type, channelID: '100', occurredAt: at, payload: { event }, metadata: {}, ...extra
    });
    it('maps bits with the cheerer and the amount', () => {
        const item = eventItem(row('channel.bits.received', { user_id: '7', user_login: 'Viewer', user_name: 'Viewer', bits: 500, message: { text: 'Cheer500 hi' } }, { metadata: { originalEventType: 'channel.bits.use' } }), 2);
        assert.equal(item.id, 'event:65a000000000000000000001');
        assert.equal(item.name, 'channel.bits.use');
        assert.equal(item.kind, 'twitch_event');
        assert.equal(item.outcome, 'ok');
        assert.deepEqual(item.actor, { id: '7', login: 'viewer', name: 'Viewer' });
        assert.deepEqual(item.data, { amount: 500, message: 'Cheer500 hi', failedDeliveries: 2 });
        assert.equal(item.text, 'Cheer500 hi');
        assert.deepEqual(item.ref, { type: 'event', id: 'twitch-eventsub:m1:channel.bits.received' });
    });
    it('names the raiding broadcaster, marks test events and falls back to the journal type mapping', () => {
        const raid = eventItem(row('channel.raid.received', { from_broadcaster_user_id: '9', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider', viewers: 42 }, { source: 'twitch-eventsub-test' }));
        assert.equal(raid.name, 'channel.raid');
        assert.deepEqual(raid.actor, { id: '9', login: 'raider', name: 'Raider' });
        assert.deepEqual(raid.data, { viewers: 42, test: true });
        const sent = eventItem(row('channel.raid.sent', { from_broadcaster_user_id: '100', viewers: 3 }));
        assert.equal(sent.name, 'channel.raid');
        assert.equal(eventItem(row('stream.started', { broadcaster_user_id: '100' })).name, 'stream.online');
        assert.equal(eventItem(row('stream.started', { broadcaster_user_id: '100' })).actor, null);
    });
    it('keeps gift and sub facts and hides anonymous gifters', () => {
        const gift = eventItem(row('channel.subscription.gifted', { user_id: null, is_anonymous: true, total: 5, tier: '1000' }));
        assert.equal(gift.actor, null);
        assert.deepEqual(gift.data, { amount: 5, tier: '1000' });
        const resub = eventItem(row('channel.chat.notification', { chatter_user_id: '7', chatter_user_login: 'v', chatter_user_name: 'V', notice_type: 'resub', resub: { cumulative_months: 14, sub_tier: '2000' }, message: { text: 'yo' } }));
        assert.deepEqual(resub.data, { notice: 'resub', tier: '2000', months: 14, message: 'yo' });
    });
    it('never lists progress updates or billing events', () => {
        assert.ok(FEED_EVENT_TYPES.includes('channel.poll.began') && FEED_EVENT_TYPES.includes('channel.goal.ended') && FEED_EVENT_TYPES.includes('channel.raid.sent'));
        assert.equal(FEED_EVENT_TYPES.some(type => type.endsWith('.updated') || type.startsWith('billing.')), false);
        assert.deepEqual(eventFilter(scope).topic, 'channel');
    });
    it('finds a viewer by id in any channel through the viewer indexes', () => {
        assert.deepEqual(eventsSource.plan({ ...scope, actorID: '7' }), ['twitch_event']);
        assert.deepEqual(eventsSource.plan({ ...scope, actorID: '7', channelID: '1' }), ['twitch_event']);
        assert.deepEqual(eventsSource.gaps!({ ...scope, actorID: '7' }), []);
        assert.deepEqual(eventFilter({ ...scope, actorID: '7' }).$or, ['user_id', 'chatter_user_id', 'from_broadcaster_user_id', 'requester_user_id']
            .map(field => ({ topic: 'channel', [`payload.event.${field}`]: { $eq: '7', $type: 'string' } })));
        const perField = viewerFilters({ ...scope, actorID: '7', channelID: '1' });
        assert.equal(perField.length, 4);
        assert.deepEqual(perField[2], { ...eventFilter({ ...scope, channelID: '1' }), 'payload.event.from_broadcaster_user_id': { $eq: '7', $type: 'string' } });
    });
    it('searches a login only inside a channel, and says so otherwise', () => {
        assert.deepEqual(eventsSource.plan({ ...scope, actorLogin: 'v' }), []);
        assert.deepEqual(eventsSource.gaps!({ ...scope, actorLogin: 'v' }), ['twitch_event']);
        assert.deepEqual(eventsSource.gaps!({ ...scope, actorLogin: 'v', kinds: ['command'] }), []);
        assert.deepEqual(eventsSource.gaps!({ ...scope, actorLogin: 'v', channelID: '1' }), []);
        assert.deepEqual(eventsSource.plan({ ...scope, outcome: 'problems' }), []);
        assert.deepEqual(eventsSource.gaps!({ ...scope, actorLogin: 'v', outcome: 'problems' }), [], 'no event is a problem: nothing can be missing');
        assert.deepEqual(eventFilter({ ...scope, channelID: '1', actorLogin: 'v' }).$or, [
            { 'payload.event.user_login': 'v' }, { 'payload.event.chatter_user_login': 'v' }, { 'payload.event.from_broadcaster_user_login': 'v' }, { 'payload.event.requester_user_login': 'v' }
        ]);
    });
});

describe('protection source', () => {
    const base: DecisionRow = {
        _id: 'd1', channelID: '100', userID: '7', userLogin: 'viewer', username: 'Viewer', messageText: 'buy followers', ruleID: 'builtin-spam-protection',
        rule: { type: 'blacklist' }, mode: 'semantic', reviewSource: 'first_message', verdict: 'violation', status: 'completed',
        model: 'openai/gpt-6-luna-decisions-20261006', scores: { self_promotion: 0.91, scam: 0.4, safe: 0.09, violation: 0.91 }, cost: 0.00012,
        latencyMs: 800, charge: { credits: 0 }, consequence: { status: 'executed', action: 'ban', success: true }, createdAt: at
    };
    it('maps a review with its verdict, top category, cost and model without date', () => {
        const item = decisionItem(base);
        assert.equal(item.id, 'decision:d1');
        assert.equal(item.name, 'first_message');
        assert.equal(item.outcome, 'ok');
        assert.equal(item.credits, 0);
        assert.equal(item.providerUSD, 0.00012);
        assert.equal(item.durationMs, 800);
        assert.deepEqual(item.actor, { id: '7', login: 'viewer', name: 'Viewer' });
        assert.deepEqual(item.data, {
            verdict: 'violation', status: 'completed', action: 'ban', actionSucceeded: true, topCategory: 'self_promotion', topScore: 0.91,
            model: 'openai/gpt-6-luna-decisions', included: true, ruleType: 'builtin', source: 'first_message'
        });
        assert.deepEqual(item.ref, { type: 'decision', id: 'd1' });
    });
    it('marks unfinished reviews failed, refused actions failed and deliberate non-reviews skipped', () => {
        assert.deepEqual([decisionItem({ ...base, status: 'timeout', cost: 0, latencyMs: 0 })].map(i => [i.outcome, i.reason, i.providerUSD, i.durationMs]), [['failed', 'timeout', null, null]]);
        const refused = decisionItem({ ...base, consequence: { status: 'executed', action: 'ban', success: false, errorMessage: 'user is a moderator' } });
        assert.deepEqual([refused.outcome, refused.reason, refused.data.actionError], ['failed', 'action_failed', 'user is a moderator']);
        assert.deepEqual([decisionItem({ ...base, status: 'credits_unavailable' }).outcome, decisionItem({ ...base, status: 'uncertain' }).outcome], ['skipped', 'ok']);
    });
    it('shows a plain rule hit without credits or model', () => {
        const rule = decisionItem({ ...base, ruleID: 'r1', rule: { type: 'caps' }, mode: 'literal', reviewSource: 'rule', model: '', scores: null, cost: 0, latencyMs: 0 });
        assert.deepEqual([rule.name, rule.credits, rule.providerUSD, rule.data.model, rule.data.ruleType, rule.data.included], ['caps', null, null, undefined, 'caps', false]);
    });
    it('reads scores and models defensively', () => {
        assert.deepEqual(topScore({ violation: 0.3 }), { category: 'violation', score: 0.3 });
        assert.equal(topScore(null), null);
        assert.equal(modelWithoutDate('respan/span-01-20260925'), 'respan/span-01');
        assert.equal(modelWithoutDate(''), null);
    });
    it('filters problems on its own fields', () => {
        const filter = decisionFilter({ ...scope, channelID: '1', actorID: '7', outcome: 'failed' });
        assert.equal(filter.channelID, '1');
        assert.equal(filter.userID, '7');
        assert.ok(Array.isArray(filter.$or));
        // A skipped review (no credits) is not a problem: "problems" and "failed" are the same filter.
        assert.deepEqual(decisionFilter({ ...scope, outcome: 'problems' }), decisionFilter({ ...scope, outcome: 'failed' }));
        assert.deepEqual(decisionFilter({ ...scope, actorLogin: 'viewer' }), { userLogin: 'viewer' });
        assert.deepEqual(protectionSource.plan({ ...scope, kinds: ['command'] }), []);
        // Older decisions have no login: a login-only search is served but flagged; by id nothing is missing.
        assert.deepEqual([protectionSource.plan({ ...scope, actorLogin: 'v' }), protectionSource.gaps!({ ...scope, actorLogin: 'v' })], [['protection'], ['protection']]);
        assert.deepEqual(protectionSource.gaps!({ ...scope, actorID: '7' }), []);
    });
});

describe('usage source', () => {
    const receipt = (extra: Partial<IAiUsageReceipt>): IAiUsageReceipt => ({
        channelID: '100', customerId: 'c1', entryId: 'e1', requestId: null, occurredAt: at, entryKind: 'usage', category: 'tts',
        operation: 'synthesize', source: 'ast', adjustmentType: null, provider: 'fish', model: null, quantity: 49, unit: 'characters',
        credits: 74, resourceType: 'speech', resourceId: 's1', itemized: true, retentionTier: 'pro', expiresAt: now, ...extra
    });
    it('maps voice, AI and credit receipts', () => {
        const voice = usageItem(receipt({ actorId: '7', actorLogin: 'Viewer', actorName: 'Viewer', costUsd: 0.0007, voice: 'v1' }));
        assert.deepEqual([voice.id, voice.kind, voice.name, voice.credits, voice.providerUSD, voice.text], ['usage:e1', 'voice', 'fish', 74, 0.0007, null]);
        assert.deepEqual(voice.data, { provider: 'fish', chars: 49, source: 'ast', voice: 'v1' });
        assert.deepEqual(voice.actor, { id: '7', login: 'viewer', name: 'Viewer' });
        const ai = usageItem(receipt({ category: 'ai_chat', operation: 'final_response', source: 'pet', provider: 'openrouter', model: 'deepseek/x', quantity: 6931, unit: 'tokens' }));
        assert.deepEqual([ai.kind, ai.name, ai.providerUSD, ai.actor], ['ai', 'final_response', null, null]);
        assert.deepEqual(ai.data, { category: 'ai_chat', operation: 'final_response', provider: 'openrouter', model: 'deepseek/x', tokens: 6931, source: 'pet' });
        const grant = usageItem(receipt({ entryKind: 'adjustment', category: 'credit_adjustment', operation: 'grant', adjustmentType: 'manual_grant', source: 'admin_credit_grant', credits: -800000 }));
        assert.deepEqual([grant.kind, grant.name, grant.credits], ['credits', 'manual_grant', -800000]);
        assert.deepEqual(grant.data, { adjustmentType: 'manual_grant', source: 'admin_credit_grant' });
    });
    it('leaves chat protection receipts and expired rows out', () => {
        assert.deepEqual(usageFilter(scope, ['ai'], now), { entryKind: 'usage', category: { $ne: 'tts' }, operation: { $ne: 'contextual_moderation' }, expiresAt: { $gt: now } });
        assert.deepEqual(usageFilter(scope, ['voice', 'ai', 'credits'], now), { $nor: [{ operation: 'contextual_moderation' }], expiresAt: { $gt: now } });
        assert.deepEqual(usageFilter({ ...scope, channelID: '1', actorID: '7' }, ['voice', 'credits'], now, ['c1']), {
            $nor: [{ operation: 'contextual_moderation' }, { entryKind: 'usage', category: { $ne: 'tts' }, operation: { $ne: 'contextual_moderation' } }],
            expiresAt: { $gt: now }, channelID: '1', customerId: { $in: ['c1'] }, actorId: { $eq: '7', $type: 'string' }
        });
    });
    it('holds successes only and finds a chatter by login only inside a channel', () => {
        assert.deepEqual(usageSource.plan({ ...scope, outcome: 'problems' }), []);
        assert.deepEqual(usageSource.plan({ ...scope, actorLogin: 'v' }), []);
        assert.deepEqual(usageSource.plan({ ...scope, actorLogin: 'v', channelID: '1', kinds: ['voice', 'command'] }), ['voice']);
        assert.deepEqual(usageSource.gaps!({ ...scope, actorLogin: 'v', kinds: ['voice', 'command'] }), ['voice']);
        assert.deepEqual(usageSource.gaps!({ ...scope, actorLogin: 'v' }), ['voice', 'ai', 'credits']);
        assert.deepEqual(usageSource.gaps!({ ...scope, actorLogin: 'v', channelID: '1' }), []);
        assert.deepEqual(usageSource.gaps!({ ...scope, actorID: '7' }), []);
    });
});

describe('assistant source', () => {
    const turn = (extra: Partial<ISiteAgentTurnLog>): ISiteAgentTurnLog => ({
        _id: 't1', at, endedAt: at, channelId: '100', channelLogin: 'streamer', user: { id: '100', login: 'streamer', name: 'Streamer', role: 'owner' },
        plan: 'pro', level: 'expert', fellBack: false, models: ['anthropic/claude-haiku-5-5'], modelCosts: [], status: 'completed', errorCode: '', lang: 'en',
        pageRoute: '/dashboard', steps: 3, reconciledSteps: [], textCleared: false, message: 'How do I add a timer?', steers: ['make it every 10 minutes'], answer: 'ANSWER-BODY',
        tools: [{ name: 'list_commands', state: 'done', ms: 20, approval: null, args: 'TOOL-ARGS', result: 'TOOL-RESULT' }, { name: 'list_commands', state: 'done', ms: 5, approval: null, args: '', result: '' }],
        units: 2, promptTokens: 1, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0, costUsd: 0.004, unknownCostSteps: 0,
        durationMs: 4200, activeMs: 4000, feedback: null, expiresAt: now, ...extra
    });
    it('maps a turn with the question preview and never the answer, steers or tool data', () => {
        const item = turnItem(turn({}));
        assert.equal(item.text, 'How do I add a timer?');
        assert.equal(/ANSWER|TOOL-|10 minutes/.test(JSON.stringify(item)), false);
        assert.equal(turnItem(turn({ message: 'q'.repeat(400) })).text?.length, 300);
        assert.equal(turnItem(turn({ message: '' })).text, null);
        assert.deepEqual([item.id, item.name, item.outcome, item.providerUSD, item.durationMs, item.credits, item.channel], ['assistant:t1', 'expert', 'ok', 0.004, 4200, null, 'streamer']);
        assert.deepEqual(item.data, { level: 'expert', status: 'completed', steps: 3, tools: 'list_commands', model: 'anthropic/claude-haiku-5-5', units: 2 });
        assert.deepEqual(item.ref, { type: 'assistant_turn', id: 't1' });
    });
    it('marks failures, interruptions and cancellations', () => {
        assert.deepEqual([turnItem(turn({ status: 'failed', errorCode: 'provider_error' })).reason, turnItem(turn({ status: 'interrupted' })).reason], ['provider_error', 'interrupted']);
        assert.equal(turnItem(turn({ status: 'cancelled' })).outcome, 'skipped');
        assert.equal(turnItem(turn({ costUsd: 0, unknownCostSteps: 2 })).providerUSD, null);
        assert.deepEqual(turnFilter({ ...scope, outcome: 'failed', actorID: '5' }), { 'user.id': '5', status: { $in: ['failed', 'interrupted'] } });
        assert.deepEqual(turnFilter({ ...scope, outcome: 'problems' }), { status: { $in: ['failed', 'interrupted'] } }, 'a stopped turn is not a problem');
        assert.deepEqual(assistantSource.plan({ ...scope, actorLogin: 'x' }), []);
        assert.deepEqual(assistantSource.gaps!({ ...scope, actorLogin: 'x' }), ['assistant']);
        assert.deepEqual(assistantSource.gaps!({ ...scope, actorLogin: 'x', channelID: '1' }), []);
    });
});

describe('docs source', () => {
    it('maps an answer: the question clipped, the page without query, no channel or actor', () => {
        const item = docsItem('11111111-2222-3333-4444-555555555555', {
            at: at.toISOString(), lang: 'es', page: 'https://docs.example.test/es/commands/?utm=x#top', question: 'q'.repeat(400),
            duration_ms: '5300', cost_usd: '0.001200', rounds: '2', feedback: 'helpful'
        });
        assert.ok(item);
        assert.equal(item.text?.length, 300);
        assert.deepEqual([item.channelID, item.actor, item.providerUSD, item.durationMs], [null, null, 0.0012, 5300]);
        assert.deepEqual(item.data, { lang: 'es', page: '/es/commands/', feedback: 'helpful', rounds: 2 });
        assert.equal(docsItem('x', { at: 'nope' }), null);
        assert.equal(docsPage('not a url?x=1'), 'not a url');
    });
    it('maps a question that could not be answered as failed, with its reason and no cost', () => {
        const item = docsItem('11111111-2222-3333-4444-555555555556', {
            at: at.toISOString(), failed: 'timeout', lang: 'en', question: 'Why is my timer silent?', duration_ms: '30000', cost_usd: '0.000000', rounds: '0'
        });
        assert.ok(item);
        assert.deepEqual([item.outcome, item.reason, item.providerUSD, item.durationMs, item.text], ['failed', 'timeout', null, 30000, 'Why is my timer silent?']);
        assert.deepEqual([docsItem('x', { at: at.toISOString(), failed: '' })?.outcome], ['ok']);
    });
    it('is read without a channel or a chatter, for problem filters too', () => {
        assert.deepEqual(docsSource.plan(scope), ['docs']);
        assert.deepEqual(docsSource.plan({ ...scope, outcome: 'failed' }), ['docs']);
        assert.deepEqual(docsSource.plan({ ...scope, outcome: 'problems' }), ['docs']);
        for (const extra of [{ channelID: '1' }, { actorID: '1' }, { actorLogin: 'x' }]) assert.deepEqual(docsSource.plan({ ...scope, ...extra }), []);
    });
    it('pages failed questions only for a problem filter, skipping expired ids', async () => {
        const hashes: Record<string, Record<string, string>> = {
            'aaaaaaaa-0000-4000-8000-000000000001': { at: '2026-11-05T10:00:03.000Z', question: 'ok one' },
            'aaaaaaaa-0000-4000-8000-000000000002': { at: '2026-11-05T10:00:02.000Z', question: 'failed one', failed: 'busy' },
            'aaaaaaaa-0000-4000-8000-000000000003': { at: '2026-11-05T10:00:01.000Z', question: 'failed two', failed: 'unavailable' }
        };
        const ids = ['aaaaaaaa-0000-4000-8000-000000000009', ...Object.keys(hashes), 'not-an-id'];
        const redis = {
            lRange: async () => ids,
            multi() {
                const replies: unknown[] = [];
                const chain = {
                    hmGet: (key: string, fields: string[]) => { const hash = hashes[key.split(':').at(-1)!] || {}; replies.push(fields.map(field => hash[field] ?? null)); return chain; },
                    exec: async () => replies
                };
                return chain;
            }
        } as unknown as Parameters<typeof docsPageItems>[0];
        const all = await docsPageItems(redis, from, to, undefined, 10);
        assert.deepEqual(all.map(item => [item.text, item.outcome, item.reason]), [['ok one', 'ok', null], ['failed one', 'failed', 'busy'], ['failed two', 'failed', 'unavailable']]);
        const failedOnly = await docsPageItems(redis, from, to, undefined, 1, true);
        assert.deepEqual(failedOnly.map(item => item.text), ['failed one']);
        const next = await docsPageItems(redis, from, to, localBound('docs', { at: new Date(failedOnly[0].at), id: failedOnly[0].id }), 10, true);
        assert.deepEqual(next.map(item => item.text), ['failed two']);
    });
});
