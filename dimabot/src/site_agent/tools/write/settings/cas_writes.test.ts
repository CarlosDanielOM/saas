import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { chain, fakeRedis, installFakeModel, type Raw } from '../fake_store.testutil.js';
import { applyProposal, fakeEffects, makeCtx, propose, undoChange } from './test_context.test_util.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

/*
 * Compare-and-set inside the database write for chat events, chat moderation and AI Personality.
 * The tools run through the REAL route services on in-memory models that evaluate write filters
 * (and `doc.$where` on save), so an edit that lands between the apply's read and its write wins.
 */

const redis = fakeRedis();
const realPets = await import('../../../../pets/state.js');
const realDragonfly = await import('../../../../utils/databases/dragonfly.database.js');
mock.module('../../effects.js', { namedExports: { describeCommandEffects: fakeEffects } });
mock.module('../../../../handlers/moderation.handler.js', { namedExports: { invalidateModerationSettingsCache: async () => {} } });
mock.module('../../../../pets/state.js', { namedExports: { ...realPets, invalidatePet: async () => {} } });
mock.module('../../../../utils/databases/dragonfly.database.js', { namedExports: { ...realDragonfly, getDragonflyClient: async () => redis } });

const { default: TwitchStreamers } = await import('../../../../classes/twitch_streamers.class.js');
const { default: UsersSchema } = await import('../../../../schemas/users.schema.js');
const { EventSchema } = await import('../../../../schemas/event.schema.js');
const { default: EventsubSchema } = await import('../../../../schemas/eventsub.schema.js');
const { ChannelModerationSettingsSchema } = await import('../../../../schemas/channel_moderation_settings.schema.js');
const { ChannelAIPersonalitySchema } = await import('../../../../schemas/channel_ai_personality.schema.js');
const { PetSettingsSchema } = await import('../../../../schemas/pet_settings.schema.js');

const user = { _id: 'u1', plan_tier: 'free', name: 'chan', accounts: [{ type: 'twitch', id: '100', name: 'chan', actived: true }] };
mock.method(TwitchStreamers, 'getTwitchAccountById', async (id: string) => ({ id, name: 'Chan' }));
mock.method(UsersSchema, 'findOne', () => chain(() => structuredClone(user)));
mock.method(PetSettingsSchema, 'findOne', () => chain(() => null));
const catalog = [{ name: 'Follow', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: 'user' }, plan_tier: 'free', releaseStage: 'stable',
    config: [{ id: 'message', label: { EN: 'Message', ES: 'Mensaje' }, type: 'text', value: 'Thanks $(user)!' }, { id: 'delay', label: { EN: 'Delay', ES: 'Retraso' }, type: 'number', value: 0 }] }];
mock.method(EventSchema, 'find', () => {
    const rows = () => structuredClone(catalog);
    return { lean: async () => rows(), sort: () => ({ lean: async () => rows() }) };
});
const eventsDb = installFakeModel(EventsubSchema);
const moderationDb = installFakeModel(ChannelModerationSettingsSchema, { unique: [['channelID']] });
const personalityDb = installFakeModel(ChannelAIPersonalitySchema);

const { updateChatEvent } = await import('./chat_events.js');
const { updateModerationSettings } = await import('./moderation.js');
const { updateAiPersonality } = await import('./ai_personality.js');
const { ToolConflictError } = await import('../../../types.js');

const only = (db: { store: Map<string, Raw> }): Raw => [...db.store.values()][0];
/** What a save on the page does to the stored document besides its own fields. */
const pageSave = (row: Raw) => { row.updatedAt = new Date(Date.now() + 1000); row.settingsVersion = (row.settingsVersion ?? 0) + 1; };

const caps = { id: 'caps-1', type: 'caps', enabled: true, firstOffense: { action: 'warn', timeoutSeconds: 60 }, secondOffense: { action: 'delete', timeoutSeconds: 60 },
    thirdOffense: { action: 'timeout', timeoutSeconds: 60 }, reason: 'Too many caps', exemptUserLevel: 7, exemptExpression: null, capsThresholdMode: 'count', minCapsCount: 8,
    maxCapsPercentage: 70, minMessageLength: 10, allowlistDomains: [], maxEmoteCount: 10, terms: [], patterns: [], variations: { mode: 'off', allowSpaces: false, entries: [], overrides: [] } };
const learning = { enabled: true, postStreamSummaryEnabled: true, autoConfirmEnabled: true, autoConfirmThreshold: 0.9, minMessageLength: 10, maxPendingMemories: 100, maxConfirmedMemories: 1000,
    weeklyMaintenanceEnabled: true, monthlyMaintenanceEnabled: true, autoApplyCreates: true, autoApplyEdits: true, autoApplyArchives: true, autoApplyPermanentDeletes: true,
    summaryMinDurationMinutes: 10, summaryMinChatMessages: 10, createMinConfidence: 0.8, editMinConfidence: 0.8, archiveMinConfidence: 0.8, deleteMinConfidence: 0.9,
    maxActionsPerRun: 10, maxDeletesPerRun: 2, minMemoryAgeDaysForDelete: 30, minUnusedDaysForDelete: 30 };

beforeEach(() => {
    eventsDb.store.clear(); moderationDb.store.clear(); personalityDb.store.clear(); redis.reset();
    eventsDb.seed({ id: 'twitch-sub-1', channelID: '100', channel: 'chan', type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '100' }, enabled: true, message: 'Thanks $(user)!', delay: 0 });
    moderationDb.seed({ channelID: '100', channel: 'Chan', enabled: true, offenseWindowSeconds: 3600, rules: [structuredClone(caps)], settingsVersion: 3, updatedAt: new Date('2026-11-01T00:00:00Z') });
    personalityDb.seed({ channelID: '100', channel: 'chan', enabled: true, streamSummariesEnabled: true, personality: 'Friendly bot', rules: ['Be nice'], knownUsers: [],
        profiles: [{ profileID: 'p1', name: 'Main', personality: 'Friendly bot', personaMode: 'original', personaReference: '', tonePreset: 'balanced', voiceProfile: { tone: 't', cadence: 'c', style: 's', catchphrases: [] } }],
        activeProfileId: 'p1', learningConfig: learning, memoryPolicy: { prioritizeRecentChat: true, allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: true },
        updatedAt: new Date('2026-11-01T00:00:00Z'), __v: 0 });
});

test('update_chat_event: an edit between the read and the write wins; fields it does not change are kept', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateChatEvent, { type: 'channel.follow', fields: { message: 'Welcome $(user)!' } }, ctx);
    eventsDb.beforeNextWrite(() => { only(eventsDb).message = 'Edited on the page'; });
    await assert.rejects(applyProposal(updateChatEvent, proposal, ctx), ToolConflictError);
    assert.equal(only(eventsDb).message, 'Edited on the page', 'the concurrent edit survives');

    only(eventsDb).message = 'Thanks $(user)!';
    eventsDb.beforeNextWrite(() => { only(eventsDb).delay = 30; }); // a field the proposal does not touch
    const { change } = await applyProposal(updateChatEvent, proposal, ctx);
    assert.equal(only(eventsDb).message, 'Welcome $(user)!');
    assert.equal(only(eventsDb).delay, 30);

    eventsDb.beforeNextWrite(() => { only(eventsDb).message = 'Edited again'; });
    await assert.rejects(undoChange(updateChatEvent, change!, ctx), ToolConflictError);
    assert.equal(only(eventsDb).message, 'Edited again');
    only(eventsDb).message = 'Welcome $(user)!';
    await undoChange(updateChatEvent, change!, ctx);
    assert.equal(only(eventsDb).message, 'Thanks $(user)!');
});

test('update_moderation_settings: the full save only lands on the revision it was built from', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateModerationSettings, { updateRules: [{ id: 'caps-1', minCaps: 12 }] }, ctx);
    moderationDb.beforeNextWrite(() => { const row = only(moderationDb); row.rules.push({ ...structuredClone(caps), id: 'caps-2' }); pageSave(row); });
    await assert.rejects(applyProposal(updateModerationSettings, proposal, ctx), ToolConflictError);
    assert.deepEqual(only(moderationDb).rules.map((rule: Raw) => rule.id), ['caps-1', 'caps-2'], 'the rule added meanwhile survives');
    assert.equal(only(moderationDb).rules[0].minCapsCount, 8, 'nothing of the proposal was written');

    const fresh = await propose(updateModerationSettings, { updateRules: [{ id: 'caps-1', minCaps: 12 }] }, ctx);
    const { change } = await applyProposal(updateModerationSettings, fresh, ctx);
    assert.equal(only(moderationDb).rules[0].minCapsCount, 12);
    assert.equal(only(moderationDb).rules.length, 2);
    assert.equal(only(moderationDb).settingsVersion, 5);

    moderationDb.beforeNextWrite(() => { const row = only(moderationDb); row.enabled = false; pageSave(row); });
    await assert.rejects(undoChange(updateModerationSettings, change!, ctx), ToolConflictError);
    assert.equal(only(moderationDb).enabled, false);
    assert.equal(only(moderationDb).rules[0].minCapsCount, 12, 'undo wrote nothing');
});

test('update_moderation_settings creates the settings only if there are still none', async () => {
    const ctx = makeCtx();
    moderationDb.store.clear();
    const proposal = await propose(updateModerationSettings, { addRules: [{ type: 'caps' }] }, ctx);
    moderationDb.beforeNextWrite(() => { moderationDb.seed({ channelID: '100', channel: 'Chan', enabled: true, rules: [structuredClone(caps)], settingsVersion: 1, updatedAt: new Date() }); }, (op) => op === 'create');
    await assert.rejects(applyProposal(updateModerationSettings, proposal, ctx), ToolConflictError);
    assert.equal(moderationDb.store.size, 1);
    assert.deepEqual(only(moderationDb).rules.map((rule: Raw) => rule.id), ['caps-1']);
});

test('update_ai_personality: the save only lands if nothing was saved since the read', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateAiPersonality, { aiChatEnabled: false }, ctx);
    personalityDb.beforeNextWrite(() => { const row = only(personalityDb); row.rules = ['Be nice', 'No spoilers']; row.updatedAt = new Date('2026-11-02T00:00:00Z'); row.__v = 1; });
    await assert.rejects(applyProposal(updateAiPersonality, proposal, ctx), ToolConflictError);
    assert.deepEqual(only(personalityDb).rules, ['Be nice', 'No spoilers'], 'the concurrent edit survives');
    assert.equal(only(personalityDb).enabled, true, 'nothing of the proposal was written');

    // Fields edited before the apply's read (not in the proposal) are kept: the body only carries what changes.
    const { change } = await applyProposal(updateAiPersonality, proposal, ctx);
    assert.equal(only(personalityDb).enabled, false);
    assert.deepEqual(only(personalityDb).rules, ['Be nice', 'No spoilers']);

    personalityDb.beforeNextWrite(() => { const row = only(personalityDb); row.streamSummariesEnabled = false; row.updatedAt = new Date(Date.now() + 5000); });
    await assert.rejects(undoChange(updateAiPersonality, change!, ctx), ToolConflictError);
    assert.equal(only(personalityDb).enabled, false, 'undo wrote nothing');
    assert.equal(only(personalityDb).streamSummariesEnabled, false);
});
