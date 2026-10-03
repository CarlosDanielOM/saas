// Verify exhausted-credit routing through compiled AI commands with isolated providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { chat } from '/app/dist/utils/ai/openrouter/ai.js';
import { executeAiCommand } from '/app/dist/utils/ai/openrouter/command.ai.js';
import { AiResponse } from '/app/dist/utils/ai/openrouter/messages.ai.js';
import { parseSpecialCommands } from '/app/dist/handlers/special_parser.handler.js';
import { getThreadLimitsForTier } from '/app/dist/utils/ai/threading/thread_limits.js';
import { createThread, appendThreadTurn, getThreadPromptContext } from '/app/dist/utils/ai/threading/thread_store.js';

const calls = () => {
    try { return fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch { return []; }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.env.SAAS_TARGET === 'bot') {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status === 403; } catch {}
        if (!ready) await pause(500);
    }
    assert.ok(ready, 'actual bot entrypoint rejects unsigned webhook requests');
}
if (process.env.SAAS_TARGET === 'api') {
    assert.equal((await fetch('http://127.0.0.1:3000/config/site/analytics')).status, 200);
}
if (process.env.SAAS_TARGET === 'cron') {
    await pause(2000);
    const cmdlines = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
        try { return [fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')]; } catch { return []; }
    });
    assert.ok(cmdlines.some(cmd => cmd.includes('dist/workers/timer.worker.js')), 'cron supervisor starts timer consumer');
}
const tests = spawnSync(process.execPath, ['--test', 'dist/utils/ai/constants.test.js', 'dist/utils/ai_credit_status.test.js', 'dist/utils/ai/chat_context.test.js', 'dist/utils/ai/prompts.ai.test.js'], { encoding: 'utf8' });
assert.equal(tests.status, 0, tests.stdout + tests.stderr);
const memoryTests = spawnSync(process.execPath, ['dist/scripts/test_ai_memory_context.script.js'], { encoding: 'utf8' });
assert.equal(memoryTests.status, 0, memoryTests.stdout + memoryTests.stderr);

await getMongoDBConnection('ai-chat-behavior');
const redis = await getDragonflyClient('ai-chat-behavior');
await redis.set('app:twitch:token', 'dummy-app-token', { EX: 36000 });
await redis.hSet('accounts:twitch:698614112:data', {
    id: '698614112', access_token: 'dummy-token', expires_at: String(Math.floor(Date.now() / 1000) + 36000)
});
for (const [tier, expected] of [['free', 10], ['premium', 40], ['pro', 100]]) {
    const channelID = `ai-chat-${tier}`;
    const streamer = { id: channelID, name: channelID, plan_tier: tier };
    await redis.hSet(`accounts:twitch:${channelID}:data`, {
        ...streamer, has_permissions: 'true', access_token: 'dummy-streamer-token',
        expires_at: String(Math.floor(Date.now() / 1000) + 36000)
    });
    await redis.set(`twitch:${channelID}:ai:emotes`, '[]');
    await redis.set(`twitch:${channelID}:chatbot:personality`, JSON.stringify({
        enabled: true, personality: 'Dry humor in Spanish. Keep jokes friendly.', rules: ['No spoilers.'],
        knownUsers: [], learningConfig: { semanticChatHistoryEnabled: false }
    }));
    const limits = getThreadLimitsForTier(tier);
    const thread = await createThread(channelID, 'alice-id', 'Alice', 'Games', 1000);
    for (let index = 0; index < expected + 4; index++) {
        await appendThreadTurn(channelID, thread.threadID, {
            role: index % 2 ? 'assistant' : 'user', username: index % 2 ? 'DomDimaBot' : 'Alice',
            message: `Direct message ${index}`, timestamp: 1000 + index, sourceMessageId: `event-${index}`
        }, limits);
    }
    const history = await getThreadPromptContext(channelID, thread.threadID, limits.promptTurns);
    assert.equal(history.length, expected, `${tier} can retain and supply its entire context window`);
    assert.equal(history[0].message, 'Direct message 4');
    const options = { channelID, streamer, message: 'CURRENT_TEST_MESSAGE', threadHistory: history,
        history: Array.from({ length: 100 }, (_, i) => ({ username: `Viewer${i}`, timestamp: 9000 + i, message: `Ambient ${i}` })),
        tags: { badges: [], username: 'Alice', chatter_user_id: 'alice-id', userLevel: 1, identity: { level: 1, tags: ['everyone'] } }
    };
    const result = await chat(options);
    assert.equal(result.error, false);
    const request = calls().filter(call => call.provider === 'openrouter').at(-1).body;
    assert.equal(request.model, 'deepseek/deepseek-v4.1-flash', `${tier} non-exhausted routing stays unchanged`);
    assert.equal(request.messages.filter(msg => msg.role === 'assistant').length, expected / 2);
    assert.match(JSON.stringify(request.messages), /Direct message 4/);
    assert.match(request.messages[0].content, /Dry humor in Spanish/);
    assert.doesNotMatch(request.messages[0].content, /Ambient 99/);
    assert.equal(JSON.parse(request.messages.at(-1).content).message, 'CURRENT_TEST_MESSAGE');
    assert.equal(request.tools.length, 8, 'all existing action tools remain available');

    if (tier === 'free') {
        let offset = calls().length;
        await chat({ ...options, message: 'REQUEST_TITLE_ACTION' });
        let actionCalls = calls().slice(offset);
        assert.equal(actionCalls.filter(call => call.provider === 'twitch' && call.method === 'PATCH').length, 0, 'viewer cannot change title');
        let finalRequest = actionCalls.filter(call => call.provider === 'openrouter').at(-1).body;
        assert.equal(JSON.parse(finalRequest.messages.at(-1).content).success, false);
        assert.match(finalRequest.messages.at(-1).content, /permission denied/i);

        offset = calls().length;
        await chat({ ...options, message: 'REQUEST_TITLE_ACTION', tags: { ...options.tags, userLevel: 7, badges: [{ set_id: 'moderator' }], identity: { level: 7, tags: ['everyone', 'mod'] } } });
        actionCalls = calls().slice(offset);
        finalRequest = actionCalls.filter(call => call.provider === 'openrouter').at(-1).body;
        assert.equal(actionCalls.filter(call => call.provider === 'twitch' && call.method === 'PATCH' && call.path === '/helix/channels').length, 1, `moderator title action executes once: ${finalRequest.messages.at(-1).content}`);
        assert.equal(JSON.parse(finalRequest.messages.at(-1).content).success, true);

        await chat({ ...options, disableTools: true });
        const announcement = calls().filter(call => call.provider === 'openrouter').at(-1).body;
        assert.equal(announcement.tools.length, 0);
        assert.doesNotMatch(announcement.messages[0].content, /AST_PARSER|create_memory/);
    }

    await redis.set(`twitch:${channelID}:ai:exhaust`, 'true');
    const exhausted = await executeAiCommand({ ...streamer, user_id: channelID },
        { username: 'Viewer', userLevel: 1 }, 'Congratulate Viewer on a 15-stream streak.');
    assert.equal(exhausted.error, false, `${tier} exhausted AI command returns text`);
    const exhaustedRequest = calls().filter(call => call.provider === 'openrouter').at(-1).body;
    assert.equal(exhaustedRequest.model, 'meta/muse-spark-1.3-contributor');
    assert.equal(exhaustedRequest.tools.length, 8, 'fallback retains the normal tool definitions');

    const simpleResponse = await AiResponse(channelID, 'Congratulate Viewer on a 15-stream streak.');
    assert.equal(simpleResponse, '@Alice Fixture response.');
    assert.equal(calls().filter(call => call.provider === 'openrouter').at(-1).body.model,
        'meta/muse-spark-1.3-contributor', 'simple AI messages also use the exhausted fallback');

    const streak = await parseSpecialCommands('$(ai $(user) tiene una racha de $(twitch.streak) días, felicitalo!)', {
        channelID,
        eventData: { notice_type: 'watch_streak', chatter_user_name: 'Viewer',
            chatter_user_login: 'viewer', chatter_user_id: 'viewer-id',
            watch_streak: { streak_count: 15, channel_points_awarded: 450 } }
    });
    assert.equal(streak.parsedText, '@Alice Fixture response.');
    const streakRequest = calls().filter(call => call.provider === 'openrouter').at(-1).body;
    assert.equal(streakRequest.model, 'meta/muse-spark-1.3-contributor');
    assert.match(streakRequest.messages.at(-1).content, /racha de 15 días/);
}
console.log(`PASS ${process.env.SAAS_TARGET}: exhausted Muse Spark routing and actual streak template for all tiers; unchanged non-exhausted routing; chat/tool/credit regressions`);
await redis.quit();
process.exit(0);
