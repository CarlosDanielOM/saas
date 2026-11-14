import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SECRET_KEY ??= 'tool-test-secret';

const { checkSafeBody, findUnsafe, SAFE_FUNCTIONS } = await import('./safe_body.js');
const { EFFECT_FUNCTION_NAMES } = await import('./effects.js');
const { getAstCatalog } = await import('../../utils/ai/ast_catalog/index.js');

const refused = (text: string) => {
    const result = checkSafeBody(text);
    assert.equal(result.ok, false, `expected refusal: ${text}`);
    return (result as { reason: string }).reason;
};

test('plain replies, names, random, counters, math, text helpers, variables and Twitch reads pass', () => {
    for (const body of [
        '',
        'Hello chat!',
        '$(user) rolled $(random 6)',
        '$(user) hugs $(touser) ($(count) hugs so far)',
        '%(#wins *(%(#wins) + 1)) $(user) has %(#wins) wins',
        '*(%(#wins) > 3 ? $(upper champion) : $(lower rookie))',
        '%(**score($(user)) 7) %(**score($(touser)))',
        '$(twitch.title) · $(twitch.game) · $(followage $(user))',
        'Thanks for the raid $(raid.channel), welcome $(raid.viewers) raiders!',
        '$(user) cheered $(cheer.amount): $(cheer.message)',
        '$(replace "hi" "hello" $(trim  hi there ))',
        '%(list %[a, b, c]) %(list[random]) %(list[].length)',
        '^(#seen) %del(#seen)',
        // Safe twins of the refused constructs below, so those are refused for the function, not the syntax.
        '%(#msg "hi ${$(user)}")',
        '*(for #i = 0; #i < 3; #i++ { $(random 3) })',
        '%(list %[a, $(user)]) %(list[$(random 2)])',
    ]) {
        assert.deepEqual(checkSafeBody(body), { ok: true }, body);
    }
});

test('dangerous functions are refused, also hidden in nested arguments, both branches, templates, loops, arrays and selectors', () => {
    assert.match(refused('$(ban $(touser) 60)'), /\$\(ban\): can ban viewers/);
    assert.match(refused('$(upper $(lower $(trim $(tts $(user) says hi))))'), /\$\(tts\)/);
    assert.match(refused('*(1 == 1 ? ok : $(ban $(user)))'), /\$\(ban\)/, 'else branch');
    assert.match(refused('*(%(#x) == 1 ? $(raid someone) : ok)'), /\$\(raid\)/, 'then branch');
    assert.match(refused('*($(set.title gotcha) == 1 ? a : b)'), /\$\(set\.title\)/, 'condition');
    assert.match(refused('%(#msg "hi ${$(clear.chat)}")'), /\$\(clear\.chat\)/, 'template');
    assert.match(refused('*(for #i = 0; #i < 3; #i++ { $(chat.send spam) })'), /\$\(chat\.send\)/, 'loop body');
    assert.match(refused('%(list %[a, $(add.vip $(user))])'), /\$\(add\.vip\)/, 'array item');
    assert.match(refused('%(list[$(trigger.send boom)])'), /\$\(trigger\.send\)/, 'index');
    assert.match(refused('%(**score($(unmod someone)))'), /\$\(unmod\)/, 'viewer selector');
    assert.match(refused('%(x $(timer 60 $(ban $(user))))'), /\$\(timer\)/, 'scheduling');
    assert.match(refused('$(user) $(ai say something)'), /\$\(ai\)/);
    assert.match(refused('$(delay 5) hi'), /\$\(delay\)/);
    assert.match(refused('$(disable.command dice)'), /\$\(disable\.command\)/);
    assert.match(refused('$(goal.add 5)'), /\$\(goal\.add\)/);
    assert.match(refused('$(roulette.start)'), /\$\(roulette\.start\)/);
    assert.match(refused('$(widget.signal boom)'), /\$\(widget\.signal\)/);
    assert.match(refused('$(pet.talk hi)'), /\$\(pet\.talk\)/);
    assert.match(refused('$(overlay.skip)'), /\$\(overlay\.skip\)/);
    assert.match(refused('hi #(other)'), /#\(other\) runs another command/);
    assert.match(refused('$(upper #(other))'), /runs another command/);
    assert.match(refused('$(nosuchfn)'), /not a known function/);
    assert.match(refused('$(USER)'), /\$\(USER\)/, 'names match exactly, like the evaluator');
    assert.match(refused('$(BAN x)'), /moderates chat/);
    assert.match(refused('$(user'), /never closed/);
    assert.match(refused('$(user "x)'), /never closed|does not parse/);
});

test('unsupported syntax is refused', () => {
    assert.match(findUnsafe({ type: 'root', children: [{ type: 'custom', customType: 'x', data: null }] } as never)!, /can't be checked/);
});

test('the allowlist is made of real registry functions and never of an action FUNCTION_EFFECTS lists', () => {
    const catalog = getAstCatalog().entries;
    const names = new Set(catalog.flatMap((entry) => [entry.name, ...entry.aliases]));
    for (const name of Object.keys(SAFE_FUNCTIONS)) assert.ok(names.has(name), `${name} is not a registered function`);
    for (const name of EFFECT_FUNCTION_NAMES) assert.equal(Object.hasOwn(SAFE_FUNCTIONS, name), false, name);
    // Every registered function outside the allowlist is refused, with a reason.
    for (const name of names) {
        if (Object.hasOwn(SAFE_FUNCTIONS, name)) continue;
        assert.ok(refused(`$(${name} x)`).length > 0, name);
        const entry = catalog.find((item) => item.name === name || item.aliases.includes(name))!;
        assert.equal(entry.destructive && Object.hasOwn(SAFE_FUNCTIONS, name), false);
    }
    for (const entry of catalog) if (entry.destructive) assert.equal(Object.hasOwn(SAFE_FUNCTIONS, entry.name), false, entry.name);
});

// Review 2026-11-14 (P1): the guard must see exactly what the renderer runs. The renderer scans top-level
// expressions regardless of quotes (render.ts scanSourceSegments), so quotes outside an expression hide nothing.
test('quotes, arrays and escapes outside an expression hide nothing from the guard', () => {
    assert.match(refused('"$(add.mod attacker)"'), /\$\(add\.mod\)/);
    assert.match(refused("'$(ban $(user))'"), /\$\(ban\)/);
    assert.match(refused('say "hi $(ban x)" now'), /\$\(ban\)/);
    assert.match(refused('"nested \'$(unmod x)\' quotes"'), /\$\(unmod\)/);
    assert.match(refused('%[a, "$(ban x)"]'), /\$\(ban\)/, 'an array outside an expression is plain text around a real call');
    assert.match(refused('\\"$(ban x)\\"'), /\$\(ban\)/, 'escaped quotes');
    assert.match(refused('\\\\$(ban x)'), /\$\(ban\)/, 'an escaped backslash does not escape the call');
    assert.match(refused('"#(other)"'), /#\(other\) runs another command/);
    assert.match(refused('"ok" $(user "x") "$(tts hi)"'), /\$\(tts\)/);
    assert.deepEqual(checkSafeBody('\\$(ban x) is how you write it'), { ok: true }, 'an escaped call is posted as text');
});

test('argument placeholders cannot join text into a new expression (timers and events render without an argument)', () => {
    assert.match(refused('$&t(ban x)'), /\$\(ban\)/);
    assert.match(refused('$&p1(add.vip $(user))'), /\$\(add\.vip\)/);
    assert.match(refused('#&t(other)'), /runs another command/);
    assert.deepEqual(checkSafeBody('$(user) hugs &p1 &t'), { ok: true });
});

test('the guard refuses every body the real engine would run an action, read or command for', async () => {
    const { parseSimulationInput, simulateCommand } = await import('../../utils/ast_parser/simulate.js');
    const bodies = [
        '"$(add.mod attacker)"', "'$(ban $(user) 60)'", 'x "y $(tts hi)" z', '%[a, "$(raid foo)"]', '\\"$(clear.chat)\\"',
        '$(upper "a $(ban x)")', '%(m "${$(ban x)}") %(m)', '*(1 == 1 ? "$(ban x)" : no)', '#(other)', '"#(other)"',
        '$(user) "quoted" $(random 3)', '\\$(ban x)', '%(#a "$(ban x)") %(#a)',
    ];
    for (const body of bodies) {
        const { runs } = await simulateCommand({ ...parseSimulationInput({ body, runs: [{ user: 'Sam', role: 'viewer' }, { user: 'Sam', role: 'mod', argument: 'Alex 60' }] }), repeat: 1 });
        const called = runs.flatMap((run) => [...run.actions.map((call) => call.function), ...run.samples.map((call) => call.function)]);
        const unsafe = called.filter((name) => !Object.hasOwn(SAFE_FUNCTIONS, name));
        const references = runs.some((run) => run.commandReferences.length > 0);
        if (unsafe.length || references) assert.equal(checkSafeBody(body).ok, false, `${body}: the engine runs ${unsafe.join(', ') || 'another command'}`);
    }
});
