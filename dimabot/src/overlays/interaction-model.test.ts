import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInteraction, reduceInteraction, INTERACTION_EVENT_TYPES } from './interaction-model.js';
import { normalizeTwitchEventsubDomainEvent } from '../domain_events/twitch_eventsub_events.js';
import { validateDomainEventContract } from '../domain_events/domain_event_contracts.js';

const start = '2026-10-08T10:00:00Z';
const poll = { broadcaster_user_id: '1', id: 'poll-1', title: 'Choose', started_at: start, ends_at: '2026-10-08T10:02:00Z', choices: [{ id: 'a', title: 'A', votes: 3 }, { id: 'b', title: 'B', votes: 2 }] };
const prediction = { ...poll, id: 'prediction-1', locks_at: poll.ends_at, outcomes: [{ id: 'a', title: 'A', users: 3, channel_points: 400, color: 'blue', top_predictors: [{ user_id: 'private' }] }, { id: 'b', title: 'B', users: 2, channel_points: 200, color: 'pink' }] };
const parse = (type: string, raw: Record<string, unknown>, at = '2026-10-08T10:01:00Z', receipt = type) => parseInteraction(type, raw, at, receipt);

test('all seven event types journal with valid contracts and bounded retention', () => {
  for (const type of Object.keys(INTERACTION_EVENT_TYPES)) {
    const raw = { ...(type.includes('.poll.') ? poll : prediction), status: type.includes('.poll.') ? 'completed' : 'resolved', winning_outcome_id: 'a', locked_at: poll.ends_at, ended_at: poll.ends_at };
    const event = normalizeTwitchEventsubDomainEvent({ messageId: type, messageTimestamp: start, subscription: { type, version: '1' }, event: raw })!;
    assert.equal(event.retentionSeconds, 86400); validateDomainEventContract(event, 'ingest');
  }
});
test('zero votes at begin, full totals replace progress, private predictors removed', () => {
  const beginning = parse('channel.poll.begin', { ...poll, choices: poll.choices.map(({ votes, ...choice }) => choice) });
  assert.deepEqual(beginning.choices.map(c => c.votes), [0, 0]);
  const progress = reduceInteraction(beginning, parse('channel.poll.progress', poll))!;
  assert.deepEqual(progress.choices.map(c => c.votes), [3, 2]);
  assert.equal(reduceInteraction(progress, progress), null);
  const state = parse('channel.prediction.progress', prediction);
  assert(!JSON.stringify(state).includes('private')); assert.equal(state.choices[0].points, 400);
});
test('terminal and locked phases cannot regress; old resources cannot replace new ones', () => {
  const active = parse('channel.prediction.progress', prediction);
  const locked = reduceInteraction(active, parse('channel.prediction.lock', { ...prediction, locked_at: poll.ends_at }, '2026-10-08T10:02:00Z'))!;
  assert.equal(reduceInteraction(locked, { ...active, receipt: 'late-progress', occurredAt: '2026-10-08T10:03:00Z' }), null);
  const ended = reduceInteraction(locked, parse('channel.prediction.end', { ...prediction, status: 'resolved', winning_outcome_id: 'a', ended_at: '2026-10-08T10:03:00Z' }, '2026-10-08T10:03:00Z'))!;
  assert.equal(ended.winnerId, 'a'); assert.equal(reduceInteraction(ended, locked), null);
  const recovered = reduceInteraction(ended, { ...ended, receipt: 'helix-recovery', endedAt: '2026-10-08T10:04:00Z', occurredAt: '2026-10-08T10:04:00Z' })!;
  assert.equal(recovered.endedAt, ended.endedAt, 'recovery cannot restart result visibility');
  const newer = reduceInteraction(ended, { ...active, id: 'prediction-2', startedAt: '2026-10-08T10:05:00Z' })!;
  assert.equal(reduceInteraction(newer, ended), null);
});
test('late same-phase snapshots are ignored, but authoritative end still closes state', () => {
  const progress = parse('channel.poll.progress', poll);
  assert.equal(reduceInteraction(progress, { ...progress, occurredAt: start, receipt: 'late' }), null);
  const ended = parse('channel.poll.end', { ...poll, status: 'terminated', ended_at: poll.ends_at }, start);
  assert.equal(reduceInteraction(progress, ended)?.phase, 'terminated');
});
test('invalid counts, choices, timestamps, status and winner are rejected', () => {
  for (const raw of [{ ...poll, choices: [] }, { ...poll, choices: [poll.choices[0], poll.choices[0]] }, { ...poll, choices: [{ ...poll.choices[0], votes: -1 }, poll.choices[1]] }, { ...poll, ends_at: 'invalid' }]) assert.throws(() => parse('channel.poll.progress', raw));
  assert.throws(() => parse('channel.prediction.end', { ...prediction, status: 'resolved', winning_outcome_id: 'missing', ended_at: poll.ends_at }));
  assert.throws(() => parse('channel.poll.end', { ...poll, status: 'active', ended_at: poll.ends_at }));
});
