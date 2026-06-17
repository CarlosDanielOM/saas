/**
 * Direct, no-test-framework run: real call to OpenRouter for Twitch ID 533238623.
 *
 *   npx tsx src/utils/ai/memory/stream_summary_decider.run.ts
 */
import 'dotenv/config';

// Force DragonFlyDB to fail fast (ECONNREFUSED on 127.0.0.1:1) instead of
// hanging on DNS lookup for the "dragonfly" service hostname.
process.env.DRAGONFLY_HOST = '127.0.0.1';
process.env.DRAGONFLY_PORT = '1';

const MOCK_TWITCH_ID = '533238623';

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
(TwitchStreamers as any).getTwitchAccountById = async () => mockStreamer;

import { ChannelAIPersonalitySchema } from '../../../schemas/channel_ai_personality.schema.js';
(ChannelAIPersonalitySchema as any).findOne = function () {
    return { lean: async () => mockPersonality };
};

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

const startTime = Date.now();
function log(msg: string) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[+${elapsed}s] ${msg}`);
}

log('Loading decider module...');
const deciderModule = await import('./stream_summary_decider.js');
const { generateStreamSummaryDecision } = deciderModule;
log('Decider module loaded.');

// Wrap fetch to log progress
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string, init: any) => {
    if (typeof url === 'string' && url.includes('openrouter.ai')) {
        const body = JSON.parse(init.body);
        log(`>>> Calling OpenRouter: model=${body.model} max_tokens=${body.max_tokens} msgCount=${body.messages.length}`);
        log(`>>> System prompt size: ${body.messages[0].content.length} chars`);
        log(`>>> User payload size: ${body.messages[1].content.length} chars`);
    }
    const t0 = Date.now();
    const result = await realFetch(url, init);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    if (typeof url === 'string' && url.includes('openrouter.ai')) {
        log(`<<< OpenRouter responded in ${dur}s (status ${result.status})`);
    }
    return result;
};

log(`Building context for Twitch ID ${MOCK_TWITCH_ID}...`);
const ctx = buildContext(MOCK_TWITCH_ID);
log(`Context built. Calling generateStreamSummaryDecision...`);
log(`This will hit OpenRouter with model: deepseek/deepseek-v4-pro`);
log(`Estimated cost: ~$0.01-0.05 depending on reasoning tokens.`);

try {
    log('About to call generateStreamSummaryDecision...');
    const result = await generateStreamSummaryDecision(ctx, 'stream_offline');
    log('generateStreamSummaryDecision returned!');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`RESULT (took ${elapsed}s)`);
    console.log('='.repeat(70));
    console.log(`error: ${result.error}`);
    if (result.model) console.log(`model: ${result.model}`);
    if (result.usedFallback !== undefined) console.log(`usedFallback: ${result.usedFallback}`);
    if (result.message) console.log(`message: ${result.message}`);

    if (result.output) {
        console.log(`\nheadline: ${result.output.summary.headline}`);
        console.log(`\nrecap:\n  ${result.output.summary.recap}`);
        console.log(`\nhighlights (${result.output.summary.highlights.length}):`);
        for (const h of result.output.summary.highlights) {
            console.log(`  - ${h}`);
        }
        console.log(`\nactions (${result.output.actions.length}):`);
        for (const a of result.output.actions) {
            console.log(`  - [${a.action}] type=${a.type} confidence=${a.confidence} risk=${a.risk}`);
            if (a.summary) console.log(`      summary: ${a.summary}`);
            if (a.content) console.log(`      content: ${a.content}`);
            if (a.reason) console.log(`      reason: ${a.reason}`);
            if (a.targetMemoryId) console.log(`      targetMemoryId: ${a.targetMemoryId}`);
            if (a.evidence && a.evidence.length > 0) console.log(`      evidence: ${JSON.stringify(a.evidence)}`);
        }
    } else {
        console.log('\n(no output returned)');
    }

    // Force exit to avoid hanging on DragonFlyDB cleanup (this is a simulation)
    // eslint-disable-next-line no-console
    console.log(`\n[FORCE EXIT] Bypassing async cleanup of DB connections.`);
    process.exit(0);
} catch (err) {
    console.error('FATAL:', err);
    process.exit(1);
}
