import assert from 'node:assert/strict';
import test from 'node:test';
import { clearHypeTrain, hypeTrainOverdue, parseAdBreak, parseAdSchedule, parseHypeTrain, publicAds, publicHypeTrain, reduceAdBreak, reduceHypeTrain, type StoredHypeTrain } from './live-events-model.js';

const T = (offsetMs: number) => new Date(Date.UTC(2026, 10, 6, 20, 0, 0) + offsetMs).toISOString();
const contributor = (id: string, type: string, total: number | string) => ({ user_id: id, user_login: `user${id}`, user_name: `User${id}`, type, total });
const begin = (extra: Record<string, unknown> = {}) => ({ id: 'train-1', broadcaster_user_id: '42', broadcaster_user_login: 'chan', broadcaster_user_name: 'Chan',
  total: 137, progress: 137, goal: 500, level: 1, top_contributions: [contributor('1', 'bits', 100), contributor('2', 'subscription', 37)],
  all_time_high_level: 4, all_time_high_total: 2845, shared_train_participants: null, started_at: T(0), expires_at: T(300_000), type: 'golden_kappa', is_shared_train: false, ...extra });
const end = (extra: Record<string, unknown> = {}) => ({ id: 'train-1', broadcaster_user_id: '42', total: 900, level: 3, top_contributions: [contributor('1', 'bits', 600)],
  shared_train_participants: null, started_at: T(0), ended_at: T(400_000), cooldown_ends_at: T(400_000 + 3_600_000), type: 'golden_kappa', is_shared_train: false, ...extra });
const apply = (stored: StoredHypeTrain | null, type: string, event: Record<string, unknown>, at: string, receipt: string) =>
  reduceHypeTrain(stored, parseHypeTrain(type, event, at), at, receipt);

test('hype train v2 payloads: public fields only, quoted numbers, bad contributor entries skipped, optional parts optional', () => {
  const train = parseHypeTrain('channel.hype_train.begin', begin({ top_contributions: [contributor('1', 'bits', '100'), { user_login: 'nobody' }, contributor('3', 'weird', 5)] }), T(1));
  assert.deepEqual(train.topContributions, [{ user: { id: '1', login: 'user1', name: 'User1' }, type: 'bits', total: 100 }, { user: { id: '3', login: 'user3', name: 'User3' }, type: 'other', total: 5 }]);
  assert.deepEqual([train.phase, train.level, train.total, train.progress, train.goal, train.type, train.allTimeHigh], ['active', 1, 137, 137, 500, 'golden_kappa', { level: 4, total: 2845 }]);
  const shared = parseHypeTrain('channel.hype_train.progress', begin({ is_shared_train: true, all_time_high_level: undefined,
    shared_train_participants: [{ broadcaster_user_id: '7', broadcaster_user_login: 'friend', broadcaster_user_name: 'Friend' }] }), T(1));
  assert.deepEqual([shared.shared, shared.sharedParticipants, shared.allTimeHigh], [true, [{ id: '7', login: 'friend', name: 'Friend' }], null]);
  const ended = parseHypeTrain('channel.hype_train.end', end({ ended_at: undefined, cooldown_ends_at: undefined }), T(9));
  assert.deepEqual([ended.phase, ended.progress, ended.goal, ended.expiresAt, ended.endedAt, ended.cooldownEndsAt], ['ended', null, null, null, T(9), null]);
  assert.throws(() => parseHypeTrain('channel.hype_train.begin', begin({ id: undefined }), T(1)));
  assert.throws(() => parseHypeTrain('channel.hype_train.begin', begin({ total: -1 }), T(1)));
  assert.throws(() => parseHypeTrain('channel.poll.begin', begin(), T(1)));
  assert.ok(!JSON.stringify(train).includes('broadcaster_user'), 'no raw payload fields');
});

test('hype train ordering: duplicates, delayed or equal-time progress, end-first, old trains', () => {
  let stored = apply(null, 'channel.hype_train.begin', begin(), T(1000), 'm1')!;
  assert.equal(apply(stored, 'channel.hype_train.begin', begin(), T(1000), 'm1'), null, 'same receipt');
  stored = apply(stored, 'channel.hype_train.progress', begin({ total: 300, progress: 300, level: 1, all_time_high_level: undefined }), T(2000), 'm2')!;
  assert.deepEqual([stored.train!.total, stored.train!.allTimeHigh], [300, { level: 4, total: 2845 }], 'progress keeps the all-time high from begin');
  assert.equal(apply(stored, 'channel.hype_train.progress', begin({ total: 200 }), T(3000), 'm3'), null, 'a delayed lower total never goes back');
  assert.equal(apply(stored, 'channel.hype_train.progress', begin({ total: 300 }), T(2000), 'm4'), null, 'equal time and total: nothing new');
  assert.equal(apply(stored, 'channel.hype_train.progress', begin({ total: 350, level: 2 }), T(2000), 'm5')!.train!.total, 350, 'equal time, higher total: newer');
  const ended = apply(stored, 'channel.hype_train.end', end(), T(4000), 'm6')!;
  assert.deepEqual([ended.train!.phase, ended.train!.level, ended.train!.allTimeHigh], ['ended', 3, { level: 4, total: 2845 }]);
  assert.equal(apply(ended, 'channel.hype_train.progress', begin({ total: 950 }), T(5000), 'm7'), null, 'never back to active after the end');
  assert.equal(apply(ended, 'channel.hype_train.end', end(), T(5000), 'm8'), null, 'one end');
  // End first (progress lost or late), then the late progress.
  const endFirst = apply(null, 'channel.hype_train.end', end(), T(4000), 'e1')!;
  assert.equal(apply(endFirst, 'channel.hype_train.progress', begin(), T(2000), 'e2'), null);
  // A newer train replaces; an older one never does.
  const next = apply(ended, 'channel.hype_train.begin', begin({ id: 'train-2', started_at: T(8_000_000) }), T(8_000_000), 'n1')!;
  assert.equal(next.train!.id, 'train-2');
  assert.equal(apply(next, 'channel.hype_train.progress', begin(), T(9_000_000), 'n2'), null, 'an older train arriving late');
});

test('hype train recovery: "none running" clears an active train without letting earlier updates bring it back', () => {
  const active = apply(null, 'channel.hype_train.begin', begin(), T(1000), 'm1')!;
  const cleared = clearHypeTrain(active, T(600_000))!;
  assert.deepEqual([cleared.train, cleared.cleared], [null, { id: 'train-1', startedAt: T(0), at: T(600_000) }]);
  assert.equal(apply(cleared, 'channel.hype_train.progress', begin({ total: 999 }), T(500_000), 'late'), null, 'an update from before the check');
  assert.equal(apply(cleared, 'channel.hype_train.progress', begin({ id: 'old', started_at: T(-50_000) }), T(700_000), 'older'), null, 'an older train');
  assert.equal(apply(cleared, 'channel.hype_train.progress', begin({ total: 999 }), T(700_000), 'after')!.train!.total, 999, 'Twitch says it still runs');
  assert.equal(apply(cleared, 'channel.hype_train.end', end(), T(500_000), 'end')!.train!.phase, 'ended', 'its end still arrives');
  assert.equal(clearHypeTrain(apply(active, 'channel.hype_train.end', end(), T(4000), 'm2'), T(600_000)), null, 'an ended train is kept');
  assert.equal(clearHypeTrain(null, T(1)), null);
});

test('what widgets see: ms times, an ended train until its cooldown (2 h at most), overdue detection', () => {
  const active = apply(null, 'channel.hype_train.begin', begin(), T(1000), 'm1')!;
  const view = publicHypeTrain(active, Date.parse(T(2000)))!;
  assert.deepEqual([view.phase, view.startedAt, view.expiresAt, view.endedAt], ['active', Date.parse(T(0)), Date.parse(T(300_000)), null]);
  assert.equal(hypeTrainOverdue(active, Date.parse(T(300_000)) + 5_000), false);
  assert.equal(hypeTrainOverdue(active, Date.parse(T(300_000)) + 15_000), true);
  const ended = apply(active, 'channel.hype_train.end', end(), T(400_000), 'm2')!;
  assert.equal(publicHypeTrain(ended, Date.parse(T(400_000)) + 3_000_000)!.cooldownEndsAt, Date.parse(T(4_000_000)));
  assert.equal(publicHypeTrain(ended, Date.parse(T(4_000_000))), null, 'cooldown over');
  const long = apply(active, 'channel.hype_train.end', end({ cooldown_ends_at: T(400_000 + 5 * 3_600_000) }), T(400_000), 'm3')!;
  assert.equal(publicHypeTrain(long, Date.parse(T(400_000)) + 2 * 3_600_000), null, 'two hours at most');
  assert.equal(publicHypeTrain(null, 0), null);
});

test('ad breaks: activity computed against now, newer breaks win, schedule parsing', () => {
  const ad = parseAdBreak({ duration_seconds: '60', started_at: T(0), is_automatic: 'false', requester_user_id: '9', requester_user_login: 'editor' });
  assert.deepEqual(ad, { startedAt: T(0), duration: 60, automatic: false }, 'no requester identity');
  const stored = reduceAdBreak(null, ad, T(0), 'a1')!;
  assert.equal(reduceAdBreak(stored, ad, T(0), 'a1'), null);
  assert.equal(reduceAdBreak(stored, parseAdBreak({ duration_seconds: 30, started_at: T(-60_000), is_automatic: true }), T(1), 'a0'), null, 'an older delayed break');
  assert.equal(reduceAdBreak(stored, parseAdBreak({ duration_seconds: 90, started_at: T(900_000), is_automatic: true }), T(900_000), 'a2')!.ad.duration, 90);
  assert.deepEqual(publicAds(stored, null, Date.parse(T(30_000))), { active: { startedAt: Date.parse(T(0)), endsAt: Date.parse(T(60_000)), duration: 60, automatic: false }, schedule: null });
  assert.deepEqual(publicAds(stored, null, Date.parse(T(60_000))), { active: null, schedule: null }, 'ended without a timer');
  const fetchedAt = Date.parse(T(0));
  assert.deepEqual(parseAdSchedule({ next_ad_at: T(1_200_000), last_ad_at: '', duration: '60', preroll_free_time: '90', snooze_count: 1, snooze_refresh_at: T(3_600_000) }, fetchedAt),
    { nextAt: Date.parse(T(1_200_000)), duration: 60, lastAt: null, snoozes: 1, snoozeRefreshAt: Date.parse(T(3_600_000)), prerollFreeUntil: fetchedAt + 90_000 });
  assert.deepEqual(parseAdSchedule({ next_ad_at: '', last_ad_at: '', duration: 0, preroll_free_time: 0, snooze_count: 0, snooze_refresh_at: '' }, fetchedAt),
    { nextAt: null, duration: 0, lastAt: null, snoozes: 0, snoozeRefreshAt: null, prerollFreeUntil: null }, 'offline: nothing scheduled');
  assert.equal(parseAdSchedule(undefined, fetchedAt), null);
});
