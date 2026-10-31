import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTurnInput, turnFingerprint, truncateReply } from './input.js';
const input = { request_id: '1c3f2a4b-5c6d-4a7b-8c9d-001122334455', target: 'bot', text: ' Hey Dima, how are you?  ', source: 'asr', silent: false };

test('accepts conversation, corrections and negation as ordinary unmodified message text', () => {
    for (const text of ['Hey Dima, how are you?', 'Hey Dima, do not ban anyone', 'Hey Dima, actually change the game to Fortnite']) {
        assert.equal(parseTurnInput({ ...input, text }).text, text);
    }
    assert.equal(parseTurnInput(input).text, input.text);
});
test('validates the UTF-16 transport boundary without splitting or trimming', () => {
    assert.equal(parseTurnInput({ ...input, text: '😀'.repeat(1000) }).text.length, 2000);
    assert.throws(() => parseTurnInput({ ...input, text: '😀'.repeat(1001) }));
    assert.throws(() => parseTurnInput({ ...input, text: '   ' }));
    assert.throws(() => parseTurnInput({ ...input, text: 1 }));
});
test('prevents client-authority, voice, missing silence and malformed UUID fields', () => {
    for (const extra of [{ actor: 'broadcaster' }, { channel_id: '123' }, { level: 10 }, { voice: 'piper' }, { persona: 'x' }, { tools: [] }])
        assert.throws(() => parseTurnInput({ ...input, ...extra }));
    assert.throws(() => parseTurnInput({ ...input, silent: undefined }));
    assert.throws(() => parseTurnInput({ ...input, request_id: 'wrong' }));
    assert.throws(() => parseTurnInput({ ...input, source: 'command' }));
    assert.throws(() => parseTurnInput({ ...input, target: ['bot'] }));
    assert.throws(() => parseTurnInput({ ...input, source: ['asr'] }));
});
test('fingerprints every frozen payload component including omitted conversation and silence', () => {
    const base = parseTurnInput(input), same = parseTurnInput({ ...input });
    assert.equal(turnFingerprint(base), turnFingerprint(same));
    for (const change of [{ target: 'pet' }, { text: input.text.trim() }, { source: 'typed' }, { silent: true },
        { conversation_id: '58d161a9-8b61-4a55-ae47-c4bb9a528add' }])
        assert.notEqual(turnFingerprint(base), turnFingerprint(parseTurnInput({ ...input, ...change })));
});
test('spoken response is bounded to two sentences and never breaks a surrogate pair', () => {
    assert.equal(truncateReply('One. Two! Three? Four.'), 'One. Two!');
    const bounded = truncateReply('😀'.repeat(300), 279);
    assert.ok(bounded.length <= 279);
    assert.ok(!/[\uD800-\uDBFF]$/.test(bounded));
    assert.ok(truncateReply('word '.repeat(200)).length <= 280);
});
