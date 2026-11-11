import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { chain, fakeRedis, installFakeModel, type Raw } from '../fake_store.testutil.js';
import { applyProposal, fakeEffects, makeCtx, propose, undoChange } from './test_context.test_util.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

/*
 * The tools run through the REAL route services (tts_settings / follow_defense_settings) on an
 * in-memory model that evaluates write filters, so these tests show the compare-and-set happens
 * inside the database write: an edit that lands between the apply's read and its write wins.
 */

const redis = fakeRedis();
const cancelled: string[] = [];
const realFavorites = await import('../../../../schemas/channel_fish_voice_favorites.schema.js');
const realCatalog = await import('../../../../server/services/tts/fish_voice_catalog.service.js');
const realActions = await import('../../../../utils/follow_defense_actions.js');
const realDragonfly = await import('../../../../utils/databases/dragonfly.database.js');
mock.module('../../effects.js', { namedExports: { describeCommandEffects: fakeEffects } });
mock.module('../../../../schemas/channel_fish_voice_favorites.schema.js', {
    namedExports: { ...realFavorites, getFishVoiceFavorites: async () => [{ id: 'b'.repeat(32), name: 'Pinky Pie', alias: 'pinky_pie' }] }
});
// No Fish API calls: any 32-hex id "exists".
mock.module('../../../../server/services/tts/fish_voice_catalog.service.js', {
    namedExports: { ...realCatalog, getFishVoice: async (id: string) => ({ id, name: 'Voice' }) }
});
mock.module('../../../../utils/follow_defense_actions.js', { namedExports: { ...realActions, cancelFollowDefenseActions: async (id: string) => { cancelled.push(id); return 0; } } });
mock.module('../../../../utils/databases/dragonfly.database.js', { namedExports: { ...realDragonfly, getDragonflyClient: async () => redis } });

const { default: TwitchStreamers } = await import('../../../../classes/twitch_streamers.class.js');
const { default: UsersSchema } = await import('../../../../schemas/users.schema.js');
const { ChannelTtsSettingsSchema, createDefaultChannelTtsSettings } = await import('../../../../schemas/channel_tts_settings.schema.js');
const { FollowDefenseSettingsSchema } = await import('../../../../schemas/follow_defense_settings.schema.js');
const { DEFAULT_SETTINGS } = await import('../../../../server/services/follow_defense_settings.service.js');
mock.method(TwitchStreamers, 'getTwitchAccountById', async (id: string) => ({ id, name: 'Chan' }));
mock.method(UsersSchema, 'findOne', () => chain(() => null));
const ttsDb = installFakeModel(ChannelTtsSettingsSchema, { unique: [['channelID']] });
const followDb = installFakeModel(FollowDefenseSettingsSchema, { unique: [['channelID']] });

const { updateTtsSettings } = await import('./tts.js');
const { updateFollowDefenseSettingsTool } = await import('./follow_defense.js');
const { ToolConflictError, ToolInputError } = await import('../../../types.js');

const ttsRow = (): Raw => [...ttsDb.store.values()][0];
const followRow = (): Raw => [...followDb.store.values()][0];
/** Skips Follow Defense's "create the defaults" upsert, which runs before the guarded write. */
const guardedWrite = (op: string, _filter: Raw, update?: Raw) => op === 'findOneAndUpdate' && !update?.$setOnInsert;

beforeEach(() => {
    ttsDb.store.clear(); followDb.store.clear(); redis.reset(); cancelled.length = 0;
    ttsDb.seed(createDefaultChannelTtsSettings('100', 'Chan'));
});

test('update_tts_settings validates like the page (ranges, voices, tags)', () => {
    assert.throws(() => updateTtsSettings.validate({}), ToolInputError);
    assert.throws(() => updateTtsSettings.validate({ maxLength: 20 }), /at least 30/);
    assert.throws(() => updateTtsSettings.validate({ maxQueue: 21 }), /at most 20/);
    assert.throws(() => updateTtsSettings.validate({ kokoroVoice: 'zz_nope' }), /not a Kokoro voice/);
    assert.throws(() => updateTtsSettings.validate({ voiceTagsOn: ['whisper'], voiceTagsOff: ['whisper'] }), /both on and off/);
    assert.throws(() => updateTtsSettings.validate({ voiceTagsOff: ['not-a-tag'] }), ToolInputError);
    assert.deepEqual(updateTtsSettings.validate({ kokoroVoice: ' AF_HEART ' }).kokoroVoice, 'af_heart');
});

test('update_tts_settings proposes only the changed fields and never writes before approval', async () => {
    const ctx = makeCtx();
    const stored = JSON.stringify(ttsRow());
    const outcome = await updateTtsSettings.run(updateTtsSettings.validate({ enabled: true, maxLength: 400, fishVoice: 'pinky_pie', voiceTagsOff: ['whisper'] }), ctx);
    assert.equal(outcome.type, 'approval');
    const proposal = (outcome as any).proposal;
    assert.deepEqual(proposal.permissions, ['tts:manage']);
    assert.deepEqual(proposal.payload.after, { 'filters.maxLength': 400, 'voices.cloneDefault': 'b'.repeat(32), 'filters.expressiveTags.whisper': false });
    assert.deepEqual(proposal.before, { 'Maximum characters per message': 280, 'Fish Audio voice': 'gojo', 'Voice tag [whisper]': true });
    assert.equal(proposal.after['Fish Audio voice'], 'pinky_pie');
    assert.ok(proposal.warnings.some((w: string) => /Fish Audio/.test(w)));
    assert.equal(JSON.stringify(ttsRow()), stored, 'nothing written before approval');
    const unchanged = await updateTtsSettings.run(updateTtsSettings.validate({ enabled: true }), ctx);
    assert.equal(unchanged.type, 'result');
});

test('update_tts_settings applies onto fresh settings, refuses stale proposals and undoes', async () => {
    const ctx = makeCtx({ lang: 'es' });
    const proposal = await propose(updateTtsSettings, { maxQueue: 9, provider: 'kokoro', fishVoice: 'pinky_pie' }, ctx);
    assert.equal(proposal.title, 'Cambiar la configuración de Texto a voz');
    ttsRow().filters.skipEmotes = false; // someone else changed an unrelated field before the approval
    const { change } = await applyProposal(updateTtsSettings, proposal, ctx);
    assert.equal(ttsRow().queue.maxItems, 9);
    assert.equal(ttsRow().provider, 'kokoro');
    assert.equal(ttsRow().voices.cloneDefault, 'b'.repeat(32));
    assert.equal(ttsRow().filters.skipEmotes, false, 'unrelated concurrent edit survives');

    const stale = await propose(updateTtsSettings, { maxQueue: 3 }, ctx);
    ttsRow().queue.maxItems = 4;
    await assert.rejects(applyProposal(updateTtsSettings, stale, ctx), (error: Error) => error instanceof ToolConflictError && /cambió/.test(error.message));
    assert.equal(ttsRow().queue.maxItems, 4);

    ttsRow().queue.maxItems = 9;
    await undoChange(updateTtsSettings, change!, ctx);
    assert.equal(ttsRow().queue.maxItems, 5);
    assert.equal(ttsRow().provider, 'piper');
    assert.equal(ttsRow().voices.cloneDefault, 'gojo');
    assert.equal(ttsRow().filters.skipEmotes, false, 'undo leaves fields it did not change alone');
    ttsRow().provider = 'fish';
    await assert.rejects(undoChange(updateTtsSettings, change!, ctx), ToolConflictError);
    assert.equal(ttsRow().provider, 'fish');
});

test('update_tts_settings: an edit between the apply\'s read and its write wins (compare-and-set in the write)', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateTtsSettings, { maxQueue: 9, stripLinks: false }, ctx);
    ttsDb.beforeNextWrite(() => { ttsRow().queue.maxItems = 4; });
    await assert.rejects(applyProposal(updateTtsSettings, proposal, ctx), (error: Error) => error instanceof ToolConflictError && /Maximum messages waiting: 4/.test(error.message));
    assert.equal(ttsRow().queue.maxItems, 4, 'the concurrent edit survives');
    assert.equal(ttsRow().filters.stripLinks, true, 'nothing of the proposal was written');
});

test('update_tts_settings never rewrites fields it does not change, even when they are edited in between', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateTtsSettings, { maxLength: 400 }, ctx);
    ttsDb.beforeNextWrite(() => {
        const row = ttsRow();
        row.filters.skipEmotes = false;
        row.voices.cloneDefault = 'toji_fushiguro';
        row.queue.maxItems = 12;
        row.filters.expressiveTags.laugh = false;
    });
    const { change } = await applyProposal(updateTtsSettings, proposal, ctx);
    const row = ttsRow();
    assert.equal(row.filters.maxLength, 400);
    assert.equal(row.filters.skipEmotes, false);
    assert.equal(row.voices.cloneDefault, 'toji_fushiguro');
    assert.equal(row.queue.maxItems, 12);
    assert.equal(row.filters.expressiveTags.laugh, false);

    // Undo too: only the path it changed goes back.
    ttsDb.beforeNextWrite(() => { ttsRow().enabled = false; });
    await undoChange(updateTtsSettings, change!, ctx);
    assert.equal(ttsRow().filters.maxLength, 280);
    assert.equal(ttsRow().enabled, false);
    assert.equal(ttsRow().queue.maxItems, 12);
});

test('update_tts_settings: undo refuses when the value is edited between its read and its write', async () => {
    const ctx = makeCtx();
    const { change } = await applyProposal(updateTtsSettings, await propose(updateTtsSettings, { maxQueue: 9 }, ctx), ctx);
    ttsDb.beforeNextWrite(() => { ttsRow().queue.maxItems = 15; });
    await assert.rejects(undoChange(updateTtsSettings, change!, ctx), ToolConflictError);
    assert.equal(ttsRow().queue.maxItems, 15);
});

test('update_tts_settings creates the settings only if they still do not exist', async () => {
    const ctx = makeCtx();
    ttsDb.store.clear();
    await applyProposal(updateTtsSettings, await propose(updateTtsSettings, { maxQueue: 9 }, ctx), ctx);
    assert.equal(ttsDb.store.size, 1);
    assert.equal(ttsRow().queue.maxItems, 9);
    assert.equal(ttsRow().provider, 'piper');

    ttsDb.store.clear();
    const second = await propose(updateTtsSettings, { maxQueue: 9 }, ctx);
    // The page saves the first settings while the assistant is creating them.
    ttsDb.beforeNextWrite(() => { ttsDb.seed({ ...createDefaultChannelTtsSettings('100', 'Chan'), queue: { maxItems: 7 } }); }, (op) => op === 'create');
    await assert.rejects(applyProposal(updateTtsSettings, second, ctx), ToolConflictError);
    assert.equal(ttsDb.store.size, 1);
    assert.equal(ttsRow().queue.maxItems, 7);
});

test('update_follow_defense_settings: dynamic threshold, ban warning, CAS and undo through the route service', async () => {
    assert.throws(() => updateFollowDefenseSettingsTool.validate({ attackThreshold: 0 }), /at least 1/);
    assert.equal(updateFollowDefenseSettingsTool.validate({ attackThreshold: null }).attackThreshold, null);
    const ctx = makeCtx({ role: 'admin', requester: { id: '7', login: 'mod', displayName: 'Mod' }, granted: ['moderation:manage'] });
    const proposal = await propose(updateFollowDefenseSettingsTool, { attackThreshold: 800, protectionModeEnabled: false }, ctx);
    assert.deepEqual(proposal.permissions, ['moderation:manage']);
    assert.deepEqual(proposal.payload.after, { attackThreshold: 800, protectionModeEnabled: false });
    assert.ok(proposal.warnings!.some((w) => /permanently/.test(w)));
    assert.ok(proposal.warnings!.some((w) => /cancelled/.test(w)));
    assert.equal(followDb.store.size, 0, 'nothing written before approval');

    const { change } = await applyProposal(updateFollowDefenseSettingsTool, proposal, ctx);
    assert.equal(followRow().attackThreshold, 800);
    assert.equal(followRow().protectionModeEnabled, false);
    assert.equal(followRow().silentThresholdX, DEFAULT_SETTINGS.silentThresholdX);
    assert.deepEqual(cancelled, ['100'], 'turning Protection off cancels pending actions like the route');

    followRow().attackThreshold = 900;
    await assert.rejects(undoChange(updateFollowDefenseSettingsTool, change!, ctx), ToolConflictError);
    assert.equal(followRow().attackThreshold, 900);
    followRow().attackThreshold = 800;
    await undoChange(updateFollowDefenseSettingsTool, change!, ctx);
    assert.equal(followRow().attackThreshold, null);
    assert.equal(followRow().protectionModeEnabled, true);
});

test('update_follow_defense_settings: an edit between the read and the write wins, other fields are kept', async () => {
    const ctx = makeCtx();
    const proposal = await propose(updateFollowDefenseSettingsTool, { attackThreshold: 800, silentDurationSeconds: 120 }, ctx);
    followDb.beforeNextWrite(() => { followRow().attackThreshold = 900; }, guardedWrite);
    await assert.rejects(applyProposal(updateFollowDefenseSettingsTool, proposal, ctx),
        (error: Error) => error instanceof ToolConflictError && /Attack threshold \(empty = dynamic\): 900/.test(error.message));
    assert.equal(followRow().attackThreshold, 900, 'the concurrent edit survives');
    assert.equal(followRow().silentDurationSeconds, DEFAULT_SETTINGS.silentDurationSeconds, 'nothing of the proposal was written');

    // Fields the proposal does not change may be edited in between and are kept.
    followRow().attackThreshold = null;
    const again = await propose(updateFollowDefenseSettingsTool, { attackThreshold: 800 }, ctx);
    followDb.beforeNextWrite(() => { followRow().silentThresholdX = 25; }, guardedWrite);
    const { change } = await applyProposal(updateFollowDefenseSettingsTool, again, ctx);
    assert.equal(followRow().attackThreshold, 800);
    assert.equal(followRow().silentThresholdX, 25);

    // Undo: same rule between its read and its write.
    followDb.beforeNextWrite(() => { followRow().attackThreshold = 1000; }, guardedWrite);
    await assert.rejects(undoChange(updateFollowDefenseSettingsTool, change!, ctx), ToolConflictError);
    assert.equal(followRow().attackThreshold, 1000);
});
