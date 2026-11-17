import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTION_READ_FUNCTIONS, INTERACTION_READS, registerInteractionFunctions, runSnapshot } from './interaction.functions.js';
import { fillLabels } from './roulette.functions.js';
import { getAllRegisteredFunctions, createExecutionContext, evaluate, registerFunction } from '../evaluator.js';
import { parse } from '../parser.js';
import type { InteractionSnapshot, InteractionStatus } from '../../twitch_interactions.js';

const poll = (votes: number[], status: InteractionStatus = 'ended'): InteractionSnapshot => ({
    kind: 'poll', id: 'p1', title: 'Best map?', status, winnerId: null, startedAt: 0, endsAt: null, at: 0,
    options: ['Nuke', 'Mirage', 'Taco Bell'].map((title, index) => ({ id: `c${index}`, title, value: votes[index], users: 0 }))
});
const prediction = (status: InteractionStatus, winnerId: string | null = null): InteractionSnapshot => ({
    kind: 'prediction', id: 'x1', title: 'Will we win?', status, winnerId, startedAt: 0, endsAt: null, at: 0,
    options: [{ id: 'o1', title: 'Yes', value: 6400, users: 18 }, { id: 'o2', title: 'No', value: 3600, users: 7 }]
});
const none: InteractionSnapshot = { kind: 'poll', id: '', title: '', status: 'none', options: [], winnerId: null, startedAt: 0, endsAt: null, at: 0 };
const P = INTERACTION_READS.poll, X = INTERACTION_READS.prediction;

test('poll reads: options, values, votes, total, title, status', () => {
    const snapshot = poll([5, 5, 2], 'active');
    assert.equal(P.options(snapshot, ''), '["Nuke","Mirage","Taco Bell"]');
    assert.equal(P.values(snapshot, ''), '[5,5,2]');
    assert.equal(P.total(snapshot, ''), '12');
    assert.equal(P.title(snapshot, ''), 'Best map?');
    assert.equal(P.status(snapshot, ''), 'active');
    assert.equal(P.votes(snapshot, 'Taco Bell'), '2');
    assert.equal(P.votes(snapshot, 'nuke'), '5');
    assert.equal(P.votes(snapshot, '2'), '5');
    assert.equal(P.votes(snapshot, 'Dust'), '');
    assert.equal(P.votes(snapshot, ''), '');
});

test('poll.result and poll.tied: leader, tie, nobody voted, canceled, nothing to read', () => {
    assert.equal(P.result(poll([1, 7, 2]), ''), 'Mirage');
    assert.equal(P.tied(poll([1, 7, 2]), ''), '');
    assert.equal(P.result(poll([5, 5, 2]), ''), '');
    assert.equal(P.tied(poll([5, 5, 2]), ''), '["Nuke","Mirage"]');
    // While it runs: the current leader / current tie.
    assert.equal(P.result(poll([3, 1, 0], 'active'), ''), 'Nuke');
    assert.equal(P.tied(poll([3, 3, 3], 'active'), ''), '["Nuke","Mirage","Taco Bell"]');
    // Nobody voted: every option is tied and the total says why.
    assert.equal(P.tied(poll([0, 0, 0]), ''), '["Nuke","Mirage","Taco Bell"]');
    assert.equal(P.total(poll([0, 0, 0]), ''), '0');
    // Canceled keeps its numbers and has no result.
    assert.equal(P.result(poll([1, 7, 2], 'canceled'), ''), '');
    assert.equal(P.tied(poll([5, 5, 2], 'canceled'), ''), '');
    assert.equal(P.values(poll([5, 5, 2], 'canceled'), ''), '[5,5,2]');
    for (const name of ['title', 'options', 'values', 'result', 'tied']) assert.equal(P[name](none, ''), '', name);
    assert.equal(P.total(none, ''), '0');
    assert.equal(P.status(none, ''), 'none');
    assert.equal(P.votes(none, 'Nuke'), '');
});

test('prediction reads', () => {
    const running = prediction('locked');
    assert.equal(X.options(running, ''), '["Yes","No"]');
    assert.equal(X.values(running, ''), '[6400,3600]');
    assert.equal(X.total(running, ''), '10000');
    assert.equal(X.points(running, 'no'), '3600');
    assert.equal(X.users(running, '1'), '18');
    assert.equal(X.users(running, ''), '');
    assert.equal(X.status(running, ''), 'locked');
    assert.equal(X.result(running, ''), '');
    assert.equal(X.result(prediction('ended', 'o2'), ''), 'No');
    assert.equal(X.result(prediction('canceled', 'o2'), ''), '');
    assert.equal(X.result(prediction('ended', null), ''), '');
});

test('every read is registered with metadata and Spanish keywords', () => {
    registerInteractionFunctions();
    const registered = new Map(getAllRegisteredFunctions().map(entry => [entry.name, entry.metadata]));
    assert.equal(INTERACTION_READ_FUNCTIONS.length, 16);
    for (const name of INTERACTION_READ_FUNCTIONS) {
        const metadata = registered.get(name);
        assert.ok(metadata, name);
        assert.equal(metadata!.category, 'channel');
        assert.equal(metadata!.minUserLevel, 1);
        assert.ok(metadata!.syntax.startsWith(name), name);
        assert.ok(metadata!.examples.length > 0 && metadata!.description.length > 20, name);
        assert.ok(!metadata!.destructive, name);
    }
});

test('list values work as conditions, loop lists and roulette.fill input in the engine', async () => {
    const calls: unknown[][] = [];
    let tied = P.tied(poll([5, 5, 2]), '');
    registerFunction('test.tied', async () => tied);
    registerFunction('test.votes', async args => P.votes(poll([5, 5, 2]), args.map(String).join(' ')));
    registerFunction('test.fill', async args => { calls.push(fillLabels(args.slice(1))); return ''; });
    const run = async (input: string) => {
        const { ast, error } = parse(input);
        assert.equal(error, undefined, input);
        return (await evaluate(ast, createExecutionContext())).value;
    };
    assert.equal(await run('*($(test.tied) ? "tie" : "winner")'), 'tie');
    assert.equal(await run('*(for #o in $(test.tied) { %(seen[] $(test.votes #o)) })%(seen)'), '["5","5"]');
    await run('$(test.fill polls $(test.tied))');
    await run('$(test.fill polls "Taco Bell" Pizza)');
    await run('$(test.fill polls %[red, green])');
    await run('%(names[] Ana)%(names[] Luis)$(test.fill polls %(names))');
    tied = P.tied(poll([1, 7, 2]), '');
    assert.equal(await run('*($(test.tied) ? "tie" : "winner")'), 'winner');
    await run('$(test.fill polls $(test.tied))');
    assert.deepEqual(calls, [['Nuke', 'Mirage'], ['Taco Bell', 'Pizza'], ['red', 'green'], ['Ana', 'Luis'], []]);
});

test('fillLabels: lists, loose labels, blanks, labels that look like JSON', () => {
    assert.deepEqual(fillLabels(['["a","b"]']), ['a', 'b']);
    assert.deepEqual(fillLabels([['a', ' b ']]), ['a', 'b']);
    assert.deepEqual(fillLabels(['a', 'b c']), ['a', 'b c']);
    assert.deepEqual(fillLabels(['']), []);
    assert.deepEqual(fillLabels(['[]']), []);
    assert.deepEqual(fillLabels(['[5,5,2]']), ['5', '5', '2']);
    assert.deepEqual(fillLabels(['[not json']), ['[not json']);
    assert.deepEqual(fillLabels(['["a", null, ""]']), ['a']);
});

test('one snapshot per command run; a poll chat event answers from its own numbers', async () => {
    registerInteractionFunctions();
    const event = { id: 'ended-poll', broadcaster_user_id: '1', title: 'Dinner?', started_at: '2026-11-17T19:59:00Z', status: 'completed', ended_at: '2026-11-17T20:00:00Z',
        choices: [{ id: 'a', title: 'Pizza', votes: 4 }, { id: 'b', title: 'Tacos al pastor', votes: 4 }, { id: 'c', title: 'Sushi', votes: 1 }] };
    // The "Poll ended" script: no Twitch or cache read is needed, the event is the snapshot.
    const context = createExecutionContext({ broadcasterId: '1', eventData: event, eventsubData: { type: 'channel.poll.end' } });
    const run = async (input: string, ctx = context) => {
        const { ast, error } = parse(input);
        assert.equal(error, undefined, input);
        return String((await evaluate(ast, ctx)).value);
    };
    const values: string[] = [];
    for (const call of ['poll.title', 'poll.status', 'poll.total', 'poll.result', 'poll.tied', 'poll.votes $(poll.result)']) values.push(await run(`$(${call})`));
    assert.deepEqual(values, ['Dinner?', 'ended', '9', '', '["Pizza","Tacos al pastor"]', '']);
    const first = await runSnapshot(context, 'poll');
    assert.equal(first.id, 'ended-poll');
    // Every copy of the context made while evaluating shares the same snapshot object.
    assert.equal(await runSnapshot({ ...context }, 'poll'), first);
    assert.equal(await run('*(for #o in $(poll.tied) { %(seen[] #o) })%(seen)'), '["Pizza","Tacos al pastor"]');
    // The memo is what answers, even if the event data is replaced mid-run.
    context.eventData = { ...event, choices: [{ id: 'a', title: 'Pizza', votes: 9 }, { id: 'b', title: 'Tacos al pastor', votes: 1 }] };
    assert.equal(await run('$(poll.result)'), '');
    // A new run starts fresh.
    const next = createExecutionContext({ broadcasterId: '1', eventData: context.eventData, eventsubData: { type: 'channel.poll.end' } });
    assert.equal(await run('$(poll.result)', next), 'Pizza');
    // A command referenced from the chat event with #(name) carries the payload only (plus who it is for).
    const referenced = createExecutionContext({ broadcasterId: '1', eventsubData: {}, eventData: { ...event, chatter_user_id: '1', chatter_user_login: 'streamer' } });
    assert.equal(await run('$(poll.tied)', referenced), '["Pizza","Tacos al pastor"]');
    // Another kind of chat event (a follow) never seeds from its payload.
    const follow = createExecutionContext({ broadcasterId: '', eventsubData: { type: 'channel.follow' }, eventData: event });
    assert.equal(await run('$(poll.status)', follow), 'unavailable');
    // A prediction event does not seed poll functions, and the other way round.
    const prediction = createExecutionContext({ broadcasterId: '1', eventsubData: { type: 'channel.prediction.end' }, eventData: { id: 'p', broadcaster_user_id: '1', title: 'Win?',
        started_at: '2026-11-17T19:59:00Z', status: 'resolved', ended_at: '2026-11-17T20:00:00Z', winning_outcome_id: 'o1',
        outcomes: [{ id: 'o1', title: 'Yes', users: 3, channel_points: 900 }, { id: 'o2', title: 'No', users: 1, channel_points: 100 }] } });
    const outcome: string[] = [];
    for (const call of ['prediction.result', 'prediction.points Yes', 'prediction.users 2', 'prediction.status']) outcome.push(await run(`$(${call})`, prediction));
    assert.deepEqual(outcome, ['Yes', '900', '1', 'ended']);
});
