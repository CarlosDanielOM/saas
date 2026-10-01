import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createDefaultChannelTtsSettings } from '../../schemas/channel_tts_settings.schema.js';
import { createExecutionContext, evaluate } from './evaluator.js';
import { parse } from './parser.js';

let settings = createDefaultChannelTtsSettings('fixture');
const requests: Record<string, any>[] = [];
const catalogLookup = mock.fn(async () => ['Kappa', 'channelWave', 'ethand14Gojoseggs']);
mock.module('../tts/emote_names.util.js', { namedExports: { getTtsEmoteNames: catalogLookup } });
mock.module('../../schemas/channel_tts_settings.schema.js', { namedExports: {
    getChannelTtsSettings: async () => settings
} });
mock.module('../../functions/chats/speech.chat.js', { namedExports: {
    requestTts: async (_channelID: string, payload: Record<string, any>) => {
        requests.push(payload);
        return { error: false, message: 'Queued' };
    }
} });
mock.module('../posthog_events.js', { namedExports: { trackTts: () => {} } });
const { registerTtsFunctions } = await import('./functions/tts.functions.js');
registerTtsFunctions();

async function run(name: string, message: string, fragments = [{ type: 'emote', text: 'Kappa' }]): Promise<string> {
    const ast = parse(`$(${name} ${name === 'tts.clone' || name === 'tts.fish' ? 'rias_gremory ' : ''}${message})`);
    assert.equal(ast.error, undefined);
    const context = createExecutionContext({ broadcasterId: 'fixture', eventData: { message: { fragments } } });
    return String((await evaluate(ast.ast, context)).value);
}

for (const name of ['tts', 'tts.speak', 'tts.ai', 'tts.clone', 'tts.fish']) {
    test(`${name} respects emote, link, whitespace and emotion settings`, async () => {
        settings = createDefaultChannelTtsSettings('fixture');
        settings.provider = 'fish';
        settings.filters.expressiveTags.angry = false;
        requests.length = 0;
        assert.equal(await run(name, '[angry] Hello   Kappa [happy] https://example.com'), '');
        const payload = requests.at(-1)!;
        assert.equal(payload.text, name === 'tts.speak' ? 'Hello [link]' : 'Hello [happy] [link]');
        assert.equal(payload.meta.source, 'ast');
        if (name === 'tts.clone' || name === 'tts.fish') {
            assert.equal(payload.cloneName, 'rias_gremory');
            assert.equal(payload.provider, 'fish');
        }
    });

    test(`${name} preserves emotes when filtering is disabled`, async () => {
        settings = createDefaultChannelTtsSettings('fixture');
        settings.filters.skipEmotes = false;
        requests.length = 0;
        assert.equal(await run(name, 'Hello Kappa'), '');
        assert.equal(requests.at(-1)!.text, 'Hello Kappa');
    });

    test(`${name} rejects emote-only text and disabled TTS without queueing`, async () => {
        settings = createDefaultChannelTtsSettings('fixture');
        requests.length = 0;
        assert.match(await run(name, 'Kappa'), /No speakable text/);
        assert.equal(requests.length, 0);
        settings.enabled = false;
        assert.match(await run(name, 'Hello'), /disabled/);
        assert.equal(requests.length, 0);
    });
}

test('disabled emotion cues are removed before the length limit', async () => {
    settings = createDefaultChannelTtsSettings('fixture');
    settings.filters.maxLength = 5;
    assert.equal(await run('tts', '[angry] Hello'), '');
    assert.equal(requests.at(-1)!.text, 'Hello');
});

test('AST without a triggering chat message remains supported', async () => {
    settings = createDefaultChannelTtsSettings('fixture');
    const context = createExecutionContext({ broadcasterId: 'fixture' });
    assert.equal(String((await evaluate(parse('$(tts Hello)').ast, context)).value), '');
    assert.equal(requests.at(-1)!.text, 'Hello');
});

test('redemption AST removes global and channel emotes without chat fragments', async () => {
    settings = createDefaultChannelTtsSettings('fixture');
    for (const name of ['tts', 'tts.clone', 'tts.fish']) {
        const context = createExecutionContext({ broadcasterId: 'fixture', eventData: { user_input: 'Hello Kappa channelWave' } });
        const source = `$(${name} ${name === 'tts' ? '' : 'rias_gremory '}Hello Kappa channelWave)`;
        assert.equal(String((await evaluate(parse(source).ast, context)).value), '');
        assert.equal(requests.at(-1)!.text, 'Hello');
    }
    assert.ok(catalogLookup.mock.callCount() > 0);
});

test('redemption reproducer strips repeated ethand14Gojoseggs before truncation', async () => {
    settings = createDefaultChannelTtsSettings('fixture');
    const text = `Ahuevo ya vengo voy al baño ${Array(19).fill('ethand14Gojoseggs').join(' ')}`;
    const context = createExecutionContext({ broadcasterId: 'fixture', argument: text, eventData: { user_input: text } });
    assert.equal(String((await evaluate(parse('$(tts)').ast, context)).value), '');
    assert.equal(requests.at(-1)!.text, 'Ahuevo ya vengo voy al baño');
});
