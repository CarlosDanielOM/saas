/**
 * Pins PUT /ai-personality/:channelID (ai_personality.service.ts extraction keeps it identical).
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { fakeAuthMiddleware, startRouter } from './route_harness.test_util.js';

process.env.SECRET_KEY ??= 'route-test-secret';

const access = { allowed: true as boolean, permissions: [] as unknown[] };
const deleted: string[] = [];
const petInvalidations: string[] = [];
const realAdmin = await import('../../middleware/admin.middleware.js');
const realPets = await import('../../pets/state.js');
const realDragonfly = await import('../../utils/databases/dragonfly.database.js');
mock.module('../../middleware/auth.middleware.js', { namedExports: { authMiddleware: fakeAuthMiddleware } });
mock.module('../../middleware/admin.middleware.js', {
    namedExports: { ...realAdmin, getChannelAccessContext: async (_r: string, _c: string, permission: unknown) => { access.permissions.push(permission); return { allowed: access.allowed, role: 'owner' }; } }
});
mock.module('../../pets/state.js', { namedExports: { ...realPets, invalidatePet: async (id: string) => { petInvalidations.push(id); } } });
mock.module('../../utils/databases/dragonfly.database.js', {
    namedExports: { ...realDragonfly, getDragonflyClient: async () => ({ del: async (key: string) => { deleted.push(key); return 1; } }) }
});

const { ChannelAIPersonalitySchema } = await import('../../schemas/channel_ai_personality.schema.js');
const { PetSettingsSchema } = await import('../../schemas/pet_settings.schema.js');
const { default: UsersSchema } = await import('../../schemas/users.schema.js');
const { aiPersonalityRoute } = await import('../routes/aiPersonality.route.js');

class FakeDoc {
    [key: string]: any;
    constructor(data: Record<string, unknown>) { Object.assign(this, structuredClone(data)); }
    async save() { state.saved = this.toObject(); state.saves++; }
    toObject() { const { save: _s, toObject: _t, ...rest } = this as any; return structuredClone(rest); }
}
const baseLearning = { enabled: true, autoConfirmEnabled: true, autoConfirmThreshold: 0.9, minMessageLength: 10, maxPendingMemories: 100, maxConfirmedMemories: 1000,
    postStreamSummaryEnabled: true, weeklyMaintenanceEnabled: true, monthlyMaintenanceEnabled: true, autoApplyCreates: true, autoApplyEdits: true, autoApplyArchives: true,
    autoApplyPermanentDeletes: true, summaryMinDurationMinutes: 10, summaryMinChatMessages: 10, createMinConfidence: 0.8, editMinConfidence: 0.8, archiveMinConfidence: 0.8,
    deleteMinConfidence: 0.9, maxActionsPerRun: 10, maxDeletesPerRun: 2, minMemoryAgeDaysForDelete: 30, minUnusedDaysForDelete: 30 };
const stored = () => ({ channelID: '1', channel: 'chan', enabled: true, personality: 'Old', rules: ['Be nice'], knownUsers: [], profiles: [{ profileID: 'p1', name: 'Main', personality: 'Old' }],
    activeProfileId: 'p1', learningConfig: baseLearning, memoryPolicy: { prioritizeRecentChat: true, allowSensitiveMemories: false, allowUserPreferenceMemories: true, allowRunningJokes: true } });
const state: { saved: any; saves: number; current: any; user: any; pet: any; created: any[] } = { saved: null, saves: 0, current: null, user: null, pet: null, created: [] };

mock.method(UsersSchema, 'findOne', async () => state.user);
mock.method(PetSettingsSchema, 'findOne', () => ({ lean: async () => state.pet }));
mock.method(ChannelAIPersonalitySchema, 'findOne', async () => state.saved ? new FakeDoc(state.saved) : state.current ? new FakeDoc(state.current) : null);
mock.method(ChannelAIPersonalitySchema, 'create', async (data: Record<string, unknown>) => { state.created.push(data); state.current = data; return new FakeDoc(data); });

const harness = await startRouter('/ai-personality', aiPersonalityRoute);
after(() => harness.close());
beforeEach(() => {
    harness.user = { id: '1', login: 'chan', display_name: 'Chan' };
    access.allowed = true; access.permissions = []; deleted.length = 0; petInvalidations.length = 0;
    state.saved = null; state.saves = 0; state.current = stored(); state.pet = null; state.created = [];
    state.user = { _id: 'u1', plan_tier: 'premium', name: 'chan', accounts: [{ type: 'twitch', id: '1', name: 'chan' }] };
});

test('PUT checks ai:manage and 404s a missing channel', async () => {
    access.allowed = false;
    let res = await harness.request('PUT', '/1', { enabled: false });
    assert.deepEqual(res, { status: 403, body: { error: true, message: 'You do not have access to this channel', status: 403 } });
    assert.deepEqual(access.permissions, ['ai:manage']);
    access.allowed = true; state.user = null;
    res = await harness.request('PUT', '/1', { enabled: false });
    assert.deepEqual(res, { status: 404, body: { error: true, message: 'Channel not found', status: 404 } });
});

test('PUT sanitizes the given fields only, sets the plan context window and clears the cache', async () => {
    const res = await harness.request('PUT', '/1', {
        enabled: false, rules: ['  Keep it PG ', '', 'No spoilers'], language: 'fr',
        knownUsers: [{ username: ' mod1 ', relationship: 'mod', description: 'Helps' }, { username: '' }],
        memoryPolicy: { allowSensitiveMemories: true }, learningConfig: { autoConfirmThreshold: 5, maxDeletesPerRun: -3 }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, false);
    const saved = state.saved;
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.rules, ['Keep it PG', 'No spoilers']);
    assert.equal(saved.language, null);
    assert.equal(saved.knownUsers.length, 1);
    assert.equal(saved.knownUsers[0].username, 'mod1');
    assert.equal(saved.memoryPolicy.allowSensitiveMemories, true);
    assert.equal(saved.memoryPolicy.allowRunningJokes, true);
    assert.equal(saved.learningConfig.autoConfirmThreshold, 1);
    assert.equal(saved.learningConfig.maxDeletesPerRun, 0);
    assert.equal(saved.personality, 'Old');
    assert.equal(saved.contextWindow, 15);
    assert.deepEqual(res.body.data.tier.limits, { profiles: 2, rules: 5, knownUsers: 10, contextWindow: 15 });
    assert.deepEqual(deleted, ['twitch:1:chatbot:personality']);
    assert.deepEqual(petInvalidations, []);
});

test('PUT creates the default personality on first save and invalidates a linked pet when its persona changes', async () => {
    state.current = null;
    let res = await harness.request('PUT', '/1', { streamSummariesEnabled: false });
    assert.equal(res.status, 200);
    assert.equal(state.created.length, 1);
    assert.equal(state.created[0].channel, 'chan');
    assert.equal(state.saved.streamSummariesEnabled, false);

    state.saved = null; state.current = stored();
    state.pet = { settings: { personality: { source: 'profile', profileId: 'p1' } } };
    res = await harness.request('PUT', '/1', { profiles: [{ profileID: 'p1', name: 'Main', personality: 'New text' }] });
    assert.equal(res.status, 200);
    assert.equal(state.saved.profiles[0].personality, 'New text');
    assert.deepEqual(petInvalidations, ['u1']);
});
