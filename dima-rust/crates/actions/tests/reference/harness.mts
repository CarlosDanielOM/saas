// The outside world of the recorders, mocked: loaded first by `record_*.mts`.
//
// What it does, before any module of the reference is imported:
// - checks the environment (TZ=UTC, Dragonfly logical database 8 on loopback, a test SECRET_KEY,
//   telemetry and domain-event wake-ups off), so a recorder can never reach production stores;
// - freezes `Date` at NOW_MS (2030-01-01T09:30:00.123Z: in the future, so the keys the reference
//   writes with an absolute expiry (`PXAT`) are not expired by the real clock);
// - replaces `Math.random` and `crypto.randomUUID`, when the command language calls them, with
//   the SplitMix64 sequence of `dima_core::SeededRandom` (`Math.random` takes one 64-bit word and
//   keeps its top 52 bits, `randomUUID` takes two words as 16 big-endian bytes), reseeded per
//   case with `reseed`;
// - replaces `fetch`: `POST /helix/chat/messages` is recorded and answered `200 {data:
//   [{message_id: 'msg-<n>', is_sent: true}]}`; anything else is recorded and refused;
// - connects Mongoose to a throwaway database `dima_test_actions_rec_<random>`, dropped by
//   `finish` (also after a failure), and opens the read-only local copy `domdimabot`;
// - lists the Dragonfly keys before the run; `finish` deletes every key created since.
import { randomInt } from 'node:crypto';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NOW_MS = Date.UTC(2030, 0, 1, 9, 30, 0, 123);
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0) super(NOW_MS);
        else super(...(args as [any]));
    }
    static now() {
        return NOW_MS;
    }
}
Object.defineProperty(FrozenDate, 'name', { value: 'Date' });
(globalThis as any).Date = FrozenDate;

for (const [name, value] of [['TZ', 'UTC'], ['DRAGONFLY_HOST', '127.0.0.1'], ['DRAGONFLY_PORT', '6379/8'],
    ['SECRET_KEY', 'dima-actions-test-key'], ['OBSERVABILITY_DISABLED', 'true'], ['DOMAIN_EVENTS_WAKEUPS_ENABLED', 'false']]) {
    if (process.env[name] !== value) throw new Error(`run with ${name}=${value}`);
}
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');

// SplitMix64, as dima_core::SeededRandom.
const MASK = (1n << 64n) - 1n;
let state = 0n;
export function reseed(seed: number | bigint) {
    state = BigInt(seed) & MASK;
}
function next(): bigint {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
}
// Only the command language draws from the sequence (as in Rust, where the infrastructure has
// its own generator): a draw is the language's when the caller is the engine, the special
// parser or the AST timer runtime; any other caller (locks, logs, the directory) draws from
// the system's generator, so it cannot move the sequence.
const realRandom = Math.random;
const realUuid = crypto.randomUUID.bind(crypto);
// The direct caller only (the frame after the replaced function): a Dragonfly call made by the
// language draws for its telemetry span, which is not the language's draw.
const LANGUAGE = /utils\/ast_parser\/|handlers\/special_parser\.handler|utils\/ast_timer_runtime/;
const fromLanguage = () => LANGUAGE.test((new Error().stack ?? '').split('\n')[3] ?? '');
Math.random = () => fromLanguage() ? Number(next() >> 12n) / 2 ** 52 : realRandom();
const uuid = () => {
    const bytes: number[] = [];
    for (const word of [next(), next()]) for (let i = 7; i >= 0; i--) bytes.push(Number((word >> BigInt(8 * i)) & 0xffn));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
(crypto as any).randomUUID = () => fromLanguage() ? uuid() : realUuid();
syncBuiltinESMExports();

export const posts: { channel: string; text: string; replyTo: string | null }[] = [];
export const outbound: string[] = [];
let posted = 0;
(globalThis as any).fetch = async (input: unknown, init?: any) => {
    const url = String((input as any)?.url ?? input);
    if (url === 'https://api.twitch.tv/helix/chat/messages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push({ channel: body.broadcaster_id, text: body.message, replyTo: body.reply_parent_message_id ?? null });
        const message_id = `msg-${posted++}`;
        return new Response(JSON.stringify({ data: [{ message_id, is_sent: true }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    outbound.push(url);
    throw new Error('outbound calls are refused while recording');
};

// The reference logs a great deal: counted, not printed.
export const logged = { count: 0 };
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    (console as any)[method] = () => { logged.count++; };
}

export const root = process.cwd();
export const imported = async (file: string) => import(pathToFileURL(path.join(root, file)).href);
export const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
export const { EJSON } = mongoose.mongo.BSON;
export const database = `dima_test_actions_rec_${randomInt(1e9)}`;
await mongoose.connect(uri, { dbName: database });
export const copyClient = new mongoose.mongo.MongoClient(uri);
await copyClient.connect();
export const copy = copyClient.db('domdimabot');
export const scratch = mongoose.connection.db;

const { getDragonflyClient } = await imported('src/utils/databases/dragonfly.database.ts');
export const cache = await getDragonflyClient('ActionsRecorder');
const keysBefore = new Set<string>(await cache.keys('*'));

/** Deletes the keys created since the start (only those) and drops the throwaway database. */
export async function finish() {
    for (const key of await cache.keys('*')) if (!keysBefore.has(key)) await cache.del(key);
    // Mongoose creates each model's collection and indexes in the background: wait for them,
    // or they recreate the database after the drop.
    await Promise.all(mongoose.modelNames().map((name: string) => mongoose.model(name).init().catch(() => {})));
    await scratch.dropDatabase();
    await copyClient.close().catch(() => {});
    await mongoose.disconnect().catch(() => {});
}

/** The keys created since the start that match `pattern`, without the ones of `keysBefore`. */
export async function keysMatching(pattern: string): Promise<string[]> {
    return (await cache.keys(pattern)).filter((key: string) => !keysBefore.has(key)).sort();
}

/** Every key created since the start whose name starts with one of `prefixes` is deleted. */
export async function deleteKeys(patterns: string[]) {
    for (const pattern of patterns) for (const key of await keysMatching(pattern)) await cache.del(key);
}

/** JSON with object keys sorted, recursively. */
export function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, sorted((value as any)[key])]));
    }
    return value;
}

export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** The 99 functions of the four groups P4-ACT-CORE leaves unported (ledger/upper-layers.md 2.2). */
export const GROUPS: Record<string, string[]> = {
    moderation: ['warn', 'vip', 'add.vip', 'channel.add.vip', 'twitch.add.vip', 'unvip', 'ban', 'ban.self', 'ban.mod', 'mod', 'add.mod',
        'channel.add.mod', 'twitch.add.mod', 'unmod', 'permit', 'clear.chat', 'emoteonly', 'bot.mode'],
    channel: ['twitch.live', 'twitch.subs', 'twitch.title', 'twitch.game', 'twitch.viewers', 'twitch.follows', 'twitch.channel',
        'twitch.login', 'raid', 'unraid', 'set.title', 'set.game', 'set.voice', 'start.prediction', 'get.prediction', 'lock.prediction',
        'end.prediction', 'cancel.prediction', 'start.poll', 'get.poll', 'end.poll', 'cancel.poll', 'followage', 'announce',
        'announcement', 'shoutout', 'chat.announcement', 'chat.send', 'pin', 'pin.create', 'pin.update', 'pin.del', 'pin.delete',
        'enable.command', 'disable.command', 'enable.redemption', 'disable.redemption'],
    media: ['overlay.skip', 'overlay.skip.twitch', 'overlay.skip.kick', 'overlay.pause', 'overlay.pause.twitch', 'overlay.pause.kick',
        'overlay.resume', 'overlay.resume.twitch', 'overlay.resume.kick', 'overlay.clear', 'overlay.clear.twitch', 'overlay.clear.kick',
        'roulette.add', 'roulette.remove', 'roulette.update', 'roulette.shuffle', 'roulette.switch', 'roulette.show', 'roulette.hide',
        'roulette.start', 'roulette.result', 'randomuser', 'show.clip', 'create.clip', 'tts.status', 'tts.connected', 'tts.queue.length',
        'tts.skip', 'tts.clear', 'tts.refresh', 'tts.kokoro', 'tts', 'tts.speak', 'tts.piper', 'tts.ai', 'tts.clone', 'tts.fish',
        'pet.talk', 'pet.ask', 'widget.signal', 'widget.signal.to', 'goal.add', 'trigger.send'],
    ai: ['ai'],
};

/** Registers every function, then replaces each of the 99 with one that throws what the Rust
 * host answers for an unported group (`$(name) is not ported yet`). */
export async function stubGroups() {
    const { registerAllFunctions } = await imported('src/utils/ast_parser/functions/index.ts');
    const { registerFunction, getFunctionHandler } = await imported('src/utils/ast_parser/evaluator.ts');
    registerAllFunctions({ startWorkers: false });
    for (const names of Object.values(GROUPS)) {
        for (const name of names) {
            if (!getFunctionHandler(name)) throw new Error(`${name} is not registered in the reference`);
            registerFunction(name, async () => { throw new Error(`$(${name}) is not ported yet`); });
        }
    }
}
