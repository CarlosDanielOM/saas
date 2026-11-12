// Records what the reference does with every command-language text stored in the local copy
// (`domdimabot`, read only), for `tests/stored_commands.rs`.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/8 \
//     SECRET_KEY=dima-actions-test-key OBSERVABILITY_DISABLED=true DOMAIN_EVENTS_WAKEUPS_ENABLED=false \
//     node_modules/.bin/tsx /path/to/dima-rust/crates/actions/tests/reference/record_commands.mts \
//     /path/to/dima-rust/crates/actions/tests/fixtures/stored_commands.json [debug.jsonl]
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference
// (commit 0c71108e). The outside world is mocked by `harness.mts` (frozen clock, seeded
// randomness, Twitch as an in-process mock, a throwaway database, Dragonfly database 8). What is
// loaded: `handlers/commands.handler.ts` (`commandHandler`, `executeCustomCommand`),
// `handlers/special_parser.handler.ts` (`parseSpecialCommands`), `utils/ast_command_delivery.ts`
// (`deliverAstMessage`) and through them the whole engine and the function registry, with the 99
// functions of the four unported groups replaced by one that throws `$(name) is not ported yet`
// (what the Rust host answers), so a text that calls one is compared up to that failure.
//
// Each text runs against a fresh scratch copy of its channel: the channel's commands copied from
// the copy, its owner (plan and name) as a user, no variables, no cache keys, the randomness
// reseeded with the case's position. Commands run as a chat message names them
// (`commandHandler`, or `executeCustomCommand` for a keyword) with an authored authorization and
// are delivered (`deliverAstMessage`); every other text is rendered with a chat event as context
// (`parseSpecialCommands`) and delivered. What is recorded per text is a hash of: the answer, the
// chat posts in order, the `astvariables` documents, the channel's commands (canonical extended
// JSON), and the Dragonfly keys the run wrote (cache variables, cooldowns, AST timers) with their
// types, values and lifetimes. The fixture holds ids and hashes only (the texts are streamers'
// content); the optional debug file (outside the repository) holds the compared values.
import { writeFileSync, appendFileSync } from 'node:fs';
import { posts, outbound, logged, imported, EJSON, copy, scratch, cache, finish, keysMatching, deleteKeys, sorted, sha256,
    reseed, stubGroups, NOW_MS } from './harness.mts';

const out = process.argv[2];
const debug = process.argv[3];
if (!out) throw new Error('usage: record_commands.mts <out.json> [debug.jsonl]');
if (debug) writeFileSync(debug, '');

/** (collection, paths of command-language text; `[]` descends into an array; the channel's field). */
export const SOURCES: [string, string[], string][] = [
    ['commands', ['message'], 'channelID'],
    ['custom_timers', ['message'], 'channelID'],
    ['eventsubs', ['message', 'endMessage', 'temporalBanMessage', 'modiversaryMessage', 'cheerTiers[].message'], 'channelID'],
    ['bits_rules', ['rules[].chat.message'], '_id'],
    ['redemptionrewards', ['message'], 'channelID'],
    ['roulette_channels', ['actions[].source', 'state.roulettes[].items[].action', 'state.roulettes[].settings.winnerAction'], '_id'],
    ['channel_goals', ['goals[].actions[].text'], '_id'],
];

/** Every string at a dotted path, with its concrete path (`cheerTiers.0.message`). */
function stringsAt(value: any, steps: string[], at: string[], out: [string, string][]) {
    if (steps.length === 0) {
        if (typeof value === 'string') out.push([at.join('.'), value]);
        return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const [first, ...rest] = steps;
    const array = first.endsWith('[]');
    const key = array ? first.slice(0, -2) : first;
    const child = value[key];
    if (array) {
        if (Array.isArray(child)) child.forEach((item, index) => stringsAt(item, rest, [...at, key, String(index)], out));
    } else if (child !== undefined) {
        stringsAt(child, rest, [...at, key], out);
    }
}

export const ARGUMENT = 'uno dos @Tres';
export const chatEvent = (channel: string) => ({
    broadcaster_user_id: channel, broadcaster_user_login: 'streamer', broadcaster_user_name: 'Streamer',
    chatter_user_id: '5001', chatter_user_login: 'viewerone', chatter_user_name: 'ViewerOne',
    message_id: 'chat-1', message: { text: `!x ${ARGUMENT}`, fragments: [] }, color: '#1E90FF',
    badges: [{ set_id: 'subscriber', id: '12', info: '16' }], message_type: 'text', cheer: null, reply: null,
    channel_points_custom_reward_id: null,
});

const { commandHandler, executeCustomCommand } = await imported('src/handlers/commands.handler.ts');
const { parseSpecialCommands } = await imported('src/handlers/special_parser.handler.ts');
const { deliverAstMessage } = await imported('src/utils/ast_command_delivery.ts');
const { CommandsSchema } = await imported('src/schemas/commands.schema.ts');
await stubGroups();

const canonical = (doc: unknown) => sorted(JSON.parse(EJSON.stringify(doc, { relaxed: false })));

async function stateOf(channel: string) {
    const variables = (await scratch.collection('astvariables').find({}).toArray())
        .map((doc: any) => { delete doc._id; return canonical(doc); })
        .sort((a: any, b: any) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    const commands = (await scratch.collection('commands').find({ channelID: channel }).sort({ _id: 1 }).toArray()).map(canonical);
    const keys: unknown[] = [];
    const names = [...await keysMatching(`twitch:${channel}:variable:*`), ...await keysMatching(`command:execution:cooldown:${channel}:*`),
        ...await keysMatching('ast:timers:*')].sort();
    for (const key of names) {
        const type = await cache.type(key);
        const value = type === 'string' ? await cache.get(key)
            : type === 'zset' ? (await cache.zRangeWithScores(key, 0, -1)).map((e: any) => [e.value, e.score]) : null;
        const pttl = await cache.pTTL(key);
        // Absolute expiries (PXAT) follow the frozen clock, not the server's: only their presence.
        const ttl = key.startsWith('ast:timers:') ? (pttl < 0 ? pttl : 'at') : (pttl < 0 ? pttl : Math.round(pttl / 1000));
        keys.push([key, type, value, ttl]);
    }
    return { variables, commands, keys };
}

// The channels and their owners.
const cases: { source: string; id: string; path: string; channel: string; text: string; doc: any }[] = [];
for (const [collection, paths, channelField] of SOURCES) {
    for (const doc of await copy.collection(collection).find({}).sort({ _id: 1 }).toArray()) {
        const channel = String(doc[channelField] ?? '');
        if (!/^\d{1,30}$/.test(channel)) continue;
        for (const path of paths) {
            const found: [string, string][] = [];
            stringsAt(doc, path.split('.'), [], found);
            for (const [at, text] of found) {
                if (!text.trim()) continue;
                cases.push({ source: collection, id: String(doc._id), path: at, channel, text, doc });
            }
        }
    }
}
const channels = [...new Set(cases.map(c => c.channel))];
for (const channel of channels) {
    const owner = await copy.collection('users').findOne({ accounts: { $elemMatch: { type: 'twitch', id: channel } } },
        { projection: { plan_tier: 1, accounts: 1 } });
    const account = owner?.accounts?.find((a: any) => a.type === 'twitch' && a.id === channel);
    await scratch.collection('users').insertOne({ accounts: [{ type: 'twitch', id: channel, name: account?.name ?? 'streamer', chat_enabled: true, actived: true }],
        plan_tier: owner?.plan_tier ?? 'free', __v: 0 });
}
await cache.set('app:twitch:token', 'app-token-recorder', { EX: 86400 });
// The directory loads each owner once, before the cases: its first load draws `randomUUID`
// (outside the command language), which would move the sequence of the case that triggers it.
const TwitchStreamers = (await imported('src/classes/twitch_streamers.class.ts')).default;
for (const channel of channels) await TwitchStreamers.getTwitchAccountById(channel);

const AUTHORED = { origin: 'authored', identity: { level: 10, tags: ['broadcaster', 'everyone'] } };
const recorded: unknown[] = [];
let index = 0;
try {
    for (const item of cases) {
        index += 1;
        const { channel } = item;
        posts.splice(0);
        await scratch.collection('astvariables').deleteMany({});
        await scratch.collection('commands').deleteMany({ channelID: channel });
        // BSON types kept as stored (no promotion to JavaScript numbers on the way).
        const channelCommands = await copy.collection('commands').find({ channelID: channel }, { promoteValues: false })
            .sort({ _id: 1 }).toArray();
        if (channelCommands.length) await scratch.collection('commands').insertMany(channelCommands);
        await deleteKeys([`${channel}:commands:*`, `twitch:${channel}:*`, `command:execution:cooldown:${channel}:*`, 'ast:timers:*', 'keywords:*']);
        reseed(index);
        let result: any;
        try {
            if (item.source === 'commands') {
                const keyword = item.doc.activation === 'keyword';
                const stored = keyword ? await CommandsSchema.findOne({ _id: item.doc._id }).lean() : null;
                const res = keyword
                    ? await executeCustomCommand(channel, chatEvent(channel), stored, item.doc.cmd, ARGUMENT, AUTHORED)
                    : await commandHandler(channel, chatEvent(channel), item.doc.cmd, ARGUMENT, AUTHORED);
                if (res.error) result = { error: true, message: res.message, status: res.status, type: res.type };
                else {
                    const delivered = await deliverAstMessage(channel, { parsedText: res.message, commandReferences: res.commandReferences });
                    result = { error: false, message: res.message, delivered: delivered.error ? delivered.message : 'ok' };
                }
            } else {
                const parsed = await parseSpecialCommands(item.text, { channelID: channel, eventData: chatEvent(channel), argument: ARGUMENT, literalArguments: true });
                const delivered = await deliverAstMessage(channel, parsed);
                result = { delivered: delivered.error ? delivered.message : 'ok' };
            }
        } catch (error: any) {
            result = { thrown: error?.message ?? String(error) };
        }
        const outcome = sorted({ result, posts: posts.splice(0).map(p => [p.channel, p.text, p.replyTo]), ...await stateOf(channel) });
        const text = JSON.stringify(outcome);
        recorded.push({ source: item.source, id: item.id, path: item.path, channel, hash: sha256(text) });
        if (debug) appendFileSync(debug, JSON.stringify({ source: item.source, id: item.id, path: item.path, outcome }) + '\n');
    }
    writeFileSync(out, JSON.stringify({
        nowMs: NOW_MS, argument: ARGUMENT, cases: recorded.length, outbound: outbound.length, logged: logged.count, recorded,
    }, null, 1) + '\n');
} finally {
    await finish();
}
process.exit(0);
