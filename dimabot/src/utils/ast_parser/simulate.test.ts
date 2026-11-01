import test from 'node:test';
import assert from 'node:assert/strict';

// Any network call during a test run is a bug: the tester must never reach Twitch, MiniMax, or the overlay.
const outbound: string[] = [];
globalThis.fetch = (async (input: unknown) => {
    outbound.push(String(input));
    throw new Error('network is not allowed in command tests');
}) as typeof fetch;

const { simulateCommand, parseSimulationInput, SimulationInputError, findProblems } = await import('./simulate.js');

test('Russian roulette: real randomness, timeouts recorded (not performed) for the player only', async () => {
    const body = '%(roll $(random 6)) *(%(roll) == 0 ? $(ban $(user) 60) : "") *(%(roll) == 0 ? "${$(user)} died!" : "${$(user)} survived!")';
    const result = await simulateCommand(parseSimulationInput({ body, runs: [{ user: 'Sam' }], repeat: 50 }));
    const died = result.outcomes!.find((outcome) => outcome.replies[0] === 'Sam died!');
    const survived = result.outcomes!.find((outcome) => outcome.replies[0] === 'Sam survived!');
    assert.ok(died && survived, 'both outcomes happen in 50 tries');
    assert.deepEqual(died.actions, ['ban(Sam, 60)']);
    assert.deepEqual(survived.actions, []);
    assert.equal(died.times + survived.times, 50);
    assert.ok(died.times < 25, 'about 1 in 6, not half');
    for (const run of result.runs) assert.deepEqual(run.problems, []);
});

test('per-viewer counter: cache variables persist across runs for the same viewer only', async () => {
    const body = '%(##hicount *(%(##hicount) + 1)) You have said hi %(##hicount) *(%(##hicount) == 1 ? "time" : "times")!';
    const result = await simulateCommand(parseSimulationInput({ body, runs: [{ user: 'Sam' }, { user: 'Sam' }, { user: 'Alex' }] }));
    assert.deepEqual(result.runs.map((run) => run.reply), ['You have said hi 1 time!', 'You have said hi 2 times!', 'You have said hi 1 time!']);
});

test('multi-command setup: a saved voice from !voice is used by !s for that viewer only (Premium)', async () => {
    const voice = '%(**voice &p1) Voice saved: &p1';
    const speech = '*(^(**voice) ? $(tts.clone "${%(**voice)}" $(user) dice: &t) : $(tts $(user) dice: &t))';
    const result = await simulateCommand(parseSimulationInput({
        body: voice,
        runs: [{ user: 'Sam', argument: 'gojo' }, { body: speech, user: 'Sam', argument: 'hello' }, { body: speech, user: 'Alex', argument: 'hi' }],
    }));
    assert.equal(result.runs[0].reply, 'Voice saved: gojo');
    assert.equal(result.runs[1].actions[0]?.function, 'tts.clone', JSON.stringify(result.runs[1].actions));
    assert.equal(result.runs[1].actions[0].args[0], 'gojo');
    assert.match(result.runs[1].actions[0].args.slice(1).join(' '), /Sam dice ?: hello/);
    assert.deepEqual(result.runs[2].actions.map((call) => call.function), ['tts']);
    assert.equal(result.variables['viewer sam:voice'], 'gojo');
});

test('database variables follow plan rules: Free cannot write them', async () => {
    const body = '%(**voice gojo) saved %(**voice)';
    const premium = await simulateCommand(parseSimulationInput({ body, plan: 'premium' }));
    const free = await simulateCommand(parseSimulationInput({ body, plan: 'free' }));
    assert.equal(premium.runs[0].reply, 'saved gojo');
    assert.notEqual(free.runs[0].reply, 'saved gojo');
});

test('flags syntax problems: unquoted empty argument, unknown function, parse errors', async () => {
    const unquoted = await simulateCommand(parseSimulationInput({ body: '*( &p1 == "" ? "EMPTY" : "GOT &p1" )' }));
    assert.match(unquoted.runs[0].problems.join(' '), /printed as text/);
    const quoted = await simulateCommand(parseSimulationInput({ body: '*( "&p1" == "" ? "EMPTY" : "GOT &p1" )', runs: [{}, { argument: 'big cat' }] }));
    assert.deepEqual(quoted.runs.map((run) => run.reply), ['EMPTY', 'GOT big']);
    assert.deepEqual(quoted.runs.flatMap((run) => run.problems), []);
    const unknown = await simulateCommand(parseSimulationInput({ body: '$(urlfetch https://example.com)' }));
    assert.match(unknown.runs[0].problems[0], /Unknown function: urlfetch/);
    const broken = await simulateCommand(parseSimulationInput({ body: '*(1 == 1 ? "a" : "b"' }));
    assert.ok(broken.runs[0].problems.length > 0, 'unclosed expression is reported');
    assert.deepEqual(findProblems('Hello Sam! You survived: 5 of 6.'), [], 'ordinary text is not flagged');
});

test('reads use sample values; actions are recorded; timers and delays never run', async () => {
    const body = 'Playing $(twitch.game) for $(twitch.viewers). $(chat.send "hi chat") $(trigger.send airhorn) $(delay 30) $(timer 60 $(chat.send later)) $(set.title "New title")';
    const started = Date.now();
    const result = await simulateCommand(parseSimulationInput({ body, runs: [{ role: 'mod' }] }));
    assert.ok(Date.now() - started < 3000, 'delay did not wait');
    const run = result.runs[0];
    assert.equal(run.reply, 'Playing Just Chatting for 42.');
    assert.deepEqual(run.samples.map((call) => call.function), ['twitch.game', 'twitch.viewers']);
    assert.deepEqual(run.actions.map((call) => call.function), ['chat.send', 'trigger.send', 'delay', 'timer', 'set.title']);
    assert.deepEqual(run.actions.find((call) => call.function === 'set.title')!.args, ['New title']);
});

test('command references are reported, not run; the use count is tracked', async () => {
    const result = await simulateCommand(parseSimulationInput({ body: 'Uses: $(count 1) #(socials)', runs: [{}, {}] }));
    assert.deepEqual(result.runs.map((run) => run.reply), ['Uses: 1', 'Uses: 2']);
    assert.deepEqual(result.runs[0].commandReferences, ['#(socials)']);
    assert.equal(result.useCount, 2);
});

test('input checks: body required, !cc lines rejected, bounds applied', () => {
    assert.throws(() => parseSimulationInput({}), SimulationInputError);
    assert.throws(() => parseSimulationInput({ body: '!cc -cd=5 hi Hello' }), /only the response body/);
    assert.throws(() => parseSimulationInput({ body: 'x', runs: [{ body: '!ec hi Hello' }] }), SimulationInputError);
    const parsed = parseSimulationInput({ body: 'hi', repeat: 999, runs: Array.from({ length: 30 }, () => ({})), plan: 'gold' });
    assert.equal(parsed.repeat, 50);
    assert.equal(parsed.runs!.length, 10);
    assert.equal(parsed.plan, 'premium');
});

test('nothing reached the network during any test', () => {
    assert.deepEqual(outbound, []);
});
