import assert from 'node:assert/strict';
import test from 'node:test';

// The command engine loads the whole function registry; importing it needs a key, never a real one.
process.env.SECRET_KEY ??= 'site-agent-effects-test-only';
// Any network call during a dry run is a bug.
const outbound: string[] = [];
globalThis.fetch = (async (input: unknown) => {
    outbound.push(String(input));
    throw new Error('network is not allowed in command tests');
}) as typeof fetch;

const { describeCommandEffects } = await import('./effects.js');

const en = (body: string, plan: 'free' | 'premium' | 'pro' = 'premium') => describeCommandEffects(body, { plan, lang: 'en' });
const es = (body: string, plan: 'free' | 'premium' | 'pro' = 'premium') => describeCommandEffects(body, { plan, lang: 'es' });

test('moderation: timeouts vs bans, including branches that need an argument or luck', async () => {
    assert.deepEqual(await en('$(ban $(user) 60)'), { effects: ['Can time out viewers'], problems: [] });
    assert.deepEqual(await en('$(ban &p1)'), { effects: ['Can ban viewers'], problems: [] });
    // Only runs when an argument is typed.
    assert.deepEqual((await en('*(&p1 ? $(ban &p1 600) : "Usage: !to name")')).effects, ['Can time out viewers']);
    // Russian roulette: 1 in 6, found over several dry runs.
    const roulette = await en('%(roll $(random 6)) *(%(roll) == 0 ? $(ban $(user) 60) : "") *(%(roll) == 0 ? "${$(user)} died!" : "${$(user)} survived!")');
    assert.deepEqual(roulette.effects, ['Can time out viewers']);
    assert.deepEqual((await es('$(ban $(user) 60)')).effects, ['Puede dar timeout a espectadores']);
});

test('stream and Twitch actions in plain words, most important first, deduplicated', async () => {
    const result = await en('#(hug &p1) $(tts $(user) says: &t) $(set.title "New title") $(set.game Just Chatting) $(announce hi) $(announce again)');
    assert.deepEqual(result.effects, ['Changes the stream title', 'Changes the stream category', 'Posts announcements in chat', 'Speaks on stream with TTS', 'Runs other commands: !hug']);
    assert.deepEqual(result.problems, []);
    const spanish = await es('$(tts $(user) dice: &t) $(set.title "Nuevo")');
    assert.deepEqual(spanish.effects, ['Cambia el título del stream', 'Habla en el stream con TTS']);
    const more = await en('$(roulette.start) $(overlay.skip) $(widget.signal eat 1) $(pin.create hi) $(raid somebody) $(start.poll "Best?" a b) $(trigger.send boom) $(create.clip)');
    for (const line of ['Can start or cancel a raid', 'Can start, end or cancel polls', 'Pins or unpins chat messages', 'Creates clips',
        'Plays triggers (sounds, videos, images) on stream', 'Can skip, pause, resume or clear overlay alerts', 'Sends signals to Overlay Studio widgets', 'Changes, shows or spins roulettes']) {
        assert.ok(more.effects.includes(line), line);
    }
    assert.ok(more.effects.indexOf('Can start or cancel a raid') < more.effects.indexOf('Pins or unpins chat messages'));
});

test('reads, text and pacing are not effects; AI and later actions are', async () => {
    assert.deepEqual(await en('Hello $(user)! $(upper hi) $(random 1-6) $(twitch.game) $(delay 1)'), { effects: [], problems: [] });
    assert.deepEqual((await en('$(ai "say hi to $(user)")')).effects, ['Writes replies with AI (uses AI credits)']);
    // The scheduled body is not dry-run, but actions written in it are still listed (safety net).
    assert.deepEqual((await en('$(timer 60 "$(ban x)")')).effects, ['Can ban viewers', 'Schedules messages or actions for later (the test run does not check them)']);
    assert.deepEqual((await en('$(bot.mode attack)')).effects, ['Can switch Follow Defense to attack mode']);
});

test('safety net: an action behind a rare random branch is always listed', async () => {
    // Without the static scan this 1-in-1000 branch would almost never run in the dry runs.
    for (let i = 0; i < 5; i++) {
        assert.deepEqual((await en('*($(random 1000) == 7 ? $(ban $(user) 60) : "safe")')).effects, ['Can time out viewers']);
    }
    assert.deepEqual((await en('$(upper hi) $(random 5)')).effects, [], 'pure functions are never effects');
});

test('problems: unknown functions, plan-gated functions, empty or whole-line bodies, nothing happens', async () => {
    assert.deepEqual((await en('$(nope 1)')).problems, ['[Unknown function: nope]']);
    const pet = await en('$(pet.talk hello)', 'free');
    assert.deepEqual(pet.effects, ['Makes the pet talk on stream']);
    assert.deepEqual(pet.problems, ['pet.talk needs Premium or Pro; on this plan it does nothing.']);
    assert.deepEqual((await es('$(pet.talk hola)', 'free')).problems, ['pet.talk necesita Premium o Pro; con este plan no hace nada.']);
    assert.deepEqual((await en('$(pet.talk hello)', 'premium')).problems, []);
    assert.deepEqual(await en('  '), { effects: [], problems: ['The reply is empty.'] });
    assert.deepEqual(await es(''), { effects: [], problems: ['La respuesta está vacía.'] });
    assert.match((await en('!cc test hi')).problems[0], /not the whole !cc/);
    assert.deepEqual((await en('*(&p1 ? "yes" : "")')).problems, []);
    assert.deepEqual((await en('$(tts &t) &p1')).problems, ['[Parser error: cannot create new &pN after &t]']);
});

test('nothing reached the network', () => {
    assert.deepEqual(outbound, []);
});
