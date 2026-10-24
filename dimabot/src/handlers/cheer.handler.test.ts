import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { IBitUseEvent } from '../interfaces/twitch/eventsub.interface.js';
import type { IEventsub } from '../schemas/eventsub.schema.js';
import type { SendMessageContext } from '../functions/chats/send_message.chat.js';

const sent: { message: string; context?: SendMessageContext }[] = [];
mock.module('../functions/chats/send_message.chat.js', { namedExports: {
    sendTwitchChatMessage: async (_channelID: string, message: string, _reply: unknown, context?: SendMessageContext) => {
        sent.push({ message, context });
        return { error: false };
    }
} });
mock.module('../utils/logger.js', { namedExports: {
    info: async () => undefined, error: async () => undefined
} });
const { rulesFromLegacyTiers } = await import('../bits_rules/model.js');
let storedRules: import('../bits_rules/model.js').BitsRule[] | null = null;
mock.module('../bits_rules/store.js', { namedExports: {
    loadBitsRules: async (_channel: string, tiers: unknown) => ({ revision: storedRules ? 1 : 0, rules: storedRules ?? rulesFromLegacyTiers(tiers) })
} });
const { cheerHandler } = await import('./cheer.handler.js');
const template = '$(tts.fish rias_gremory &t)';
const config = { message: 'Default &t', cheerTiers: [
    { name: 'Rias', message: template, min_amount: 5, max_amount: 10000 }
] } as IEventsub;
const event = {
    broadcaster_user_id: 'channel', broadcaster_user_login: 'channel', broadcaster_user_name: 'Channel',
    user_id: 'viewer', user_login: 'viewer', user_name: 'Viewer', bits: 5, type: 'cheer'
};

test('cheer tiers and defaults receive structured and legacy viewer text as parser arguments', async () => {
    for (const message of [{ text: 'Hello from bits', fragments: [] }, 'Hello from bits']) {
        for (const bits of [5, 1]) {
            sent.length = 0;
            const result = await cheerHandler({ ...event, bits, message } as IBitUseEvent, config, true);
            assert.equal(result.error, false);
            assert.equal(sent.at(-1)?.message, bits === 5 ? template : config.message);
            assert.equal(sent.at(-1)?.context?.argument, 'Hello from bits');
        }
    }
});

test('missing bits text is empty and chat-disabled cheers do not send', async () => {
    sent.length = 0;
    await cheerHandler(event as IBitUseEvent, config, true);
    assert.equal(sent.at(-1)?.context?.argument, '');
    sent.length = 0;
    await cheerHandler(event as IBitUseEvent, config, false);
    assert.equal(sent.length, 0);
});

test('shared Bits rules: most specific wins, silent rules send nothing, default mode uses the default message', async () => {
    storedRules = [
        { id: 'wide', name: 'Any', enabled: true, min: 1, max: null, chat: { mode: 'custom', message: 'wide' }, alert: true },
        { id: 'exact', name: 'Nice', enabled: true, min: 69, max: 69, chat: { mode: 'custom', message: 'nice' }, alert: true },
        { id: 'quiet', name: 'Quiet', enabled: true, min: 2, max: 9, chat: { mode: 'silent', message: '' }, alert: true },
        { id: 'default', name: 'Big', enabled: true, min: 1000, max: null, chat: { mode: 'default', message: '' }, alert: true },
        { id: 'off', name: 'Off', enabled: false, min: 500, max: 500, chat: { mode: 'custom', message: 'off' }, alert: true }
    ];
    try {
        const expected: Array<[number, string | undefined]> = [[69, 'nice'], [70, 'wide'], [5, undefined], [1500, config.message], [500, 'wide']];
        for (const [bits, message] of expected) {
            sent.length = 0;
            await cheerHandler({ ...event, bits } as IBitUseEvent, config, true);
            assert.equal(sent.at(-1)?.message, message, `${bits} Bits`);
        }
    } finally { storedRules = null; }
});

test('legacy camelCase tiers from the old editor now match', async () => {
    sent.length = 0;
    await cheerHandler({ ...event, bits: 69 } as IBitUseEvent,
        { message: 'Default', cheerTiers: [{ id: 'tier-1', name: 'Nice', message: 'Nice!', minAmount: 69, maxAmount: 69 }] } as unknown as IEventsub, true);
    assert.equal(sent.at(-1)?.message, 'Nice!');
});
