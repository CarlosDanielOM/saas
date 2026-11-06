import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const published: { channel: string; type: string; data: Record<string, unknown> }[] = [];
mock.module('./session-refresh.js', { namedExports: { publishToWidgets: (channel: string, type: string, data: Record<string, unknown>) => { published.push({ channel, type, data }); }, requestWidgetSessionRefresh: () => {} } });
const { petWidgetEvent, duelWidgetEvent, rouletteWidgetEvent } = await import('./bot-events.js');

const pet = (kind: string, extra: Record<string, unknown> = {}) => ({ _id: 'req-1', ownerId: 'owner-internal', channelId: '42', operation: 'ask', text: 'what is love? (the viewer prompt)',
  origin: { kind, id: 'o', occurredAt: '' }, actor: { userId: '7', displayName: 'Ada' }, outputText: 'Baby don\'t hurt me', mood: 'happy', moodText: 'private', ...extra }) as never;

test('pet replies: spoken text and mood only; private desktop replies never reach widgets', () => {
  published.length = 0;
  petWidgetEvent(pet('chat-command'), 'speaking');
  petWidgetEvent(pet('chat-command'), 'done', 'cancelled');
  petWidgetEvent(pet('oauth_desktop'), 'speaking');
  petWidgetEvent(pet('chat-command', { mood: 'evil-mood' }), 'speaking');
  assert.deepEqual(published.map(p => [p.channel, p.data.phase, p.data.text, p.data.mood, p.data.result]),
    [['42', 'speaking', 'Baby don\'t hurt me', 'happy', null], ['42', 'done', 'Baby don\'t hurt me', 'happy', 'stopped'], ['42', 'speaking', 'Baby don\'t hurt me', null, null]]);
  for (const event of published) for (const field of ['ownerId', 'actor', 'moodText', 'origin']) assert.equal(field in event.data, false, field);
  assert.ok(!JSON.stringify(published).includes('viewer prompt'), 'never the ask prompt');
});

test('duels: fighters when it starts, the winner only when it ends; roulette labels travel to the API for later', () => {
  published.length = 0;
  const run = { id: 'd1', challenger: 'ada', opponent: 'pix', winner: 'right', mode: 'overlay', endsAt: 9, turns: [{ secret: true }], announcementError: 'x' } as never;
  duelWidgetEvent('42', run, 'started'); duelWidgetEvent('42', run, 'ended');
  assert.deepEqual(published.map(p => [p.data.phase, p.data.winner, p.data.loser]), [['started', null, null], ['ended', 'pix', 'ada']]);
  assert.ok(published.every(p => !('turns' in p.data) && !('announcementError' in p.data)));
  rouletteWidgetEvent('42', { id: 'draw-1', rouletteId: 'r1', endsAt: 5, winner: { label: 'Sing a song' } }, 'Punishments');
  assert.deepEqual(published.at(-1), { channel: '42', type: 'roulette', data: { id: 'draw-1', rouletteId: 'r1', name: 'Punishments', endsAt: 5, label: 'Sing a song', at: published.at(-1)!.data.at } });
});
