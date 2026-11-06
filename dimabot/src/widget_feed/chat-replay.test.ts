import assert from 'node:assert/strict';
import test from 'node:test';
import { replayChat } from './chat-replay.js';

test('stored chat history replays oldest first as text-only Dima chat with roles from badge labels', () => {
  const history = [
    { username: 'Ame', message: 'newest', timestamp: 3, messageID: 'm3', badges: ['[MOD]', '[SUB 14M]'] },
    { username: 'あめ', message: 'unicode name', timestamp: 2, badges: ['[VIP]', '[FOUNDER 3M]', '[PRIME]'] },
    { username: '', message: 'skipped: no name', timestamp: 1 },
    { username: 'Pix', message: '<b>hi</b>', timestamp: 0, messageID: 'm0', badges: ['[STREAMER]'] }
  ];
  const messages = replayChat(history);
  assert.deepEqual(messages.map(m => [m.id, m.user.name, m.user.login, m.text]), [['replay-m0', 'Pix', 'pix', '<b>hi</b>'], ['replay-2-1', 'あめ', '', 'unicode name'], ['replay-m3', 'Ame', 'ame', 'newest']]);
  assert.deepEqual([messages[0].user.roles.broadcaster, messages[2].user.roles.moderator, messages[2].user.subMonths, messages[1].user.roles.founder, messages[1].user.roles.subscriber, messages[1].user.roles.prime], [true, true, 14, true, true, true]);
  assert.deepEqual(messages[0].parts, [{ type: 'text', text: '<b>hi</b>' }], 'text stays text (widgets escape it)');
  assert.equal(replayChat(history, 1).length, 1, 'limit applies to the newest messages');
  assert.equal(replayChat(history, 1)[0].text, 'newest');
});
