import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

let aiCalls = 0, memoryCalls = 0, saveCalls = 0, emailCalls = 0;
let send: () => Promise<unknown> = async () => ({ error: false });
const noop = async () => {};
const personality = { findOne: () => ({ select: () => ({ lean: async () => ({ learningConfig: { enabled: true }, streamSummariesEnabled: true, language: 'en' }) }) }) };
const context = {
    session: { id: 'session', streamID: 'stream', durationMinutes: 60, startedAt: new Date('2026-01-01T00:00:00Z'), endedAt: new Date(), averageViewers: 3, peakViewers: 5, follows: 1, subs: 0, bits: 0, donations: 0 },
    chatMessages: Array.from({ length: 40 }, () => ({})), snapshots: [], existingMemories: []
};
const modules: [string, Record<string, unknown>, unknown?][] = [
    ['../../../schemas/channel_ai_personality.schema.js', { ChannelAIPersonalitySchema: personality }],
    ['../../../schemas/channel_ai_memory.schema.js', { ChannelAIMemorySchema: {} }],
    ['../../../schemas/channel_stream_summary.schema.js', { ChannelStreamSummarySchema: { findOneAndUpdate: async () => { saveCalls++; return { _id: 'summary' }; } } }],
    ['../../../schemas/users.schema.js', {}, { findOne: () => ({ lean: async () => ({ email: 'test@example.invalid', language: 'en', accounts: [{ type: 'twitch', id: 'channel', actived: true }] }) }) }],
    ['../../../classes/twitch_streamers.class.js', {}, { getTwitchAccountById: async () => ({ name: 'example', plan_tier: 'free' }) }],
    ['./stream_summary_context.js', { buildStreamSummaryContext: async () => ({ error: false, context }) }],
    ['./stream_summary_decider.js', { generateStreamSummaryDecision: async () => { aiCalls++; return { error: false, output: { summary: { headline: 'headline', recap: 'recap', highlights: [] }, actions: [{ action: 'create', confidence: 0.99, content: 'memory', summary: 'memory' }] } }; } }],
    ['../constants.js', { getBackgroundSummaryModel: () => 'test-model' }],
    ['./memory.service.js', { createOrUpdateChannelMemory: async () => { memoryCalls++; return { error: false, memory: { _id: 'memory' } }; }, deleteChannelMemoryPermanently: noop, setChannelMemoryStatus: noop, updateChannelMemory: noop }],
    ['../../observability/bot_runtime_metrics.js', { recordStreamMemoryActionMetric: noop }],
    ['../../email/email.service.js', { sendEmail: async () => { emailCalls++; return send(); }, DASHBOARD_URL: 'https://example.invalid' }],
    ['../../email/templates/stream-summary.js', { StreamSummaryEmail: () => ({}), getStreamSummaryEmailSubject: () => 'subject' }],
    ['../../logger.js', { info: noop, error: noop, warn: noop, debug: noop }]
];
for (const [specifier, namedExports, defaultExport] of modules) {
    mock.module(specifier, { namedExports, ...(defaultExport ? { defaultExport } : {}) });
}
const { runStreamMemoryWorkflow } = await import('./stream_memory_runner.js');
const input = { channelID: 'channel', sessionID: 'session', streamID: 'stream', source: 'stream_offline' as const };
function reset() { aiCalls = memoryCalls = saveCalls = emailCalls = 0; send = async () => ({ error: false }); }

for (const [name, failureAt, expected] of [
    ['before AI', 1, [0, 0, 0, 0]],
    ['before memory actions', 2, [1, 0, 0, 0]],
    ['inside the memory action loop', 3, [1, 0, 0, 0]],
    ['before summary persistence', 4, [1, 1, 0, 0]],
    ['before email preparation', 5, [1, 1, 1, 0]],
    ['before actual email send', 6, [1, 1, 1, 0]]
] as const) {
    test(`lost ownership ${name} prevents subsequent effects`, async () => {
        reset();
        let checks = 0;
        await assert.rejects(runStreamMemoryWorkflow({ ...input, assertActive: async () => {
            if (++checks === failureAt) throw new Error('lease lost');
        } }), /lease lost/);
        assert.equal(checks, failureAt);
        assert.deepEqual([aiCalls, memoryCalls, saveCalls, emailCalls], expected);
    });
}

test('runner waits for email completion before resolving', async () => {
    reset();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    send = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { error: false }; };
    let settled = false;
    const result = runStreamMemoryWorkflow({ ...input, assertActive: noop }).finally(() => { settled = true; });
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    assert.equal((await result).error, false);
    assert.equal(emailCalls, 1);
});

test('a thrown email error rejects the claimed workflow for uncertain handling', async () => {
    reset();
    send = async () => { throw new Error('email response lost'); };
    await assert.rejects(runStreamMemoryWorkflow({ ...input, assertActive: noop }), /email response lost/);
    assert.equal(emailCalls, 1);
    assert.equal(saveCalls, 1);
});


test('an email provider error result rejects the claimed workflow', async () => {
    reset();
    send = async () => ({ error: true, message: 'provider rejected email' });
    await assert.rejects(runStreamMemoryWorkflow({ ...input, assertActive: noop }), /provider rejected email/);
    assert.equal(emailCalls, 1);
    assert.equal(saveCalls, 1);
});
