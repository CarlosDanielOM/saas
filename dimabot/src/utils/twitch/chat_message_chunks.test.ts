import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeAiReplyRecipientTag, splitAiResponseForTwitch } from './chat_message_chunks.js';

test('removes a redundant opening mention of the reply recipient', () => {
    assert.equal(removeAiReplyRecipientTag('@Alice: Hola!', 'Alice'), 'Hola!');
    assert.equal(removeAiReplyRecipientTag('  @alice, hola @Bob!', 'Alice'), 'hola @Bob!');
    assert.equal(removeAiReplyRecipientTag('@Alice_2 hola', 'Alice'), '@Alice_2 hola');
    assert.equal(removeAiReplyRecipientTag('Hola @Alice!', 'Alice'), 'Hola Alice!');
    assert.equal(removeAiReplyRecipientTag('mail@Alice.com', 'Alice'), 'mail@Alice.com');
    assert.equal(removeAiReplyRecipientTag('@Alice', 'Alice'), '');
});

test('splits the cleaned reply within Twitch message limits', () => {
    const reply = removeAiReplyRecipientTag(`@Alice ${'hola '.repeat(110)}`, 'Alice');
    const chunks = splitAiResponseForTwitch(reply);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => Array.from(chunk).length <= 500));
    assert.ok(chunks.every(chunk => !chunk.startsWith('@Alice')));
});
