import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { applyProposal, fakeEffects, makeCtx, propose, undoChange } from './test_context.test_util.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const invalidated: string[] = [];
mock.module('../../effects.js', { namedExports: { describeCommandEffects: fakeEffects } });
mock.module('../../../../handlers/moderation.handler.js', { namedExports: { invalidateModerationSettingsCache: async (id: string) => { invalidated.push(id); } } });

const { default: TwitchStreamers } = await import('../../../../classes/twitch_streamers.class.js');
const { ChannelModerationSettingsSchema } = await import('../../../../schemas/channel_moderation_settings.schema.js');
const { default: Users } = await import('../../../../schemas/users.schema.js');
const db: { doc: any; plan: string; writes: number } = { doc: null, plan: 'free', writes: 0 };
mock.method(TwitchStreamers, 'getTwitchAccountById', async (id: string) => ({ id, name: 'Chan' }));
mock.method(Users, 'findOne', () => ({ select: () => ({ lean: async () => ({ plan_tier: db.plan }) }) }));
mock.method(ChannelModerationSettingsSchema, 'findOne', () => ({ lean: async () => structuredClone(db.doc) }));
mock.method(ChannelModerationSettingsSchema, 'findOneAndUpdate', async (_filter: any, update: any) => {
    db.writes++;
    db.doc = { _id: 'm1', channelID: '100', ...(db.doc ?? {}), ...structuredClone(update.$set), settingsVersion: (db.doc?.settingsVersion ?? 0) + 1 };
    return { toObject: () => structuredClone(db.doc) };
});

const { updateModerationSettings } = await import('./moderation.js');
const { ToolConflictError, ToolInputError } = await import('../../../types.js');

const caps = { id: 'caps-1', type: 'caps', enabled: true, firstOffense: { action: 'warn', timeoutSeconds: 60 }, secondOffense: { action: 'delete', timeoutSeconds: 60 },
    thirdOffense: { action: 'timeout', timeoutSeconds: 60 }, reason: 'Too many caps', exemptUserLevel: 7, exemptExpression: null, capsThresholdMode: 'count', minCapsCount: 8,
    maxCapsPercentage: 70, minMessageLength: 10, allowlistDomains: [], maxEmoteCount: 10, terms: [], patterns: [], variations: { mode: 'off', allowSpaces: false, entries: [], overrides: [] } };

beforeEach(() => {
    db.doc = { _id: 'm1', channelID: '100', channel: 'Chan', enabled: true, offenseWindowSeconds: 3600, rules: [structuredClone(caps)], settingsVersion: 3 };
    db.plan = 'free'; db.writes = 0; invalidated.length = 0;
});

test('validate: rule shapes, step timeouts and at least one change', () => {
    assert.throws(() => updateModerationSettings.validate({}), /at least one/);
    assert.throws(() => updateModerationSettings.validate({ addRules: [{ enabled: true }] }), /type is required/);
    assert.throws(() => updateModerationSettings.validate({ updateRules: [{ id: 'caps-1', type: 'links' }] }), /cannot change/);
    assert.throws(() => updateModerationSettings.validate({ addRules: [{ type: 'caps', firstTime: { action: 'timeout' } }] }), /timeoutSeconds is required/);
    assert.throws(() => updateModerationSettings.validate({ protection: { categories: ['memes'] } }), ToolInputError);
    assert.throws(() => updateModerationSettings.validate({ updateRules: [{ id: 'a', enabled: false }], removeRuleIds: ['a'] }), /once per change/);
});

test('adding a rule: proposal with timeout/ban effects, no write before apply, save + cache invalidation after', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateModerationSettings, { addRules: [{ type: 'blacklist', terms: ['scam'], everyTimeAfter: { action: 'ban' } }], forgetWarningsAfterMinutes: 30 }, ctx);
    assert.equal(db.writes, 0);
    assert.deepEqual(proposal.permissions, ['moderation:manage']);
    assert.ok(proposal.effects.some((effect) => /time out/.test(effect)));
    assert.ok(proposal.effects.some((effect) => /ban viewers/.test(effect)));
    const added = Object.entries(proposal.after!).find(([key]) => key.startsWith('Rule Blocked words'))!;
    assert.equal(proposal.before![added[0]], null);
    assert.deepEqual((added[1] as any).terms, ['scam']);
    assert.equal(proposal.after!['Forget warnings after (seconds)'], 1800);
    const { change } = await applyProposal(updateModerationSettings, proposal, ctx);
    assert.equal(db.writes, 1);
    assert.deepEqual(invalidated, ['100']);
    assert.equal(db.doc.rules.length, 2);
    assert.equal(db.doc.rules[1].thirdOffense.action, 'ban');
    assert.equal(db.doc.offenseWindowSeconds, 1800);
    // Applying the same approval twice is refused instead of adding a duplicate.
    await assert.rejects(applyProposal(updateModerationSettings, proposal, ctx), ToolConflictError);
    await undoChange(updateModerationSettings, change!, ctx);
    assert.deepEqual(db.doc.rules.map((rule: any) => rule.id), ['caps-1']);
    assert.equal(db.doc.offenseWindowSeconds, 3600);
});

test('updating a rule keeps its other fields; a concurrent edit makes apply and undo fail with a plain message', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateModerationSettings, { updateRules: [{ id: 'caps-1', minCaps: 12 }] }, ctx);
    assert.equal((proposal.before!['Rule Caps (caps-1)'] as any).minCaps, 8);
    assert.equal((proposal.after!['Rule Caps (caps-1)'] as any).minCaps, 12);
    db.doc.rules[0].reason = 'Edited on the page';
    await assert.rejects(applyProposal(updateModerationSettings, proposal, ctx), (error: Error) => error instanceof ToolConflictError && /caps-1 changed/.test(error.message));
    db.doc.rules[0].reason = 'Too many caps';
    const { change } = await applyProposal(updateModerationSettings, proposal, ctx);
    assert.equal(db.doc.rules[0].minCapsCount, 12);
    assert.equal(db.doc.rules[0].reason, 'Too many caps');
    assert.equal(db.doc.rules[0].secondOffense.action, 'delete');
    db.doc.rules[0].minCapsCount = 15;
    await assert.rejects(undoChange(updateModerationSettings, change!, ctx), /edited after this change/);
    db.doc.rules[0].minCapsCount = 12;
    await undoChange(updateModerationSettings, change!, ctx);
    assert.equal(db.doc.rules[0].minCapsCount, 8);
});

test('removing a rule and undo; unknown rule ids and paid options on Free are rejected at proposal time', async () => {
    const ctx = makeCtx();
    await assert.rejects(updateModerationSettings.run(updateModerationSettings.validate({ removeRuleIds: ['nope'] }), ctx), /No moderation rule/);
    await assert.rejects(updateModerationSettings.run(updateModerationSettings.validate({ protection: { confidencePercent: 90 } }), ctx), /requires Premium or Pro/);
    db.plan = 'premium';
    const paid = await propose(updateModerationSettings, { protection: { confidencePercent: 90 } }, ctx);
    assert.equal(paid.after!['Ban confidence (%)'], 90);
    const proposal = await propose(updateModerationSettings, { removeRuleIds: ['caps-1'] }, ctx);
    assert.equal(proposal.after!['Rule Caps (caps-1)'], null);
    const { change } = await applyProposal(updateModerationSettings, proposal, ctx);
    assert.equal(db.doc.rules.length, 0);
    await undoChange(updateModerationSettings, change!, ctx);
    assert.deepEqual(db.doc.rules.map((rule: any) => [rule.id, rule.reason]), [['caps-1', 'Too many caps']]);
});
