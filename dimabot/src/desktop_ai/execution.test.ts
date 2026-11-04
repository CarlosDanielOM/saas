import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
let claim = false, preparing = false, synthCalls = 0, petCalls = 0, billingCalls = 0;
let provider: (input: any) => Promise<any> = async () => ({ error: true });
let storedTurn: any = null; const matching: any[] = [];
let admitted: any;
const model = { exists: async () => true, findById: () => ({ lean: async () => structuredClone(storedTurn) }),
    updateOne: async () => ({ modifiedCount: 1 }), findOneAndUpdate: () => ({ lean: async () => null }) };
const modules: [string, Record<string, unknown>, unknown?][] = [
    ['./schema.js', { DesktopAiTurn: model }],
    ['./service.js', { assertRunning: async () => {}, armBotSpeechExpiry: () => {}, clearBotSpeechExpiry: () => {}, claimSpeechPreparing: async () => claim,
        speechStillPreparing: async () => preparing, hashTicket: () => '', newTicket: () => '', ticketKey: () => '', tickets: async () => ({}),
        operation: async (_id: string, _operation: string, _kind: string, task: () => Promise<unknown>) => task() }],
    ['../schemas/users.schema.js', {}, {}],
    ['../schemas/oauth_session.schema.js', { OAuthSession: {} }],
    ['../server/services/pet_settings.service.js', { getPetConfiguration: async () => ({}) }],
    ['../schemas/channel_tts_settings.schema.js', { getChannelTtsSettings: async () => ({ enabled: true, provider: 'piper', defaultLanguage: 'en',
        voices: { en: 'voice', es: 'voice' } }) }],
    ['../utils/ai/openrouter/ai.js', { chat: async () => ({}), getChannelPersonality: async () => null }],
    ['../classes/chat_history.js', {}, {}],
    ['../utils/ai/threading/thread_limits.js', { getThreadLimitsForTier: () => ({ promptTurns: 2 }) }],
    ['../utils/permissions/index.js', { createBroadcasterIdentity: () => ({}), serializeUserIdentity: () => ({}) }],
    ['../pets/admission.js', { admitPetAction: async (input: any) => { petCalls++; admitted = input; return { requestId: 'pet', status: 'queued' }; } }],
    ['../pets/speech_text.js', { filterPetTalkText: () => ({}) }],
    ['../utils/tts/emote_names.util.js', { getTtsEmoteNames: async () => [] }],
    ['../utils/databases/dragonfly.database.js', { getDragonflyClient: async () => ({}) }],
    ['../utils/billing.js', { getAiCredits: async () => ({ status: 'available' }), isAiCreditsExhausted: async () => false }],
    ['../utils/tts/tts_credit_fallback.util.js', { resolveTtsForCreditStatus: (value: unknown) => value }],
    ['../utils/tts_usage.js', { trackTtsUsage: async () => { billingCalls++; return {}; } }],
    ['../server/services/tts/piper_tts.service.js', { piperTtsService: { synthesize: async (input: any) => { synthCalls++; return provider(input); } } }],
    ['../server/services/tts/kokoro_tts.service.js', { kokoroTtsService: {} }],
    ['../server/services/tts/fish_tts.service.js', { fishTtsService: {} }],
    ['../pets/state.js', { PetError: class PetError extends Error { code = 'pet_error'; }, cancelPetRequest: async () => {} }],
    ['./activity.js', { prepareSpeechActivity: async () => null, startSpeechActivity: async () => true,
        finishSpeechActivity: async () => {}, finishMatchingSpeechActivity: async (...args: unknown[]) => { matching.push(args); } }]
];
for (const [specifier, exports, defaultExport] of modules) mock.module(specifier, { namedExports: exports, ...(defaultExport ? { defaultExport } : {}) });
const { speakPet, speakBot, cancelPendingSpeech, finishBotSpeech } = await import('./execution.js');
const turn: any = { _id: 'turn-1', channelId: '100', ownerId: 'owner', sessionId: 'session', replyText: 'Hello',
    createdAt: new Date(), speech: { playbackId: 'playback-1', outputGeneration: 1, animatePet: false } };
const streamer = { user_id: '100', name: 'Owner', plan_tier: 'free' as const };

test('a lost atomic speech claim prevents both Pet admission and Bot synthesis', async () => {
    claim = false; preparing = true; petCalls = synthCalls = 0;
    await speakPet(turn, 'Owner'); await speakBot(turn, streamer, new AbortController().signal);
    assert.equal(petCalls, 0); assert.equal(synthCalls, 0);
});
test('persisted cancellation after claim fences both Pet admission and Bot synthesis', async () => {
    claim = true; preparing = false; petCalls = synthCalls = 0;
    await speakPet(turn, 'Owner'); await speakBot(turn, streamer, new AbortController().signal);
    assert.equal(petCalls, 0); assert.equal(synthCalls, 0);
});
test('desktop admission preserves raw generated cues separately from filtered speech', async () => {
    claim = preparing = true; admitted = undefined;
    await speakPet({ ...turn, replyText: 'Hello', moodText: '[happy] Hello' }, 'Owner');
    assert.equal(admitted.text, 'Hello'); assert.equal(admitted.moodText, '[happy] Hello');
});
test('a paid successful Bot provider result is billed even when speech is cancelled while it resolves', async () => {
    claim = preparing = true; synthCalls = billingCalls = 0;
    provider = async input => { cancelPendingSpeech(turn._id); return { error: false, outputPath: input.outputPath, mimeType: 'audio/wav' }; };
    await speakBot(turn, streamer, new AbortController().signal);
    assert.equal(synthCalls, 1); assert.equal(billingCalls, 1);
});
test('restart cancellation releases only the matching persisted output activity', async () => {
    storedTurn = turn; matching.length = 0;
    await finishBotSpeech(turn._id, 'cancelled');
    assert.deepEqual(matching, [['100', 'playback-1', 1, 'cancelled']]);
    storedTurn = { ...turn, speech: { ...turn.speech, animatePet: true } }; matching.length = 0;
    await finishBotSpeech(turn._id, 'cancelled'); assert.equal(matching.length, 0);
});
