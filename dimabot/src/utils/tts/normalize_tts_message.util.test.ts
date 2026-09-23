import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpokenUserMessage } from './normalize_tts_message.util.js';

test('AST TTS speaks the authored message without attributing it to the triggering chatter', () => {
    assert.equal(buildSpokenUserMessage('Viewer', 'Welcome to the stream', 'en', 'ast'), 'Welcome to the stream');
    assert.equal(buildSpokenUserMessage('Viewer', 'Bienvenidos', 'es', 'ast'), 'Bienvenidos');
});

test('direct speech commands still announce the chatter', () => {
    assert.equal(buildSpokenUserMessage('Viewer', 'Hello chat', 'en', 'chat-command'), 'Viewer say: Hello chat');
    assert.equal(buildSpokenUserMessage('Viewer', 'Hola chat', 'es', 'chat-command'), 'Viewer dice: Hola chat');
});
