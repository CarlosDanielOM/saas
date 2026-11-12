// Records the command editor's simulation (`utils/ast_parser/simulate.ts`) for
// `tests/simulate.rs`: the answers to a table of editor inputs (synthetic: kept whole), and the
// answer for every command-language text stored in the local copy (`domdimabot`, read only: kept
// as hashes of the answer's JSON, the texts being streamers' content).
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/8 \
//     SECRET_KEY=dima-actions-test-key OBSERVABILITY_DISABLED=true DOMAIN_EVENTS_WAKEUPS_ENABLED=false \
//     node_modules/.bin/tsx /path/to/dima-rust/crates/actions/tests/reference/record_simulate.mts \
//     /path/to/dima-rust/crates/actions/tests/fixtures/simulate_recorded.json
//
// The outside world is mocked by `harness.mts`; the simulation itself touches none of it (it is
// checked: no chat post, no outbound call, no write). Each case reseeds the command language's
// randomness with its position. The answer is `JSON.stringify` of what the site agent and the
// docs assistant receive, or the input error's message.
import { writeFileSync } from 'node:fs';
import { posts, outbound, imported, copy, scratch, sha256, reseed, finish } from './harness.mts';

const out = process.argv[2];
if (!out) throw new Error('usage: record_simulate.mts <out.json>');

export const INPUTS: unknown[] = [
    { body: 'Hola $(user)!' },
    { body: '%(*n $(random 10))%(*n) $(ban $(user) 60)' },
    { body: 'hug &p1 for &t', runs: [{ user: 'Ana', argument: 'Bob and friends' }, { user: '@Carl ', argument: '', role: 'mod' }] },
    { body: '$(twitch.channel &p1) $(twitch.game @SomeOne) $(twitch.login !!bad) $(twitch.channel)', runs: [{ argument: 'Streamer_1' }, { argument: 'x', targetLookup: 'not_found' }] },
    { body: '$(count 1) $(scount)', runs: [{}, {}, { user: 'Bo', role: 'streamer' }] },
    { body: '%(##hp 5)%(#round 2)%(*total 9)%(**pts 3)%(**pts(Rival) 4)#(other a b) $(timer 30 later) $(delay 2) %(##hp)' },
    { body: '*(%(roll $(random 6)) == 0 ? $(ban $(user) 60) : "safe")', repeat: 20, plan: 'free' },
    { body: '!cc hola' },
    {},
    { body: 'x'.repeat(10001) },
    { runs: [{ body: 'from the run' }] },
    { body: 'a', runs: [{ body: '!ec x' }] },
    { body: '[Unknown] $(nope) Error: boom == x $(user' },
    { body: '&t &p1', runs: [{ argument: 'a b' }] },
    { body: '¡Hola $(user)! 👋 مرحبا &p1', runs: [{ user: 'Zoë 👩‍💻 Ñandú', argument: 'مرحبا 👋' }] },
    { body: '$(random 2)', repeat: '5', plan: 'pro' },
    { body: '$(tts.status) $(get.poll) $(ai hola) $(randomuser) $(bot.mode) $(followage) $(cheer.amount)' },
    { body: '%(l %["a", "b"])%(l[] "c")%(l.length) %del(*gone) %(responses[] "r1")' },
    { body: '   ', runs: [{ body: 'spaces    collapse\n\nhere   ' }], repeat: 2 },
    null,
];

const { parseSimulationInput, simulateCommand } = await imported('src/utils/ast_parser/simulate.ts');

async function answer(raw: unknown, seed: number): Promise<string> {
    reseed(seed);
    try {
        const input = parseSimulationInput(raw);
        return JSON.stringify(await simulateCommand(input));
    } catch (error: any) {
        return JSON.stringify({ inputError: error?.message ?? String(error) });
    }
}

// The stored texts, in the order of record_commands.mts.
const SOURCES: [string, string[]][] = [
    ['commands', ['message']], ['custom_timers', ['message']],
    ['eventsubs', ['message', 'endMessage', 'temporalBanMessage', 'modiversaryMessage', 'cheerTiers[].message']],
    ['bits_rules', ['rules[].chat.message']], ['redemptionrewards', ['message']],
    ['roulette_channels', ['actions[].source', 'state.roulettes[].items[].action', 'state.roulettes[].settings.winnerAction']],
    ['channel_goals', ['goals[].actions[].text']],
];
function stringsAt(value: any, steps: string[], out: string[]) {
    if (steps.length === 0) { if (typeof value === 'string') out.push(value); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const [first, ...rest] = steps;
    const array = first.endsWith('[]');
    const child = value[array ? first.slice(0, -2) : first];
    if (array) { if (Array.isArray(child)) child.forEach(item => stringsAt(item, rest, out)); }
    else if (child !== undefined) stringsAt(child, rest, out);
}

try {
    const inputs = [];
    for (const [index, raw] of INPUTS.entries()) inputs.push({ input: raw, answer: await answer(raw, 2000 + index) });
    const stored: string[] = [];
    let index = 0;
    for (const [collection, paths] of SOURCES) {
        for (const doc of await copy.collection(collection).find({}).sort({ _id: 1 }).toArray()) {
            for (const path of paths) {
                const found: string[] = [];
                stringsAt(doc, path.split('.'), found);
                for (const text of found) {
                    if (!text.trim()) continue;
                    index += 1;
                    stored.push(sha256(await answer({ body: text }, 5000 + index)));
                }
            }
        }
    }
    // Mongoose creates the models' collections on its own; none may hold a document.
    let writes = 0;
    for (const { name } of await scratch.listCollections().toArray()) writes += await scratch.collection(name).countDocuments();
    if (posts.length || outbound.length || writes) throw new Error(`the simulation had effects: ${posts.length} posts, ${outbound.length} calls, ${writes} documents`);
    writeFileSync(out, JSON.stringify({ inputs, stored }, null, 1) + '\n');
} finally {
    await finish();
}
process.exit(0);
