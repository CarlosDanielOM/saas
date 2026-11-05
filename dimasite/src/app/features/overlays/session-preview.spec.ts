import { describe, expect, it } from 'vitest';
import { sessionAfterAlert } from './widget-runtime/session-preview';
import { testAlert } from './widget-runtime/test-events';
import type { DimaSession } from './widget-runtime/dima-events';

const base = (): DimaSession => ({ data: {
  'follower-session': { count: 3 }, 'follower-week': { count: 12 }, 'follower-month': { count: 40 }, 'follower-total': { count: 900 }, 'follower-goal': { amount: 30 },
  'subscriber-session': { count: 2 }, 'subscriber-total': { count: 50 }, 'subscriber-goal': { amount: 5 },
  'cheer-session': { amount: 300 }, 'cheer-total': { amount: 9000 }, 'tip-goal': { amount: 12.5 }, 'follower-recent': []
}, recents: [] });
const at = (session: DimaSession, key: string) => session.data[key] as Record<string, unknown>;

describe('Studio preview session after a test alert (what the server sends OBS next)', () => {
  it('counts follows once, Bits by amount and a community gift by its subs, in every span and the goal', () => {
    let session = sessionAfterAlert(base(), testAlert('follow'));
    expect(['session', 'week', 'month', 'total'].map(span => at(session, `follower-${span}`)['count'])).toEqual([4, 13, 41, 901]);
    expect(at(session, 'follower-goal')['amount']).toBe(31);
    expect(at(session, 'follower-latest')['name']).toBe(testAlert('follow').user!.name);
    expect((session.data['follower-recent'] as unknown[]).length).toBe(1);
    const gift = testAlert('giftBulk');
    session = sessionAfterAlert(session, gift);
    expect([at(session, 'subscriber-session')['count'], at(session, 'subscriber-total')['count'], at(session, 'subscriber-goal')['amount']]).toEqual([2 + gift.amount, 50 + gift.amount, 5 + gift.amount]);
    expect(at(session, 'subscriber-latest')).toMatchObject({ gifted: true, bulkGifted: true });
    const bits = testAlert('bits');
    session = sessionAfterAlert(session, bits);
    expect([at(session, 'cheer-session')['amount'], at(session, 'cheer-total')['amount'], at(session, 'cheer-month')['amount']]).toEqual([300 + bits.amount, 9000 + bits.amount, bits.amount]);
    expect(at(session, 'tip-goal')['amount']).toBe(12.5); // currency goals are weighted: left to the server
    expect(session.recents.length).toBe(3);
  });
  it('a single gifted sub counts once and names the recipient', () => {
    const gift = testAlert('gift'), session = sessionAfterAlert(base(), gift);
    expect(at(session, 'subscriber-session')['count']).toBe(3);
    expect(at(session, 'subscriber-latest')).toMatchObject({ name: gift.recipient!.name, gifted: true, bulkGifted: false });
  });
});
