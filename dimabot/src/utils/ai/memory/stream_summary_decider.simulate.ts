/**
 * Operator-only simulation: run the stream summary decider against REAL
 * OpenRouter for the channel with Twitch ID 533238623.
 *
 * Mocks only the local DB lookups (streamer account, AI personality) since
 * this script has no DB connection. Everything else — including the actual
 * call to OpenRouter, the strict json_schema response, the Zod validation,
 * and the retry+fallback logic — runs for real.
 *
 * Run with: npx tsx src/utils/ai/memory/stream_summary_decider.simulate.ts
 *
 * Requires: OPENROUTER_API_KEY in the environment (.env loaded).
 *
 * Excluded from tsc by being a dot-separated .simulate.ts file
 * (kept in the memory folder, not in tests).
 */
import 'dotenv/config';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const MOCK_TWITCH_ID = '533238623';

// -- Mock the streamer lookup to return a pro user ---------------------------

const mockStreamer = {
    id: MOCK_TWITCH_ID,
    name: 'cdom201',
    login: 'cdom201',
    plan_tier: 'pro',
    polar_sh_customer_id: null
};

const mockPersonality = {
    activeProfileId: 'profile_default',
    personaMode: 'balanced',
    tonePreset: 'friendly',
    personality: 'You are a friendly Twitch chat moderator who knows the regulars by name.',
    profiles: [
        {
            profileID: 'profile_default',
            personaMode: 'balanced',
            tonePreset: 'friendly',
            personality: 'You are a friendly Twitch chat moderator who knows the regulars by name.'
        }
    ]
};

import TwitchStreamers from '../../../classes/twitch_streamers.class.js';
const originalGetTwitchAccountById = (TwitchStreamers as any).getTwitchAccountById;
(TwitchStreamers as any).getTwitchAccountById = async function (_id: string) {
    return mockStreamer;
};

import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
const originalPersonalityFindOne = (ChannelAIPersonalitySchema as any).findOne;
(ChannelAIPersonalitySchema as any).findOne = function () {
    return {
        lean: async () => mockPersonality
    };
};

// PolarSH ingest is skipped automatically because mockStreamer has
// polar_sh_customer_id: null. The decider only calls ingestPolarSHEvent
// when the customer ID is set and cost > 0. No mock needed.

// Logger module is ESM-read-only. We let the real logger run normally —
// its output will appear in the test output and is also captured by the
// real logger pipeline (cache + console) as it would in production.

// -- Build a realistic stream context ---------------------------------------

function buildContext(channelID: string): any {
    return {
        channelID,
        session: {
            id: 'stream_session_abc',
            streamID: 'stream_xyz_123',
            channel: 'cdom201',
            status: 'offline',
            startedAt: '2026-06-07T18:00:00.000Z',
            endedAt: '2026-06-07T22:30:00.000Z',
            durationMinutes: 270,
            averageViewers: 142,
            peakViewers: 318,
            follows: 12,
            subs: 4,
            bits: 850,
            donations: 25
        },
        snapshots: [
            { capturedAt: '2026-06-07T18:30:00.000Z', viewers: 95, title: 'Friday Night Coding', gameName: 'Software and Game Development' },
            { capturedAt: '2026-06-07T20:00:00.000Z', viewers: 220, title: 'Friday Night Coding', gameName: 'Software and Game Development' },
            { capturedAt: '2026-06-07T22:00:00.000Z', viewers: 318, title: 'Friday Night Coding (finishing up)', gameName: 'Software and Game Development' }
        ],
        sampledChatMessages: [
            { username: 'viewer_one', message: 'KEKW', timestamp: 1749320400 },
            { username: 'mod_hero', message: '!so cdom201 amazing stream as always', timestamp: 1749320500 },
            { username: 'regular_chatter', message: 'wait did you just say banana', timestamp: 1749320600 },
            { username: 'viewer_two', message: 'LUL', timestamp: 1749320700 },
            { username: 'regular_chatter', message: 'the "banana incident" is back lmao', timestamp: 1749320800 },
            { username: 'viewer_one', message: 'PogChamp', timestamp: 1749320900 },
            { username: 'sub_gifter', message: 'just gifted 5 subs cdom201', timestamp: 1749321000 },
            { username: 'viewer_three', message: 'how long have you been using neovim?', timestamp: 1749321100 },
            { username: 'cdom201', message: 'about 2 years now, switched from vscode', timestamp: 1749321200 }
        ],
        existingMemories: [
            { memoryID: 'mem_001', status: 'confirmed', type: 'preference', confidence: 0.9, summary: 'Loves dark mode', content: 'Streamer prefers dark mode in editor and IDE.', useCount: 5, lastUsedAt: '2026-06-01', updatedAt: '2026-06-01' },
            { memoryID: 'mem_002', status: 'confirmed', type: 'channel_lore', confidence: 0.85, summary: 'Friday night coding tradition', content: 'Streamer streams coding every Friday at 6pm local time.', useCount: 12, lastUsedAt: '2026-05-31', updatedAt: '2026-05-31' },
            { memoryID: 'mem_003', status: 'confirmed', type: 'preference', confidence: 0.8, summary: 'Uses Neovim', content: 'Streamer uses Neovim as their main editor.', useCount: 8, lastUsedAt: '2026-06-02', updatedAt: '2026-06-02' }
        ],
        archivedMemories: [
            { memoryID: 'mem_archived_001', status: 'archived', type: 'preference', confidence: 0.5, summary: 'Used vim', content: 'Streamer used to use vim.', lastUsedAt: '2025-01-01', updatedAt: '2025-01-01' }
        ],
        language: 'en'
    };
}

import { generateStreamSummaryDecision } from './stream_summary_decider.js';

function divider(title: string) {
    // eslint-disable-next-line no-console
    console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function summary(label: string, result: any, rawModelOutputs: any[]) {
    // eslint-disable-next-line no-console
    console.log(`\n--- ${label} ---`);
    // eslint-disable-next-line no-console
    console.log(`error: ${result.error}`);
    if (result.model) console.log(`model: ${result.model}`);
    if (result.usedFallback !== undefined) console.log(`usedFallback: ${result.usedFallback}`);
    if (result.message) console.log(`message: ${result.message}`);
    if (result.output) {
        console.log(`headline: ${result.output.summary.headline}`);
        console.log(`recap: ${result.output.summary.recap}`);
        console.log(`highlights (${result.output.summary.highlights.length}):`);
        result.output.summary.highlights.forEach((h: string) => console.log(`  - ${h}`));
        console.log(`\nactions (${result.output.actions.length}):`);
        result.output.actions.forEach((a: any, i: number) => {
            console.log(`  [${i + 1}] action=${a.action} type=${a.type} confidence=${a.confidence} risk=${a.risk}`);
            if (a.summary) console.log(`      summary: ${a.summary}`);
            if (a.content) console.log(`      content: ${a.content}`);
            if (a.reason) console.log(`      reason: ${a.reason}`);
            if (a.targetMemoryId) console.log(`      targetMemoryId: ${a.targetMemoryId}`);
            if (a.evidence && a.evidence.length > 0) console.log(`      evidence: ${a.evidence.join(' | ')}`);
        });
    }
    if (rawModelOutputs.length > 0) {
        console.log(`\n--- Raw model outputs (${rawModelOutputs.length} call(s)) ---`);
        rawModelOutputs.forEach((raw, i) => {
            console.log(`\n[Call ${i + 1}]:`);
            console.log(raw.slice(0, 2000) + (raw.length > 2000 ? '\n... [truncated]' : ''));
        });
    }
}

// Wrap fetch to log all model outputs without mutating the response
const originalFetch = globalThis.fetch;
let rawModelOutputs: string[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
    const result = await originalFetch(url, init);
    if (url.includes('openrouter.ai') && init?.body) {
        const cloned = result.clone();
        try {
            const json = await cloned.json();
            const content = json?.choices?.[0]?.message?.content;
            if (typeof content === 'string') {
                rawModelOutputs.push(content);
            }
        } catch {
            // ignore parse errors on the cloned response
        }
    }
    return result;
};

before(() => {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is required in the environment to run this simulation');
    }
    // eslint-disable-next-line no-console
    console.log(`\n[SIMULATION] Twitch ID: ${MOCK_TWITCH_ID}`);
    // eslint-disable-next-line no-console
    console.log(`[SIMULATION] Streamer: ${mockStreamer.name} (plan: ${mockStreamer.plan_tier})`);
    // eslint-disable-next-line no-console
    console.log(`[SIMULATION] Primary model: deepseek/deepseek-v4-pro`);
    // eslint-disable-next-line no-console
    console.log(`[SIMULATION] Fallback model: deepseek/deepseek-v4-flash`);
    // eslint-disable-next-line no-console
    console.log(`[SIMULATION] Real OpenRouter calls will be made. Real LLM cost.\n`);
});

after(() => {
    (TwitchStreamers as any).getTwitchAccountById = originalGetTwitchAccountById;
    (ChannelAIPersonalitySchema as any).findOne = originalPersonalityFindOne;
    (globalThis as any).fetch = originalFetch;
});

describe('Stream summary simulation for Twitch ID 533238623 (REAL OpenRouter)', () => {
    beforeEach(() => {
        rawModelOutputs = [];
    });

    it('Run: deepseek-v4-pro produces a stream summary + memory actions for cdom201', async () => {
        divider('SCENARIO: Real call to deepseek/deepseek-v4-pro');

        const ctx = buildContext(MOCK_TWITCH_ID);
        const result = await generateStreamSummaryDecision(ctx, 'stream_offline');

        summary('Result', result, rawModelOutputs);

        // Smoke assertions — we don't know exactly what the model will return,
        // but we can assert that the pipeline didn't crash and the output is well-formed.
        assert.equal(result.error, false, 'Expected successful result, got error');
        assert.ok(result.output, 'Expected output');
        assert.ok(result.output?.summary.headline.length > 0, 'Expected non-empty headline');
        assert.ok(result.output?.summary.recap.length > 0, 'Expected non-empty recap');
        assert.ok(Array.isArray(result.output?.summary.highlights), 'Expected highlights array');
        assert.ok(Array.isArray(result.output?.actions), 'Expected actions array');
        assert.ok(typeof result.model === 'string' && result.model.length > 0, 'Expected model name');
    });
});
