import { describe, expect, it } from 'vitest';
import { eventForLayer, goalsForLayer, layerGoalSource, sessionForLayer, statesForLayer } from './widget-runtime/goal-source';
import { testAlert, testGoals } from './widget-runtime/test-events';
import { sessionAfterAlert } from './widget-runtime/session-preview';
import type { DimaSession } from './widget-runtime/dima-events';

const session = (): DimaSession => ({ data: { 'follower-goal': { amount: 30 }, 'subscriber-goal': { amount: 5 }, 'cheer-goal': { amount: 900 }, 'tip-goal': { amount: 12.5 }, 'follower-total': { count: 900 } },
  recents: [{ type: 'follower' }], goalsBySource: { twitch: { 'follower-goal': { amount: 420 }, 'subscriber-goal': { amount: 7 } } } });

describe('custom widget goal source', () => {
  it('defaults to the Goals page; only "twitch" switches', () => {
    expect([undefined, {}, { goalSource: 'dima' }, { goalSource: 'TWITCH' }, { goalSource: 1 }].map(config => layerGoalSource(config as never))).toEqual(['dima', 'dima', 'dima', 'dima', 'dima']);
    expect(layerGoalSource({ goalSource: 'twitch' })).toBe('twitch');
  });
  it('swaps all four StreamElements goal keys for Twitch layers (0 when Twitch has none) and never leaks goalsBySource', () => {
    const twitch = sessionForLayer(session(), 'twitch'), dima = sessionForLayer(session(), 'dima');
    expect(twitch.data).toEqual({ 'follower-goal': { amount: 420 }, 'subscriber-goal': { amount: 7 }, 'cheer-goal': { amount: 0 }, 'tip-goal': { amount: 0 }, 'follower-total': { count: 900 } });
    expect(dima.data['follower-goal']).toEqual({ amount: 30 });
    for (const copy of [twitch, dima]) expect('goalsBySource' in copy).toBe(false);
    expect(sessionForLayer({ data: { 'follower-goal': { amount: 3 } }, recents: [] }, 'twitch').data['follower-goal']).toEqual({ amount: 0 });
  });
  it('gives two layers of one widget their own copies', () => {
    const shared = session(), a = sessionForLayer(shared, 'twitch'), b = sessionForLayer(shared, 'dima');
    (a.data['follower-goal'] as { amount: number }).amount = 999; (a.recents as unknown[]).push('x');
    expect(b.data['follower-goal']).toEqual({ amount: 30 });
    expect(shared.recents.length).toBe(1);
  });
  it('filters goals state by source (items without one are the Goals page’s) and leaves other events alone', () => {
    const goals = testGoals() as { id: string; source?: string }[];
    expect((goalsForLayer(goals, 'twitch') as typeof goals).map(goal => goal.id)).toEqual(['test-twitch-follows']);
    expect((goalsForLayer([...goals, { id: 'old' }], 'dima') as typeof goals).map(goal => goal.id)).toEqual(['test-follows', 'test-money', 'old']);
    expect(goalsForLayer(null, 'twitch')).toBeNull();
    const state = eventForLayer({ type: 'state', data: { name: 'goals', value: goals } }, 'twitch');
    expect((state.data as { value: unknown[] }).value.length).toBe(1);
    const polls = { type: 'state' as const, data: { name: 'polls' as const, value: { poll: null } } };
    expect(eventForLayer(polls, 'twitch')).toBe(polls);
    expect((eventForLayer({ type: 'session', data: session() }, 'twitch').data as DimaSession).data['follower-goal']).toEqual({ amount: 420 });
    expect(statesForLayer({ polls: 1, goals }, 'twitch')).toEqual({ polls: 1, goals: [goals[2]] });
  });
  it('Studio test alerts move our goal values, never Twitch ones', () => {
    const after = sessionAfterAlert(session(), testAlert('follow'));
    expect(sessionForLayer(after, 'dima').data['follower-goal']).toEqual({ amount: 31 });
    expect(sessionForLayer(after, 'twitch').data['follower-goal']).toEqual({ amount: 420 });
  });
});
