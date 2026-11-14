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
    assert.match(refused('$(user'), /does not parse/);
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
