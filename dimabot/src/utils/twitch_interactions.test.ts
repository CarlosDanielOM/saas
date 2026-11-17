import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OVERDUE_GRACE_MS, SNAPSHOT_TTL_SECONDS, UNFED_TTL_SECONDS,
    eventSnapshot, findOption, forgetInteraction, forgetInteractionFeed, leaders, markPollCanceled,
    noteInteractionEvent, payloadSnapshot, pollSnapshot, predictionSnapshot, readInteraction, supersedes, unmarkPollCanceled,
    type InteractionCache, type InteractionDeps, type InteractionKind, type InteractionSnapshot
} from './twitch_interactions.js';

const NOW = Date.parse('2026-11-17T20:00:00Z');

/** In-memory stand-in with real expiry and the store script's rules (the script itself runs in ops/checks/poll-roulette-ast.mjs). */
class FakeCache implements InteractionCache {
    values = new Map<string, { value: string; ttl: number; expires: number }>();
    /** `snapshot: null` is an invalidation marker. */
    hashes = new Map<string, { snapshot: InteractionSnapshot | null; generation: string; ttl: number; expires: number }>();
    private generation = 0;
    constructor(private readonly now: () => number) {}
    private live<T extends { expires: number }>(map: Map<string, T>, key: string): T | undefined {
        const entry = map.get(key);
        if (entry && entry.expires <= this.now()) { map.delete(key); return undefined; }
        return entry;
    }
    async get(key: string) { return this.live(this.values, key)?.value ?? null; }
    async set(key: string, value: string, options: { EX: number; NX?: boolean }) {
        if (options.NX && this.live(this.values, key)) return null;
        this.values.set(key, { value, ttl: options.EX, expires: this.now() + options.EX * 1000 }); return 'OK';
    }
    async del(key: string) { return Number(this.values.delete(key)) + Number(this.hashes.delete(key)); }
    async read(key: string) {
        const entry = this.live(this.hashes, key);
        return entry ? { json: entry.snapshot ? JSON.stringify(entry.snapshot) : null, generation: entry.generation } : null;
    }
    async invalidate(key: string, ttlSeconds: number) {
        this.hashes.set(key, { snapshot: null, generation: `g${++this.generation}`, ttl: ttlSeconds, expires: this.now() + ttlSeconds * 1000 });
    }
    async store(key: string, snapshot: InteractionSnapshot, ttlSeconds: number, rule: { event: true } | { seen: string }) {
        const current = this.live(this.hashes, key);
        if ('seen' in rule ? (current?.generation ?? '') !== rule.seen : Boolean(current?.snapshot && supersedes(current.snapshot, snapshot))) return false;
        this.hashes.set(key, { snapshot, generation: `g${++this.generation}`, ttl: ttlSeconds, expires: this.now() + ttlSeconds * 1000 });
        return true;
    }
    ttl(key: string) { return (this.live(this.hashes, key) ?? this.live(this.values, key))?.ttl; }
}

function setup(options: { fed?: boolean; poll?: unknown; prediction?: unknown; error?: { type?: string; status?: number } } = {}) {
    const state = { now: NOW, fed: options.fed ?? false, poll: options.poll, prediction: options.prediction, error: options.error, cacheDown: false,
        /** Runs while Twitch is "answering" a read. */
        during: null as null | (() => Promise<unknown>) };
    const cache = new FakeCache(() => state.now);
    const calls = { poll: 0, prediction: 0, subscribed: 0, subscribe: [] as string[] };
    const read = (kind: InteractionKind) => async () => {
        calls[kind]++;
        const answer = state.error ? { error: true, ...state.error } : { error: false, data: state[kind] };
        if (state.during) { const run = state.during; state.during = null; await run(); }
        return answer;
    };
    const deps: InteractionDeps = {
        cache: async () => { if (state.cacheDown) throw new Error('down'); return cache; },
        fetchPoll: read('poll'), fetchPrediction: read('prediction'),
        subscribed: async () => { calls.subscribed++; return state.fed; },
        subscribe: async (_channel, kind) => { calls.subscribe.push(kind); return true; },
        now: () => state.now
    };
    const iso = (offsetMs: number) => new Date(state.now + offsetMs).toISOString();
    const twitchPoll = (status: string, votes: number[], extra: Record<string, unknown> = {}) => ({
        id: 'poll-1', title: 'Best map?', status, startedAt: new Date(NOW - 60_000).toISOString(), duration: 300,
        choices: ['Nuke', 'Mirage', 'Inferno'].map((title, index) => ({ id: `c${index + 1}`, title, votes: votes[index], channelPointsVotes: 0 })), ...extra
    });
    const pollEvent = (status: string | null, votes: number[], id = 'poll-1', startedOffset = -60_000) => ({
        id, broadcaster_user_id: '1', title: 'Best map?', started_at: new Date(NOW + startedOffset).toISOString(),
        ...(status ? { status, ended_at: iso(0) } : { ends_at: new Date(NOW + 240_000).toISOString() }),
        choices: ['Nuke', 'Mirage', 'Inferno'].map((title, index) => ({ id: `c${index + 1}`, title, votes: votes[index], channel_points_votes: 0, bits_votes: 0 }))
    });
    const prediction = (extra: Record<string, unknown>) => ({ id: 'pred-1', broadcaster_user_id: '1', title: 'Will we win?', started_at: new Date(NOW - 60_000).toISOString(),
        outcomes: [{ id: 'o1', title: 'Yes', users: 3, channel_points: 900, color: 'blue' }, { id: 'o2', title: 'No', users: 1, channel_points: 100, color: 'pink' }], ...extra });
    const twitchPrediction = (status: string, extra: Record<string, unknown> = {}) => ({
        id: 'pred-1', title: 'Will we win?', status, predictionStatus: status, createdAt: new Date(NOW - 60_000).toISOString(), predictionWindow: 120,
        outcomes: [{ id: 'o1', title: 'Yes', users: 18, channel_points: 6400 }, { id: 'o2', title: 'No', users: 7, channel_points: 3600 }], ...extra
    });
    return { cache, calls, state, deps, iso, twitchPoll, pollEvent, prediction, twitchPrediction };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const POLL = 'twitch:1:poll:snapshot', PREDICTION = 'twitch:1:prediction:snapshot';

test('a miss asks Twitch once; later reads share the snapshot', async () => {
    const t = setup({ fed: true }); t.state.poll = t.twitchPoll('ACTIVE', [5, 5, 2]);
    const first = await readInteraction('1', 'poll', t.deps);
    t.state.now += 20_000;
    const second = await readInteraction('1', 'poll', t.deps);
    assert.equal(t.calls.poll, 1);
    assert.deepEqual(second, first);
    assert.deepEqual([first.status, first.startedAt, first.endsAt], ['active', NOW - 60_000, NOW + 240_000]);
    assert.deepEqual(first.options.map(option => [option.title, option.value]), [['Nuke', 5], ['Mirage', 5], ['Inferno', 2]]);
});

test('a channel without every notification is asked again after 5 s, whatever the status', async () => {
    for (const status of ['ACTIVE', 'COMPLETED']) {
        const t = setup({ fed: false }); t.state.poll = t.twitchPoll(status, [1, 0, 0]);
        await readInteraction('1', 'poll', t.deps);
        await settle();
        assert.equal(t.cache.ttl(POLL), UNFED_TTL_SECONDS, status);
        // Turned on in the background, once.
        assert.deepEqual(t.calls.subscribe, ['poll']);
        t.state.now += 4_000;
        await readInteraction('1', 'poll', t.deps);
        assert.equal(t.calls.poll, 1, 'within 5 s the snapshot answers');
        t.state.now += 2_000;
        await readInteraction('1', 'poll', t.deps);
        await settle();
        assert.equal(t.calls.poll, 2, 'after 5 s Twitch is asked again');
        assert.deepEqual(t.calls.subscribe, ['poll'], 'no second attempt within the hour');
        // The subscription made it fed: this read is trusted for the hour.
        assert.equal(t.cache.ttl(POLL), SNAPSHOT_TTL_SECONDS);
        t.state.now += 3 * 60_000;
        await readInteraction('1', 'poll', t.deps);
        assert.equal(t.calls.poll, 2, 'now fed: no more reads while the poll runs');
    }
});

test('a fed channel keeps running and finished snapshots up to an hour, then asks Twitch', async () => {
    const t = setup({ fed: true }); t.state.poll = t.twitchPoll('COMPLETED', [3, 1, 0]);
    assert.equal((await readInteraction('1', 'poll', t.deps)).status, 'ended');
    assert.equal(t.cache.ttl(POLL), SNAPSHOT_TTL_SECONDS);
    t.state.now += 3599_000;
    await readInteraction('1', 'poll', t.deps);
    assert.equal(t.calls.poll, 1);
    t.state.now += 2_000;
    await readInteraction('1', 'poll', t.deps);
    assert.equal(t.calls.poll, 2, 'expired after the hour');
    assert.deepEqual(t.calls.subscribe, []);
});

test('a snapshot stops being trusted when the channel loses its notifications', async () => {
    const t = setup({ fed: true }); t.state.prediction = t.twitchPrediction('LOCKED');
    await readInteraction('1', 'prediction', t.deps);
    t.state.now += 60_000;
    await readInteraction('1', 'prediction', t.deps);
    assert.equal(t.calls.prediction, 1);
    // Twitch revoked a subscription: the handler drops the feed knowledge.
    t.state.fed = false;
    await forgetInteractionFeed('1', 'channel.prediction.end', t.deps);
    t.state.prediction = t.twitchPrediction('RESOLVED', { winning_outcome_id: 'o2' });
    const snapshot = await readInteraction('1', 'prediction', t.deps);
    await settle();
    assert.deepEqual([t.calls.prediction, snapshot.status, snapshot.winnerId], [2, 'ended', 'o2']);
    assert.deepEqual(t.calls.subscribe, ['prediction'], 'and the missing subscription is repaired');
    // Without the handler's hint the same happens within 10 minutes.
    const late = setup({ fed: true }); late.state.prediction = late.twitchPrediction('LOCKED');
    await readInteraction('1', 'prediction', late.deps);
    late.state.fed = false;
    late.state.now += 9 * 60_000;
    await readInteraction('1', 'prediction', late.deps);
    assert.equal(late.calls.prediction, 1);
    late.state.now += 2 * 60_000;
    await readInteraction('1', 'prediction', late.deps);
    assert.equal(late.calls.prediction, 2);
});

test('failures and "no poll" are kept 5 s and never subscribe on a failure', async () => {
    const none = setup({ error: { type: 'not_found', status: 404 } });
    assert.equal((await readInteraction('1', 'poll', none.deps)).status, 'none');
    assert.equal(none.cache.ttl(POLL), UNFED_TTL_SECONDS);
    await readInteraction('1', 'poll', none.deps);
    assert.equal(none.calls.poll, 1);

    const denied = setup({ error: { type: 'permission_error', status: 403 } });
    const snapshot = await readInteraction('1', 'poll', denied.deps);
    await settle();
    assert.deepEqual([snapshot.status, snapshot.options.length], ['unavailable', 0]);
    assert.deepEqual([denied.calls.subscribe.length, denied.calls.subscribed], [0, 0]);
});

test('Twitch statuses: ended early and archived are results, deleted is canceled', () => {
    const t = setup();
    for (const status of ['COMPLETED', 'TERMINATED', 'ARCHIVED']) assert.equal(pollSnapshot(t.twitchPoll(status, [1, 0, 0]), NOW)!.status, 'ended');
    for (const status of ['MODERATED', 'INVALID']) assert.equal(pollSnapshot(t.twitchPoll(status, [1, 0, 0]), NOW)!.status, 'canceled');
    assert.equal(pollSnapshot(t.twitchPoll('COMPLETED', [1, 0, 0]), NOW)!.endsAt, null);
    assert.equal(pollSnapshot({ id: '', choices: [] }, NOW), null);
    assert.equal(predictionSnapshot(t.twitchPrediction('LOCKED'), NOW)!.status, 'locked');
    assert.equal(predictionSnapshot(t.twitchPrediction('CANCELED'), NOW)!.status, 'canceled');
    const resolved = predictionSnapshot(t.twitchPrediction('RESOLVED', { winning_outcome_id: 'o1' }), NOW)!;
    assert.deepEqual([resolved.status, resolved.winnerId], ['ended', 'o1']);
    assert.deepEqual(resolved.options.map(option => [option.title, option.value, option.users]), [['Yes', 6400, 18], ['No', 3600, 7]]);
    assert.equal(predictionSnapshot(t.twitchPrediction('RESOLVED', { winning_outcome_id: 'nope' }), NOW)!.winnerId, null);
});

test('notifications replace the snapshot, so no Twitch read is needed', async () => {
    const t = setup({ fed: true });
    assert.equal((await noteInteractionEvent('1', 'channel.poll.begin', t.pollEvent(null, [0, 0, 0]), t.deps))!.status, 'active');
    assert.equal(t.cache.ttl(POLL), SNAPSHOT_TTL_SECONDS);
    t.state.now += 1000;
    await noteInteractionEvent('1', 'channel.poll.progress', t.pollEvent(null, [2, 3, 0]), t.deps);
    assert.deepEqual((await readInteraction('1', 'poll', t.deps)).options.map(option => option.value), [2, 3, 0]);
    t.state.now += 1000;
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('completed', [4, 4, 1]), t.deps))!.status, 'ended');
    t.state.now += 30 * 60_000;
    assert.deepEqual((await readInteraction('1', 'poll', t.deps)).options.map(option => option.value), [4, 4, 1]);
    assert.equal(t.calls.poll, 0);
});

test('order: late progress never reopens, an older poll never replaces a newer one', async () => {
    const t = setup({ fed: true });
    await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('completed', [4, 4, 1]), t.deps);
    t.state.now += 500;
    // The notification itself is still reported to the caller, but it is not stored.
    assert.equal((await noteInteractionEvent('1', 'channel.poll.progress', t.pollEvent(null, [9, 9, 9]), t.deps))!.status, 'active');
    assert.deepEqual([(await readInteraction('1', 'poll', t.deps)).status, (await readInteraction('1', 'poll', t.deps)).options[0].value], ['ended', 4]);
    // A newer poll replaces the finished one...
    await noteInteractionEvent('1', 'channel.poll.begin', t.pollEvent(null, [0, 0, 0], 'poll-2', 10_000), t.deps);
    assert.equal((await readInteraction('1', 'poll', t.deps)).id, 'poll-2');
    // ...and the old poll's second end notification (archived) does not come back over it.
    t.state.now += 500;
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('archived', [4, 4, 1]), t.deps))!.id, 'poll-1');
    assert.deepEqual([(await readInteraction('1', 'poll', t.deps)).id, (await readInteraction('1', 'poll', t.deps)).status], ['poll-2', 'active']);

    const p = setup({ fed: true });
    await noteInteractionEvent('1', 'channel.prediction.lock', p.prediction({ locked_at: p.iso(0) }), p.deps);
    p.state.now += 500;
    await noteInteractionEvent('1', 'channel.prediction.progress', p.prediction({ locks_at: p.iso(60_000) }), p.deps);
    assert.equal((await readInteraction('1', 'prediction', p.deps)).status, 'locked', 'delayed progress does not unlock');
    assert.equal(p.calls.prediction, 0);
});

test('supersedes: the rules the store script applies', () => {
    const t = setup();
    const at = (snapshot: InteractionSnapshot, ms: number) => ({ ...snapshot, at: ms });
    const active = eventSnapshot('channel.poll.progress', t.pollEvent(null, [1, 0, 0]), NOW)!;
    const ended = eventSnapshot('channel.poll.end', t.pollEvent('completed', [1, 0, 0]), NOW)!;
    const newer = eventSnapshot('channel.poll.begin', t.pollEvent(null, [0, 0, 0], 'poll-2', 5_000), NOW)!;
    const none = { ...active, id: '', status: 'none' as const, options: [] };
    assert.equal(supersedes(ended, active), true);
    assert.equal(supersedes(active, ended), false);
    assert.equal(supersedes(at(active, NOW + 5), at(active, NOW)), true, 'same phase and votes: the later view stays');
    assert.equal(supersedes(at(active, NOW), at(active, NOW)), false);
    // Votes only go up within a poll: fewer votes is an older view, whenever it arrives.
    const more = eventSnapshot('channel.poll.progress', t.pollEvent(null, [6, 3, 1]), NOW)!;
    assert.equal(supersedes(more, at(active, NOW + 60_000)), true);
    assert.equal(supersedes(active, at(more, NOW - 60_000)), false);
    assert.equal(supersedes(newer, ended), true);
    assert.equal(supersedes(ended, newer), false);
    assert.equal(supersedes(active, none), true, '"no poll" never replaces a real snapshot');
    assert.equal(supersedes(none, active), false);
});

test('same phase: delayed progress or a delayed begin never moves the totals backward', async () => {
    const t = setup({ fed: true });
    await noteInteractionEvent('1', 'channel.poll.progress', t.pollEvent(null, [12, 8, 0]), t.deps);
    t.state.now += 800;
    await noteInteractionEvent('1', 'channel.poll.progress', t.pollEvent(null, [6, 4, 0]), t.deps);
    await noteInteractionEvent('1', 'channel.poll.begin', t.pollEvent(null, [0, 0, 0]), t.deps);
    assert.deepEqual((await readInteraction('1', 'poll', t.deps)).options.map(option => option.value), [12, 8, 0]);
    t.state.now += 800;
    await noteInteractionEvent('1', 'channel.poll.progress', t.pollEvent(null, [12, 9, 0]), t.deps);
    assert.deepEqual((await readInteraction('1', 'poll', t.deps)).options.map(option => option.value), [12, 9, 0]);
    assert.equal(t.calls.poll, 0);
});

test('a Twitch read in flight when the snapshot is invalidated is never stored or joined', async () => {
    const t = setup({ fed: true }); t.state.prediction = t.twitchPrediction('LOCKED');
    let late: Promise<InteractionSnapshot> | null = null;
    // While Twitch answers "locked": the end notification arrives, then end.prediction's own success drops the snapshot.
    t.state.during = async () => {
        await noteInteractionEvent('1', 'channel.prediction.end', t.prediction({ status: 'resolved', winning_outcome_id: 'o2', ended_at: t.iso(0) }), t.deps);
        await forgetInteraction('1', 'prediction', t.deps);
        t.state.prediction = t.twitchPrediction('RESOLVED', { winning_outcome_id: 'o2' });
        // A caller arriving now must not be handed the read that started before the change.
        late = readInteraction('1', 'prediction', t.deps);
    };
    const early = await readInteraction('1', 'prediction', t.deps);
    assert.equal(early.status, 'locked', 'the caller that asked before the change gets what Twitch said then');
    assert.deepEqual([(await late!).status, (await late!).winnerId], ['ended', 'o2']);
    assert.equal(t.calls.prediction, 2);
    assert.equal((await readInteraction('1', 'prediction', t.deps)).status, 'ended', 'the stale "locked" was not stored');
    assert.equal(t.cache.ttl(PREDICTION), SNAPSHOT_TTL_SECONDS);
});

test('callers share one Twitch read, but do not wait on one that hangs', async () => {
    const t = setup({ fed: true }); t.state.poll = t.twitchPoll('ACTIVE', [1, 0, 0]);
    let release = () => {};
    t.state.during = () => new Promise<void>(resolve => { release = resolve; });
    const first = readInteraction('1', 'poll', t.deps);
    await settle();
    const second = readInteraction('1', 'poll', t.deps);
    await settle();
    assert.equal(t.calls.poll, 1, 'the second caller joined the first read');
    // Ten seconds later the first read still hangs: a new caller starts its own.
    t.state.now += 10_001;
    const third = await readInteraction('1', 'poll', t.deps);
    assert.deepEqual([t.calls.poll, third.status], [2, 'active']);
    release();
    assert.deepEqual([(await first).id, (await second).id], ['poll-1', 'poll-1']);
});

test('a Twitch read that was overtaken by a notification is dropped', async () => {
    const t = setup({ fed: true }); t.state.prediction = t.twitchPrediction('LOCKED');
    // While Twitch answers "locked", the end notification arrives.
    t.state.during = () => noteInteractionEvent('1', 'channel.prediction.end', t.prediction({ status: 'resolved', winning_outcome_id: 'o2', ended_at: t.iso(0) }), t.deps);
    const snapshot = await readInteraction('1', 'prediction', t.deps);
    assert.deepEqual([snapshot.status, snapshot.winnerId], ['ended', 'o2'], 'the caller gets the newer view');
    assert.equal((await readInteraction('1', 'prediction', t.deps)).status, 'ended', 'and it is what stays stored');
    assert.equal(t.cache.ttl(PREDICTION), SNAPSHOT_TTL_SECONDS);
    assert.equal(t.calls.prediction, 1);
});

test('a running poll past its end time is read again, at most every 5 s', async () => {
    const t = setup({ fed: true }); t.state.poll = t.twitchPoll('ACTIVE', [1, 0, 0]);
    await readInteraction('1', 'poll', t.deps);
    t.state.now = NOW + 240_000 + OVERDUE_GRACE_MS - 1;
    await readInteraction('1', 'poll', t.deps);
    assert.equal(t.calls.poll, 1);
    // Twitch still says ACTIVE after the deadline: nine functions in a row cost one more read, not nine.
    t.state.now = NOW + 240_000 + OVERDUE_GRACE_MS + 1;
    for (let i = 0; i < 9; i++) await readInteraction('1', 'poll', t.deps);
    assert.equal(t.calls.poll, 2);
    assert.equal(t.cache.ttl(POLL), UNFED_TTL_SECONDS);
    t.state.now += 5_001;
    t.state.poll = t.twitchPoll('COMPLETED', [6, 2, 0]);
    const snapshot = await readInteraction('1', 'poll', t.deps);
    assert.deepEqual([t.calls.poll, snapshot.status, snapshot.options[0].value], [3, 'ended', 6]);
    assert.equal(t.cache.ttl(POLL), SNAPSHOT_TTL_SECONDS);
});

test('an end-only channel: the end notification is kept 5 s; a read subscribes the rest', async () => {
    const t = setup({ fed: false });
    await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('completed', [1, 0, 0]), t.deps);
    await settle();
    assert.equal(t.cache.ttl(POLL), UNFED_TTL_SECONDS);
    assert.deepEqual(t.calls.subscribe, [], 'notifications alone never subscribe a channel to more');
    // Within 5 s a command answers from it (and that use turns the missing notifications on).
    assert.equal((await readInteraction('1', 'poll', t.deps)).status, 'ended');
    await settle();
    assert.deepEqual([t.calls.poll, t.calls.subscribe], [0, ['poll']]);
    // A new poll started on Twitch is seen on the next read instead of an hour later.
    t.state.fed = false;
    t.state.now += 6_000;
    t.state.poll = t.twitchPoll('ACTIVE', [0, 0, 0], { id: 'poll-2' });
    assert.equal((await readInteraction('1', 'poll', t.deps)).id, 'poll-2');
});

test('malformed and unrelated notifications are ignored', async () => {
    const t = setup({ fed: true });
    assert.equal(await noteInteractionEvent('1', 'channel.follow', {}, t.deps), null);
    assert.equal(await noteInteractionEvent('1', 'channel.poll.end', { id: 'x' }, t.deps), null);
    assert.equal(await noteInteractionEvent('', 'channel.poll.end', t.pollEvent('completed', [1, 0, 0]), t.deps), null);
    assert.equal(t.cache.hashes.size, 0);
    assert.equal(eventSnapshot('channel.poll.end', t.pollEvent('archived', [1, 2, 3]), NOW)!.status, 'ended');
});

test('payloadSnapshot recognises a poll or prediction payload without its event type', () => {
    const t = setup();
    assert.deepEqual([payloadSnapshot('poll', t.pollEvent('completed', [4, 4, 1]), NOW)!.status, payloadSnapshot('poll', t.pollEvent(null, [1, 0, 0]), NOW)!.status,
        payloadSnapshot('poll', { ...t.pollEvent(null, [0, 0, 0]), choices: t.pollEvent(null, [0, 0, 0]).choices.map(({ votes: _votes, ...choice }) => choice) }, NOW)!.status],
        ['ended', 'active', 'active']);
    assert.deepEqual([payloadSnapshot('prediction', t.prediction({ status: 'resolved', winning_outcome_id: 'o1', ended_at: t.iso(0) }), NOW)!.winnerId,
        payloadSnapshot('prediction', t.prediction({ locked_at: t.iso(0) }), NOW)!.status, payloadSnapshot('prediction', t.prediction({ locks_at: t.iso(60_000) }), NOW)!.status],
        ['o1', 'locked', 'active']);
    // A chat message, a poll payload asked as a prediction, and junk are not seeds.
    for (const payload of [{ chatter_user_id: '1', message: { text: '!votes' } }, null, 'x', { choices: 'no' }, { choices: [{ id: 'a' }] }]) assert.equal(payloadSnapshot('poll', payload, NOW), null);
    assert.equal(payloadSnapshot('prediction', t.pollEvent('completed', [4, 4, 1]), NOW), null);
});

test('prediction notifications: locked, resolved with a winner, canceled', async () => {
    const t = setup({ fed: true });
    assert.equal((await noteInteractionEvent('1', 'channel.prediction.progress', t.prediction({ locks_at: t.iso(60_000) }), t.deps))!.endsAt, NOW + 60_000);
    assert.equal((await noteInteractionEvent('1', 'channel.prediction.lock', t.prediction({ locked_at: t.iso(0) }), t.deps))!.status, 'locked');
    const resolved = await noteInteractionEvent('1', 'channel.prediction.end', t.prediction({ status: 'resolved', winning_outcome_id: 'o2', ended_at: t.iso(0) }), t.deps);
    assert.deepEqual([resolved!.status, resolved!.winnerId, resolved!.options[0].value, resolved!.options[0].users], ['ended', 'o2', 900, 3]);
    const other = setup({ fed: true });
    assert.equal((await noteInteractionEvent('1', 'channel.prediction.end', other.prediction({ status: 'canceled', ended_at: other.iso(0) }), other.deps))!.status, 'canceled');
});

test('cancel.poll: marked before Twitch answers, per poll, and unmarked when Twitch refuses', async () => {
    const t = setup({ fed: true });
    await noteInteractionEvent('1', 'channel.poll.progress', t.pollEvent(null, [2, 2, 0]), t.deps);
    await markPollCanceled('1', 'poll-1', t.deps);
    // The end notification arrives first (before the PATCH answer): it is already canceled.
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('terminated', [2, 2, 0]), t.deps))!.status, 'canceled');
    assert.equal((await readInteraction('1', 'poll', t.deps)).status, 'canceled');
    // A Twitch read sees it too.
    await forgetInteraction('1', 'poll', t.deps);
    t.state.poll = t.twitchPoll('TERMINATED', [2, 2, 0]);
    assert.equal((await readInteraction('1', 'poll', t.deps)).status, 'canceled');
    // Canceling a later poll does not forget the earlier one, and a poll ended early by hand is a result.
    await markPollCanceled('1', 'poll-3', t.deps);
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('archived', [2, 2, 0]), t.deps))!.status, 'canceled');
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('terminated', [2, 1, 0], 'poll-2', 5_000), t.deps))!.status, 'ended');
    // Twitch refused the cancellation: the poll keeps its result, also when its end notification
    // already arrived while it was marked (the snapshot that says "canceled" is dropped).
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('completed', [2, 1, 0], 'poll-3', 9_000), t.deps))!.status, 'canceled');
    await unmarkPollCanceled('1', 'poll-3', t.deps);
    t.state.poll = t.twitchPoll('COMPLETED', [2, 1, 0], { id: 'poll-3' });
    assert.deepEqual([(await readInteraction('1', 'poll', t.deps)).status, (await readInteraction('1', 'poll', t.deps)).id], ['ended', 'poll-3']);
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('archived', [2, 1, 0], 'poll-3', 9_000), t.deps))!.status, 'ended');
});

test('creating a poll drops the snapshot', async () => {
    const t = setup({ fed: true }); t.state.poll = t.twitchPoll('COMPLETED', [3, 1, 0]);
    await readInteraction('1', 'poll', t.deps);
    await forgetInteraction('1', 'poll', t.deps);
    t.state.poll = t.twitchPoll('ACTIVE', [0, 0, 0], { id: 'poll-2' });
    assert.equal((await readInteraction('1', 'poll', t.deps)).id, 'poll-2');
    assert.equal(t.calls.poll, 2);
});

test('with the cache down every read goes to Twitch and still answers', async () => {
    const t = setup({ fed: true }); t.state.poll = t.twitchPoll('ACTIVE', [1, 2, 3]);
    t.state.cacheDown = true;
    assert.equal((await readInteraction('1', 'poll', t.deps)).options[2].value, 3);
    await readInteraction('1', 'poll', t.deps);
    assert.equal(t.calls.poll, 2);
    assert.equal((await noteInteractionEvent('1', 'channel.poll.end', t.pollEvent('completed', [1, 2, 3]), t.deps))!.status, 'ended');
});

test('leaders and option lookup', () => {
    const t = setup();
    const snapshot = pollSnapshot(t.twitchPoll('COMPLETED', [5, 5, 2]), NOW)!;
    assert.deepEqual(leaders(snapshot).map(option => option.title), ['Nuke', 'Mirage']);
    assert.deepEqual(leaders(pollSnapshot(t.twitchPoll('COMPLETED', [0, 0, 0]), NOW)!).length, 3);
    assert.deepEqual(leaders(pollSnapshot(t.twitchPoll('COMPLETED', [1, 7, 2]), NOW)!).map(option => option.title), ['Mirage']);
    assert.equal(findOption(snapshot, 'mirage')!.id, 'c2');
    assert.equal(findOption(snapshot, ' 3 ')!.title, 'Inferno');
    assert.equal(findOption(snapshot, '4'), null);
    assert.equal(findOption(snapshot, 'Dust'), null);
    assert.equal(findOption(snapshot, ''), null);
    // A title that is a number wins over the position.
    const numbered = pollSnapshot({ id: 'p', status: 'ACTIVE', choices: [{ id: 'a', title: '2', votes: 9 }, { id: 'b', title: '1', votes: 4 }] }, NOW)!;
    assert.equal(findOption(numbered, '2')!.id, 'a');
});
