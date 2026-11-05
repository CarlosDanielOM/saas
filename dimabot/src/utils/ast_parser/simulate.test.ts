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

test('literal argument binding and syntax problem detection', async () => {
    const result = await simulateCommand(parseSimulationInput({ body: '*( &p1 == "" ? "EMPTY" : "GOT ${&p1}" )', runs: [{}, { argument: 'big cat' }] }));
    assert.deepEqual(result.runs.map((run) => run.reply), ['EMPTY', 'GOT big']);
    const unknown = await simulateCommand(parseSimulationInput({ body: '$(urlfetch https://example.com)' }));
    assert.match(unknown.runs[0].problems[0], /Unknown function: urlfetch/);
    const broken = await simulateCommand(parseSimulationInput({ body: '*(1 == 1 ? "a" : "b"' }));
    assert.ok(broken.runs[0].problems.length > 0);
    assert.deepEqual(findProblems('Hello Sam! You survived: 5 of 6.'), []);
});

test('shoutout guard models explicit targets without verifying Twitch accounts', async () => {
    const body = `*($(twitch.channel &t) ? $(announcement purple "Check out ${'${$(twitch.channel &t)}'} at https://twitch.tv/${'${$(twitch.login &t)}'} and give them a follow! They were last playing ${'${$(twitch.game &t)}'}") : "Please provide a valid user to shoutout. Usage: !so <username>") *($(twitch.channel &t) ? $(shoutout &t) : "") *($(twitch.channel &t) ? $(show.clip &t) : "")`;
    const result = await simulateCommand(parseSimulationInput({body, runs: [{}, {argument:'Alice'}, {argument:'bad!'}, {argument:'two words'}, {argument:'$(ban bob)'}, {argument:'Alice', targetLookup:'not_found'}]}));
    assert.deepEqual(result.runs.map(r => r.actions.length), [0, 3, 0, 0, 0, 0]);
    assert.match(result.runs[0].reply, /Please provide a valid user/);
    assert.match(result.runs[1].actions[0].args.join(' '), /alice/);
    assert.equal(result.runs[1].samples[0].lookup, 'simulated_found');
    assert.equal(result.runs[5].samples[0].lookup, 'simulated_not_found');
    assert.deepEqual(result.runs[0].samples[0].args, ['']);
    assert.deepEqual(outbound, []);
});

test('own channel versus explicit empty target and literal argument indices', async () => {
    const result = await simulateCommand(parseSimulationInput({body:'$(twitch.channel)|$(twitch.login &p1)|&p1|&p2|$(twitch.channel &t)|&t', runs:[{}, {argument:'Alice bob'}, {argument:'$(ban bob)'}]}));
    assert.equal(result.runs[0].reply, 'YourChannel|||||');
    assert.match(result.runs[1].reply, /YourChannel\|alice\|Alice\|bob\|\|/);
    assert.deepEqual(result.runs[2].actions, []);
    const literal = await simulateCommand(parseSimulationInput({ body: '&t', runs: [{ argument: '$(ban bob)' }] }));
    assert.equal(literal.runs[0].reply, '$(ban bob)');
    assert.deepEqual(literal.runs[0].actions, []);
});

test('signed count arguments and quoted bound variables match authored command semantics', async () => {
    const count = await simulateCommand(parseSimulationInput({body:'$(count &p1)', runs:[{argument:'10'}, {argument:'-3'}]}));
    assert.deepEqual(count.runs.map(r=>r.reply), ['10','7']);
    const quoted = await simulateCommand(parseSimulationInput({body:'*( "&p1" == "" ? "EMPTY" : "GOT" )', runs:[{}, {argument:'hello'}]}));
    assert.deepEqual(quoted.runs.map(r=>r.reply), ['GOT','GOT']);
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
