import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.SECRET_KEY ??= 'a'.repeat(32);
const TRIGGER = 'a'.repeat(24);
const sent: Array<{ channel: string; data: Record<string, unknown>; queue: boolean }> = [];
mock.module('../../../schemas/trigger.schema.js', { namedExports: { TriggerSchema: {
    findOne: async (filter: { name: string }) => filter.name === 'airhorn' ? { _id: TRIGGER, name: 'airhorn', isEnabled: true, volume: 40, file: 'a.mp3', channelID: 'chan' } : null
} } });
mock.module('../../../functions/triggers/resolve_trigger_file.trigger.js', { namedExports: {
    resolveTriggerPlaybackAsset: async () => ({ fileUrl: 'https://api.domdimabot.com/media/x?k=sig', fileType: 'audio/mpeg' })
} });
mock.module('../../../functions/triggers/send_trigger.trigger.js', { namedExports: {
    sendTrigger: async (channel: string, data: Record<string, unknown>, queue: boolean) => { sent.push({ channel, data, queue }); return { error: false, message: 'Trigger sent' }; }
} });

const { registerTriggerFunctions } = await import('./trigger.functions.js');
const { getFunctionHandler, createExecutionContext } = await import('../evaluator.js');
registerTriggerFunctions();
const handler = getFunctionHandler('trigger.send')!;

test.beforeEach(() => { sent.length = 0; });

test('a chatter in the context is sent as firedBy, with the resolved file', async () => {
    assert.equal(await handler(['airhorn', 'true'], createExecutionContext({ broadcasterId: 'chan', userId: '42', userLogin: 'ada', userDisplayName: 'Ada' })), '');
    assert.deepEqual(sent, [{ channel: 'chan', queue: true, data: { triggerId: TRIGGER, name: 'airhorn', url: 'https://api.domdimabot.com/media/x?k=sig', mediaType: 'audio/mpeg', volume: 40,
        firedBy: { id: '42', login: 'ada', name: 'Ada' } } }]);
});

test('empty fields are omitted; no user at all omits firedBy', async () => {
    await handler(['airhorn'], createExecutionContext({ broadcasterId: 'chan', userLogin: 'ada', userDisplayName: '  ' }));
    assert.deepEqual(sent[0].data.firedBy, { login: 'ada' });
    await handler(['airhorn'], createExecutionContext({ broadcasterId: 'chan' }));
    assert.equal(Object.hasOwn(sent[1].data, 'firedBy'), false);
});

test('timers (whose context is the streamer) send no firedBy', async () => {
    await handler(['airhorn'], createExecutionContext({ broadcasterId: 'chan', userId: 'chan', userLogin: 'streamer', userDisplayName: 'Streamer', scopeType: 'timer' }));
    assert.equal(sent.length, 1);
    assert.equal(Object.hasOwn(sent[0].data, 'firedBy'), false);
});

test('unknown trigger never sends', async () => {
    assert.equal(await handler(['nope'], createExecutionContext({ broadcasterId: 'chan', userLogin: 'ada' })), 'Trigger not found: nope');
    assert.equal(sent.length, 0);
});
