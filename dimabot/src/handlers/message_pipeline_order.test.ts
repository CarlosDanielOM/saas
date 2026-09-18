import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('chat moderation runs once before command and timer parsing', () => {
    const source = readFileSync(new URL('./message.handler.ts', import.meta.url), 'utf8');
    const moderationCalls = [...source.matchAll(/await runChatModeration\(/g)].map(match => match.index);
    const commandParsing = source.indexOf('messageEventData.message.text.match(commandsRegex)');

    assert.equal(moderationCalls.length, 1, 'message handler should have one moderation gate');
    assert.ok(commandParsing >= 0, 'command parsing marker should exist');
    assert.ok(moderationCalls[0] < commandParsing, 'moderation must run before command and timer dispatch');
});
