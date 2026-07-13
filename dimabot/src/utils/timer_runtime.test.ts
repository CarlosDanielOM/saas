import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTimerMessage } from './timer_runtime.js';

test('passes the original timer template through the full AST parser', async () => {
    const template = 'Hello $(user), #(discord)';
    let receivedText = '';
    let receivedContext: Record<string, any> | undefined;

    const parsed = await renderTimerMessage({
        channelID: '123',
        streamerName: 'StreamerName',
        timerName: 'socials',
        message: template,
        planTier: 'pro',
        parse: async (text, context) => {
            receivedText = text;
            receivedContext = context;
            return { parsedText: 'rendered output', count: 0, countModified: false };
        }
    });

    assert.equal(receivedText, template);
    assert.equal(parsed, 'rendered output');
    assert.equal(receivedContext?.scopeType, 'timer');
    assert.equal(receivedContext?.scopeName, 'socials');
    assert.equal(receivedContext?.argument, '');
    assert.equal(receivedContext?.userPlan, 'pro');
    assert.equal(receivedContext?.userLevel, 10);
    assert.equal(receivedContext?.eventData.chatter_user_id, '123');
    assert.equal(receivedContext?.eventData.chatter_user_name, 'StreamerName');
    assert.equal(receivedContext?.eventData.broadcaster_user_id, '123');
    assert.equal(receivedContext?.eventData.broadcaster_user_name, 'StreamerName');
});

test('trims rendered output and preserves intentionally empty output', async () => {
    const parsed = await renderTimerMessage({
        channelID: '123',
        streamerName: 'streamer',
        timerName: 'conditional',
        message: '$(if false yes)',
        planTier: 'free',
        parse: async () => ({ parsedText: '   ', count: 0, countModified: false })
    });

    assert.equal(parsed, '');
});
