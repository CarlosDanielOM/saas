import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { applyProposal, fakeEffects, makeCtx, propose, undoChange } from './test_context.test_util.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const deleted: string[] = [];
const realPets = await import('../../../../pets/state.js');
const realDragonfly = await import('../../../../utils/databases/dragonfly.database.js');
mock.module('../../effects.js', { namedExports: { describeCommandEffects: fakeEffects } });
mock.module('../../../../pets/state.js', { namedExports: { ...realPets, invalidatePet: async () => {} } });
mock.module('../../../../utils/databases/dragonfly.database.js', { namedExports: { ...realDragonfly, getDragonflyClient: async () => ({ del: async (key: string) => { deleted.push(key); return 1; } }) } });

const { ChannelAIPersonalitySchema } = await import('../../../../schemas/channel_ai_personality.schema.js');
const { PetSettingsSchema } = await import('../../../../schemas/pet_settings.schema.js');
const { default: UsersSchema } = await import('../../../../schemas/users.schema.js');

const db: { doc: any } = { doc: null };
class FakeDoc {
    [key: string]: any;
    constructor(data: Record<string, unknown>) { Object.assign(this, structuredClone(data)); }
    async save() { db.doc = this.toObject(); }
    toObject() { const { save: _s, toObject: _t, ...rest } = this as any; return structuredClone(rest); }
}
mock.method(UsersSchema, 'findOne', async () => ({ _id: 'u1', plan_tier: 'free', name: 'chan', accounts: [{ type: 'twitch', id: '100', name: 'chan' }] }));
mock.method(PetSettingsSchema, 'findOne', () => ({ lean: async () => null }));
mock.method(ChannelAIPersonalitySchema, 'findOne', (...args: unknown[]) => {
    const doc = db.doc ? new FakeDoc(db.doc) : null;
    // `.lean()` reads and plain awaits (documents) are both used.
    return Object.assign(Promise.resolve(doc), { lean: async () => db.doc ? structuredClone(db.doc) : null, args });
});
mock.method(ChannelAIPersonalitySchema, 'create', async (data: Record<string, unknown>) => { db.doc = structuredClone(data); return new FakeDoc(data); });

const { updateAiPersonality, toBody } = await import('./ai_personality.js');
const { ToolConflictError, ToolInputError } = await import('../../../types.js');

const learning = { enabled: true, postStreamSummaryEnabled: true, autoConfirmEnabled: true, autoConfirmThreshold: 0.9, minMessageLength: 10, maxPendingMemories: 100, maxConfirmedMemories: 1000,
    weeklyMaintenanceEnabled: true, monthlyMaintenanceEnabled: true, autoApplyCreates: true, autoApplyEdits: true, autoApplyArchives: true, autoApplyPermanentDeletes: true,
    summaryMinDurationMinutes: 10, summaryMinChatMessages: 10, createMinConfidence: 0.8, editMinConfidence: 0.8, archiveMinConfidence: 0.8, deleteMinConfidence: 0.9,
    maxActionsPerRun: 10, maxDeletesPerRun: 2, minMemoryAgeDaysForDelete: 30, minUnusedDaysForDelete: 30 };
beforeEach(() => {
    deleted.length = 0;
    db.doc = { channelID: '100', channel: 'chan', enabled: true, streamSummariesEnabled: true, personality: 'Friendly bot', rules: ['Be nice'],
        knownUsers: [{ username: 'mod1', relationship: 'mod', description: 'Helps', lastInteraction: '2026-01-01T00:00:00.000Z' }],
        profiles: [
            { profileID: 'p1', name: 'Main', personality: 'Friendly bot', personaMode: 'original', personaReference: '', tonePreset: 'balanced', voiceProfile: { tone: 't', cadence: 'c', style: 's', catchphrases: [] } },
            { profileID: 'p2', name: 'Spooky', personality: 'Spooky bot', personaMode: 'inspired', personaReference: '', tonePreset: 'dark_humor', voiceProfile: { tone: 'dark', cadence: 'slow', style: 'eerie', catchphrases: ['boo'] } }
        ],
        activeProfileId: 'p1', learningConfig: learning, memoryPolicy: { prioritizeRecentChat: true, allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: true } };
});

test('toBody mirrors the page: profile edits send the full list plus the active profile as the top-level persona', () => {
    const body = toBody(db.doc, { activeProfileId: 'p2', 'profile:p2:personality': 'Very spooky' });
    assert.equal(body.profiles!.length, 2);
    assert.equal(body.activeProfileId, 'p2');
    assert.equal(body.personality, 'Very spooky');
    assert.equal(body.tonePreset, 'dark_humor');
    assert.deepEqual(body.voiceProfile, db.doc.profiles[1].voiceProfile);
    assert.equal(body.rules, undefined);
    assert.deepEqual(toBody(db.doc, { 'memory:allowSensitiveMemories': true, 'learning:enabled': false }), { memoryPolicy: { allowSensitiveMemories: true }, learningConfig: { enabled: false } });
});

test('plan limits and ids are checked before any proposal', async () => {
    const ctx = makeCtx();
    await assert.rejects(updateAiPersonality.run(updateAiPersonality.validate({ rules: ['a', 'b', 'c', 'd'] }), ctx), /allows 3 rules/);
    await assert.rejects(updateAiPersonality.run(updateAiPersonality.validate({ activeProfileId: 'nope' }), ctx), /No personality/);
    await assert.rejects(updateAiPersonality.run(updateAiPersonality.validate({ addKnownUsers: [{ username: 'a' }, { username: 'b' }, { username: 'c' }] }), ctx), /allows 3 regulars/);
    assert.throws(() => updateAiPersonality.validate({ addKnownUsers: [{ username: 'not a login!' }] }), ToolInputError);
    const premium = await propose(updateAiPersonality, { rules: ['a', 'b', 'c', 'd'] }, makeCtx({ plan: 'premium' }));
    assert.deepEqual(premium.payload.after, { rules: ['a', 'b', 'c', 'd'] });
});

test('edit the active personality text and a regular, apply through the route service, undo', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateAiPersonality, { profile: { personality: 'Chill and kind' }, addKnownUsers: [{ username: '@MOD1', relationship: 'head mod', description: 'Runs giveaways' }], memory: { sensitiveDetails: true } }, ctx);
    assert.deepEqual(proposal.permissions, ['ai:manage']);
    assert.ok(Object.keys(proposal.after!).includes('Personality "Main": how the bot talks'));
    assert.ok(proposal.warnings!.some((w) => /personal details/.test(w)));
    const { change } = await applyProposal(updateAiPersonality, proposal, ctx);
    assert.equal(db.doc.profiles[0].personality, 'Chill and kind');
    assert.equal(db.doc.personality, 'Chill and kind');
    assert.equal(db.doc.profiles[1].personality, 'Spooky bot');
    assert.equal(db.doc.knownUsers[0].relationship, 'head mod');
    assert.equal(db.doc.memoryPolicy.allowSensitiveMemories, true);
    assert.equal(db.doc.memoryPolicy.allowRunningJokes, true);
    assert.equal(db.doc.contextWindow, 7);
    assert.deepEqual(deleted, ['twitch:100:chatbot:personality']);

    db.doc.rules = ['changed elsewhere'];
    await undoChange(updateAiPersonality, change!, ctx); // rules were not part of this change
    assert.equal(db.doc.profiles[0].personality, 'Friendly bot');
    assert.equal(db.doc.knownUsers[0].relationship, 'mod');
    assert.equal(db.doc.memoryPolicy.allowSensitiveMemories, false);
    assert.deepEqual(db.doc.rules, ['changed elsewhere']);
});

test('stale proposals and edited-after changes conflict', async () => {
    const ctx = makeCtx({ lang: 'es' });
    const proposal = await propose(updateAiPersonality, { aiChatEnabled: false }, ctx);
    assert.equal(proposal.title, 'Cambiar la Personalidad de IA');
    db.doc.enabled = false;
    const noop = await updateAiPersonality.run(updateAiPersonality.validate({ aiChatEnabled: false }), ctx);
    assert.equal(noop.type, 'result');
    db.doc.enabled = true;
    const { change } = await applyProposal(updateAiPersonality, proposal, ctx);
    db.doc.enabled = true;
    await assert.rejects(undoChange(updateAiPersonality, change!, ctx), ToolConflictError);
    const stale = await propose(updateAiPersonality, { streamSummariesEnabled: false }, ctx);
    db.doc.streamSummariesEnabled = false;
    await assert.rejects(applyProposal(updateAiPersonality, stale, ctx), (error: Error) => error instanceof ToolConflictError && /Resúmenes de stream/.test(error.message));
});

test('a channel without a saved personality gets its first one created on apply', async () => {
    db.doc = null;
    const ctx = makeCtx();
    const proposal = await propose(updateAiPersonality, { profile: { personality: 'Hello there' } }, ctx);
    await applyProposal(updateAiPersonality, proposal, ctx);
    assert.equal(db.doc.profiles.length, 1);
    assert.equal(db.doc.profiles[0].personality, 'Hello there');
    assert.equal(db.doc.activeProfileId, db.doc.profiles[0].profileID);
    assert.equal(db.doc.personality, 'Hello there');
});
