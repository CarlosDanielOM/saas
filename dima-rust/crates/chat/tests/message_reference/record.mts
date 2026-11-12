// Records what the reference's chat message handler does, for `tests/message_recorded.rs`.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/8 \
//     SECRET_KEY=dima-chat-test-key OBSERVABILITY_DISABLED=true DOMAIN_EVENTS_WAKEUPS_ENABLED=false \
//     DIMABOT_DIR="$DIMABOT_DIR" node_modules/.bin/tsx \
//     "$REPO/dima-rust/crates/chat/tests/message_reference/record.mts" \
//     "$REPO/dima-rust/crates/chat/tests/fixtures/message_recorded.json"
//
// DIMABOT_DIR is a `dimabot/` checkout with `node_modules` whose `src/` is the frozen reference
// (commit 0c71108e); nothing under it is changed.
//
// What runs for real: `handlers/eventsub.handler.ts` (`eventsubHandler`, the chat message branch),
// `handlers/message.handler.ts`, `handlers/keywords.handler.ts`, `handlers/commands.handler.ts`
// and the whole command language, the streamer directory, identity resolution, chat history,
// the cooldowns, the keyword caches, the delivery and `sendTwitchChatMessage` (against a
// recording `fetch`), and the stream recorders (`utils/stream_analytics.ts`,
// `utils/stream_activity.ts`) against the scratch database.
//
// What is replaced (`hooks.mjs`, `stubs/`), each call recorded with its arguments: moderation
// (`runChatModeration`: the case's verdict), the AI (`getChannelPersonality`, `chat`, the thread
// router: the case's answers), every built-in and the timer manager (the case's answers), the
// embedding queue (`storeChatMessageEmbeddingBatched`: what was queued), the site counter, the
// product event `trackCommand`, the widget feed, the message metrics (counted), the logger
// (counted, never written). Twitch is `fetch`: `POST /helix/chat/messages` answers sent with
// `msg-<n>`; anything else is recorded and refused.
//
// Stores: a throwaway MongoDB database `dima_test_chat_rec_<random>` (dropped at the end, also
// after a failure) and Dragonfly logical database 8, where the keys created since the start are
// deleted at the end. Each case has channels of its own (99007xxxx), so the reference's
// per-process state (cooldown maps, keyword caches) never crosses cases, except the process-wide
// `isMod` flag, whose effect the cases pin on purpose. The clock is frozen at NOW_MS; the command
// language's randomness is reseeded per case (SplitMix64, as `dima_core::SeededRandom`).
//
// The fixture holds the cases (seeds, configuration, messages: fictional text only) and what was
// observed: chat posts in order, the stub calls by kind, the metrics, the MongoDB documents of
// every collection but `users` and `eventsubs`, and the Dragonfly keys the handler owns (chat
// history, the shared cooldown gate, cache variables).
import { register, syncBuiltinESMExports } from 'node:module';
import crypto, { createHash, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
    ['SECRET_KEY', 'dima-chat-test-key'], ['OBSERVABILITY_DISABLED', 'true'], ['DOMAIN_EVENTS_WAKEUPS_ENABLED', 'false']]) {
    if (process.env[name] !== value) throw new Error(`run with ${name}=${value}`);
}
const uri = process.env.DIMA_TEST_MONGO_URI;
if (!uri) throw new Error('DIMA_TEST_MONGO_URI is not set: eval "$(dima-rust/tools/test-env)"');
if (!process.env.DIMABOT_DIR) throw new Error('DIMABOT_DIR is not set');
const out = process.argv[2];
if (!out) throw new Error('usage: record.mts <out.json>');

register(new URL('./hooks.mjs', import.meta.url).href, import.meta.url);
const R = await import(new URL('./stubs/rec.mjs', import.meta.url).href).then((m) => m.R);

// SplitMix64, as dima_core::SeededRandom; only the command language draws from it.
const MASK = (1n << 64n) - 1n;
let state = 0n;
const reseed = (seed: number) => { state = BigInt(seed) & MASK; };
function next(): bigint {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
}
const realRandom = Math.random;
const LANGUAGE = /utils\/ast_parser\/|handlers\/special_parser\.handler|utils\/ast_timer_runtime/;
const fromLanguage = () => LANGUAGE.test((new Error().stack ?? '').split('\n')[3] ?? '');
Math.random = () => fromLanguage() ? Number(next() >> 12n) / 2 ** 52 : realRandom();
syncBuiltinESMExports();

// Twitch, recorded.
const posts: { channel: string; text: string; replyTo: string | null }[] = [];
const outbound: string[] = [];
let posted = 0;
(globalThis as any).fetch = async (input: unknown, init?: any) => {
    const url = String((input as any)?.url ?? input);
    if (url === 'https://api.twitch.tv/helix/chat/messages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push({ channel: body.broadcaster_id, text: body.message, replyTo: body.reply_parent_message_id ?? null });
        return new Response(JSON.stringify({ data: [{ message_id: `msg-${posted++}`, is_sent: true }] }),
            { status: 200, headers: { 'content-type': 'application/json' } });
    }
    outbound.push(url);
    throw new Error('outbound calls are refused while recording');
};
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) (console as any)[method] = () => {};

const root = process.env.DIMABOT_DIR;
const imported = async (file: string) => import(pathToFileURL(path.join(root, 'src', file)).href);
const mongoose = (await import(pathToFileURL(path.join(root, 'node_modules/mongoose/index.js')).href)).default;
const { EJSON, ObjectId } = mongoose.mongo.BSON;
const database = `dima_test_chat_rec_${randomInt(1e9)}`;
await mongoose.connect(uri, { dbName: database });
const scratch = mongoose.connection.db;

const SOURCES = ['handlers/message.handler.ts', 'handlers/keywords.handler.ts', 'handlers/eventsub.handler.ts',
    'handlers/commands.handler.ts', 'functions/promo/chat.promo.ts', 'classes/cooldown.class.ts', 'utils/keyword_cache.ts',
    'utils/keywords.ts', 'utils/permissions/roles.ts', 'utils/permissions/index.ts', 'utils/badges.ts', 'classes/chat_history.ts',
    'utils/stream_analytics.ts', 'utils/stream_activity.ts', 'utils/ast_command_delivery.ts', 'utils/shared_chat_origin.ts'];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sources = Object.fromEntries(SOURCES.map((file) => [file, sha256(readFileSync(path.join(root, 'src', file), 'utf8'))]));
const reference = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim();

const { getDragonflyClient } = await imported('utils/databases/dragonfly.database.ts');
const cache = await getDragonflyClient('MessageRecorder');
const keysBefore = new Set<string>(await cache.keys('*'));
await cache.set('app:twitch:token', 'app-token-recorder', { EX: 86400 });

const { eventsubHandler } = await imported('handlers/eventsub.handler.ts');
const { createTwitchEffectContext } = await imported('utils/ast_parser/effects.ts');

// ---------------------------------------------------------------------------------------------
// The cases.

const BOT = '698614112';
const TIMESTAMP = new Date(NOW_MS).toISOString();
const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const date = (ms: number) => new Date(ms);

type Chatter = { id: string; login: string; name: string; badges: any[] };
const chatter = (id: string, login: string, name: string, badges: any[] = []): Chatter => ({ id, login, name, badges });
const VIEWER = chatter('5001', 'viewerone', 'ViewerOne');
const VIEWER2 = chatter('5002', 'viewertwo', 'ViewerTwo');
const SUB = chatter('5003', 'subfan', 'SubFan', [{ set_id: 'subscriber', id: '12', info: '16' }]);
const VIP = chatter('5004', 'vipfriend', 'VipFriend', [{ set_id: 'vip', id: '1', info: '' }]);
const MOD = chatter('5005', 'modhelper', 'ModHelper', [{ set_id: 'moderator', id: '1', info: '' }]);
const BOT_CHATTER = chatter(BOT, 'domdimabot', 'DomDimaBot', [{ set_id: 'moderator', id: '1', info: '' }]);
const broadcasterOf = (channel: string) => chatter(channel, `canal${channel}`, `Canal${channel}`, [{ set_id: 'broadcaster', id: '1', info: '' }]);

type Command = Record<string, any>;
let commandIds = 0x3000;
const command = (channel: string, cmd: any, message: string, extra: Command = {}): Command => ({
    _id: oid(++commandIds), channelID: channel, channel: `canal${channel}`, name: Array.isArray(cmd) ? cmd[0] : cmd, cmd,
    func: 'custom', message, type: 'command', platform: 'twitch', reserved: false, cooldown: 0, count: 0,
    userLevelName: 'everyone', userLevel: 0, enabled: true, __v: 0, ...extra,
});

interface Case {
    name: string;
    /** Channels: [id, {plan, chatEnabled, live, user (false: no account)}]. */
    channels: [string, { plan?: string; chatEnabled?: boolean; live?: boolean; user?: boolean }][];
    commands?: Command[];
    eventsubs?: Command[];
    dragonfly?: string[][];
    config?: Record<string, any>;
    /** [channel, chatter, text, extra event fields]. */
    messages: [string, Chatter, string, Record<string, any>?][];
}

const cases: Case[] = [];
const ch = (i: number, k = 0) => String(990070000 + i * 10 + k);
const add = (build: (a: string, b: string) => Omit<Case, 'channels'> & { channels?: Case['channels'] }) => {
    const i = cases.length + 1;
    const a = ch(i, 0), b = ch(i, 1);
    const built = build(a, b);
    cases.push({ channels: [[a, { live: true }]], ...built } as Case);
};
const HOLA = 'Hola $(user), van $(count) saludos';
const HOLA_COUNTED = 'Hola $(user), van $(count 1) saludos';

add((a) => ({ name: 'the slice: a custom command with a counter', commands: [command(a, 'hola', HOLA)],
    messages: [[a, VIEWER, '!hola']] }));
add((a) => ({ name: 'a counter that counts, variables and arguments',
    commands: [command(a, 'puntos', '%(*total 3)%(**pts 2)$(user) tiene %(**pts) puntos de %(*total), args: &p1 y &p2 [&t]', { count: 4 }),
        command(a, 'suma', 'Van $(count 1), luego $(scount)', { count: 10 }), command(a, 'cuenta', 'Cuenta: $(count)', { count: 7 })],
    messages: [[a, VIEWER, '!puntos uno  dos tres'], [a, VIEWER, '!suma'], [a, VIEWER, '!cuenta 5'], [a, VIEWER, '!cuenta']] }));
add((a) => ({ name: 'a display name is not an alias: only cmd is looked up', commands: [command(a, 'help', 'Ayuda para $(user)', { name: 'Ayuda' })],
    messages: [[a, VIEWER, '!help'], [a, VIEWER, '!Ayuda'], [a, VIEWER, '!ayuda']] }));
add((a) => ({ name: 'the command name in another case is not found', commands: [command(a, 'hola', HOLA)],
    messages: [[a, VIEWER, '!HOLA'], [a, VIEWER, '!Hola']] }));
add((a) => ({ name: 'without the prefix nothing runs', commands: [command(a, 'hola', HOLA)],
    messages: [[a, VIEWER, 'hola'], [a, VIEWER, ' !hola']] }));
add((a) => ({ name: 'a cooldown in this process', commands: [command(a, 'hola', HOLA, { cooldown: 30 })],
    messages: [[a, VIEWER, '!hola'], [a, VIEWER2, '!hola'], [a, VIEWER, '!hola']] }));
add((a) => ({ name: 'the shared cooldown gate held by another process', commands: [command(a, 'hola', HOLA, { cooldown: 30 })],
    dragonfly: [['SET', `command:execution:cooldown:${a}:hola`, '1', 'PX', '20000']],
    messages: [[a, VIEWER, '!hola']] }));
add((a) => ({ name: 'a command above the chatter level, and for moderators', commands: [command(a, 'solomods', 'Solo mods', { userLevel: 7, userLevelName: 'moderator' })],
    messages: [[a, VIEWER, '!solomods'], [a, SUB, '!solomods'], [a, MOD, '!solomods'], [a, broadcasterOf(a), '!solomods']] }));
add((a) => ({ name: 'a disabled command', commands: [command(a, 'apagado', 'No debe salir', { enabled: false })],
    messages: [[a, VIEWER, '!apagado']] }));
add((a) => ({ name: 'a tag permission: VIP only', commands: [command(a, 'vips', 'Hola VIP $(user)', { permissionExpression: { role: 'vip' } })],
    messages: [[a, VIEWER, '!vips'], [a, VIP, '!vips'], [a, broadcasterOf(a), '!vips']] }));
add((a) => ({ name: 'an invalid tag permission is denied', commands: [command(a, 'roto', 'No debe salir', { permissionExpression: { role: 'nadie' } })],
    messages: [[a, broadcasterOf(a), '!roto']] }));
add((a) => ({ name: 'a keyword at the start and inside a longer message',
    commands: [command(a, 'buenos dias', 'Buenos días, $(user) #$(count)', { activation: 'keyword', cooldown: 5, keywordSettings: { matchMode: 'start' } }),
        command(a, 'gracias', 'De nada $(user)', { activation: 'keyword', cooldown: 5, keywordSettings: { matchMode: 'anywhere' } })],
    messages: [[a, VIEWER, 'Buenos   DIAS a todos'], [a, VIEWER2, 'muchas gracias por el directo'], [a, SUB, 'hola, buenos dias'], [a, VIEWER, 'buenos días']] }));
add((a) => ({ name: 'a command and a keyword in one message',
    commands: [command(a, 'hola', HOLA), command(a, 'gracias', 'De nada $(user)', { activation: 'keyword', cooldown: 5, keywordSettings: { matchMode: 'anywhere' } })],
    messages: [[a, VIEWER, '!hola gracias']] }));
add((a) => ({ name: 'built-ins: a reserved shoutout, usage errors, the command list',
    commands: [command(a, 'so', '', { func: 'shoutout', reserved: true }), command(a, 'poll', '', { func: 'poll', reserved: true }),
        command(a, 'comandos', '', { func: 'commands', reserved: true }), command(a, 'promo', '', { func: 'promo', reserved: true })],
    config: { builtins: { commandList: { error: false, message: 'Comandos: !hola, !so' }, promo: { error: true, message: '' } } },
    messages: [[a, MOD, '!so @otrocanal'], [a, MOD, '!poll'], [a, VIEWER, '!comandos'], [a, MOD, '!promo otrocanal']] }));
add((a) => ({ name: 'built-ins: answers mapped per branch',
    commands: [command(a, 'cc', '', { func: 'createCommand', reserved: true, userLevel: 7 }), command(a, 'clear', '', { func: 'clearChat', reserved: true, userLevel: 7 }),
        command(a, 'anuncio', '', { func: 'anuncio', reserved: true, userLevel: 7 }), command(a, 'sumi', '', { func: 'sumimetro', reserved: true }),
        command(a, 'follow', '', { func: 'followage', reserved: true }), command(a, 'titulo', '', { func: 'title', reserved: true })],
    config: { builtins: { createCommand: { error: false, message: '' }, sumimetro: { error: true, message: 'sumi falló' },
        followage: { error: false } } },
    messages: [[a, MOD, '!cc !nuevo hola'], [a, MOD, '!clear'], [a, MOD, '!anuncio Gran directo hoy'], [a, VIEWER, '!sumi  a !sumi b'],
        [a, VIEWER, '!follow'], [a, VIEWER2, '!titulo Nuevo título']] }));
add((a) => ({ name: 'an announcement over 300 UTF-16 units but within 300 characters',
    commands: [command(a, 'anuncio', '', { func: 'anuncio', reserved: true })],
    messages: [[a, MOD, `!anuncio ${'👋'.repeat(160)}`], [a, MOD, `!anuncio ${'a'.repeat(301)}`]] }));
add((a) => ({ name: 'a built-in that throws',
    commands: [command(a, 'mod', '', { func: 'mod', reserved: true })],
    config: { builtins: { addModerator: { throws: 'helix exploded' } } },
    messages: [[a, broadcasterOf(a), '!mod @alguien'], [a, broadcasterOf(a), '!mod @alguien']] }));
add((a) => ({ name: 'timers: a viewer is refused, a moderator manages them',
    config: { builtins: { createTimer: { error: false, message: 'Timer promo created' }, listTimers: { error: false, message: 'Timers: promo' } } },
    messages: [[a, VIEWER, '!timer list'], [a, MOD, '!cct promo 10 Sígueme en redes'], [a, MOD, '!TIMERS ls'], [a, MOD, '!timer'], [a, MOD, '!cct promo']] }));
add((a) => ({ name: 'the bot\'s own message', commands: [command(a, 'hola', HOLA)],
    messages: [[a, BOT_CHATTER, '!hola']] }));
add((a) => ({ name: 'a reply to another chatter', commands: [command(a, 'hola', HOLA)],
    messages: [[a, VIEWER, '@ViewerTwo !hola', { reply: { parent_message_id: 'parent-1', parent_message_body: 'algo', parent_user_id: '5002',
        parent_user_name: 'ViewerTwo', parent_user_login: 'viewertwo', thread_message_id: 'parent-1', thread_user_id: '5002',
        thread_user_name: 'ViewerTwo', thread_user_login: 'viewertwo' } }]] }));
add((a) => ({ name: 'a cheer in a chat message', commands: [command(a, 'hola', HOLA)],
    messages: [[a, SUB, 'Cheer100 vamos', { cheer: { bits: 100 }, message: { text: 'Cheer100 vamos', fragments: [
        { type: 'cheermote', text: 'Cheer100', cheermote: { prefix: 'cheer', bits: 100, tier: 100 }, emote: null, mention: null },
        { type: 'text', text: ' vamos', cheermote: null, emote: null, mention: null }] } }]] }));
add((a, b) => ({ name: 'a shared-chat copy from another channel', channels: [[a, { live: true }], [b, {}]], commands: [command(a, 'hola', HOLA)],
    messages: [[a, VIEWER, '!hola', { source_broadcaster_user_id: b, source_broadcaster_user_login: `canal${b}`, source_broadcaster_user_name: `Canal${b}`,
        source_message_id: 'src-1', source_badges: [] }], [a, VIEWER, '!hola', { source_broadcaster_user_id: a, source_message_id: 'src-2' }]] }));
add((a) => ({ name: 'a channel whose chat is disabled still answers', channels: [[a, { chatEnabled: false, plan: 'pro' }]],
    commands: [command(a, 'hola', HOLA)], messages: [[a, VIEWER, '!hola']] }));
add((a, b) => ({ name: 'a channel without an account, and a disabled chat subscription', channels: [[a, { user: false }], [b, {}]],
    commands: [command(a, 'hola', HOLA), command(b, 'hola', HOLA)],
    eventsubs: [{ _id: oid(0x5001), channelID: b, type: 'channel.chat.message', enabled: false, message: '', __v: 0 }],
    messages: [[a, VIEWER, '!hola'], [b, VIEWER, '!hola']] }));
add((a) => ({ name: 'an empty message, the prefix alone, a long one, only emotes', commands: [command(a, 'hola', HOLA)],
    messages: [[a, VIEWER, ''], [a, VIEWER, '!'], [a, VIEWER, `!hola ${'largo '.repeat(80)}`],
        [a, SUB, 'Kappa Kappa PogChamp', { message: { text: 'Kappa Kappa PogChamp', fragments: [
            { type: 'emote', text: 'Kappa', cheermote: null, emote: { id: '25', emote_set_id: '0', owner_id: '0', format: ['static'] }, mention: null },
            { type: 'text', text: ' ', cheermote: null, emote: null, mention: null },
            { type: 'emote', text: 'Kappa', cheermote: null, emote: { id: '25', emote_set_id: '0', owner_id: '0', format: ['static'] }, mention: null },
            { type: 'text', text: ' ', cheermote: null, emote: null, mention: null },
            { type: 'emote', text: 'PogChamp', cheermote: null, emote: { id: '305954156', emote_set_id: '0', owner_id: '0', format: ['static'] }, mention: null }] } }]] }));
add((a) => ({ name: 'text with emoji, combining marks and right-to-left script', commands: [command(a, 'eco', 'Eco: $(1) — $(user)')],
    messages: [[a, VIEWER, '!eco 👋🏽 café ́ مرحبا'], [a, VIEWER, '!ecó x']] }));
add((a) => ({ name: 'two messages of one user in quick succession', commands: [command(a, 'hola', HOLA_COUNTED)],
    messages: [[a, VIEWER, '!hola'], [a, VIEWER, '!hola']] }));
add((a) => ({ name: 'moderation takes an action: nothing else runs',
    commands: [command(a, 'hola', HOLA), command(a, 'gracias', 'De nada', { activation: 'keyword', cooldown: 5, keywordSettings: { matchMode: 'anywhere' } })],
    config: { moderation: 'action' }, messages: [[a, VIEWER, '!hola gracias'], [a, VIEWER, 'hola @DomDimaBot']] }));
add((a) => ({ name: 'the AI reply off, then on with a long answer', channels: [[a, { live: true, plan: 'pro' }]],
    messages: [[a, VIEWER, '@domdimabot qué tal']] }));
add((a) => ({ name: 'the AI reply with a long answer, threaded', channels: [[a, { live: true, plan: 'premium' }]],
    config: { ai: { personality: { enabled: true, contextWindow: 3 }, thread: { threadID: 'thread-1', promptContext: [{ timestamp: NOW_MS - 1000, username: 'ViewerOne', message: 'antes' }] },
        answer: { error: false, message: `@ViewerOne ${'respuesta larga del bot '.repeat(30)}fin` } } },
    messages: [[a, VIEWER2, 'hola a todos'], [a, VIEWER, 'Hola @DomDimaBot ¿cómo estás? @DOMDIMABOT']] }));
add((a) => ({ name: 'the AI reply when the personality is unknown and the answer fails', channels: [[a, { live: true }]],
    config: { ai: { personality: null, answer: { error: true, message: 'no' } } },
    messages: [[a, SUB, 'oye @domdimabot']] }));
// Pinned last: a moderator's message sets the reference's process-wide `isMod` (already set by the
// cases above), so a viewer's built-ins get `mod: true` there (intended difference).
add((a) => ({ name: 'a viewer\'s built-ins after a moderator spoke',
    commands: [command(a, 'vanish', '', { func: 'vanish', reserved: true }), command(a, 'duelo', '', { func: 'duel', reserved: true }),
        command(a, 'amor', '', { func: 'amor', reserved: true }), command(a, 'ruleta', '', { func: 'ruletarusa', reserved: true })],
    messages: [[a, MOD, 'hola chat'], [a, VIEWER, '!vanish'], [a, VIEWER, '!duelo @otro'], [a, VIEWER, '!amor @otro'], [a, MOD, '!ruleta']] }));

// ---------------------------------------------------------------------------------------------
// Running them.

const canonical = (doc: unknown) => JSON.parse(EJSON.stringify(doc, { relaxed: false }));

function userOf(id: string, options: { plan?: string; chatEnabled?: boolean }) {
    return {
        _id: oid(0x1000000 + Number(id) % 1000000), name: `Canal${id}`, email: `canal${id}@example.invalid`,
        accounts: [{ _id: oid(0x2000000 + Number(id) % 1000000), type: 'twitch', id, name: `canal${id}`, email: `canal${id}@example.invalid`,
            actived: true, chat_enabled: options.chatEnabled ?? true, has_permissions: true, up_to_date_permissions: true }],
        plan_tier: options.plan ?? 'free', language: 'es', created_at: date(NOW_MS - 86_400_000), updated_at: date(NOW_MS - 86_400_000), __v: 0,
    };
}

function sessionOf(id: string) {
    return { _id: oid(0x4000000 + Number(id) % 1000000), channelID: id, status: 'live', started_at: date(NOW_MS - 3_600_000), ended_at: null,
        title: 'Directo de prueba', game_name: 'Just Chatting', messages: 0, commands: 0, bits: 0, subs: 0, follows: 0, donations: 0,
        created_at: date(NOW_MS - 3_600_000), updated_at: date(NOW_MS - 3_600_000), __v: 0 };
}

let messageCounter = 0;
function eventOf(caseIndex: number, channel: string, from: Chatter, text: string, extra: Record<string, any> = {}) {
    messageCounter += 1;
    return {
        broadcaster_user_id: channel, broadcaster_user_login: `canal${channel}`, broadcaster_user_name: `Canal${channel}`,
        chatter_user_id: from.id, chatter_user_login: from.login, chatter_user_name: from.name,
        message_id: `c0ffee00-0000-4000-8000-${String(caseIndex).padStart(4, '0')}${String(messageCounter).padStart(8, '0')}`,
        message: { text, fragments: [{ type: 'text', text, cheermote: null, emote: null, mention: null }] },
        color: '#1E90FF', badges: from.badges, message_type: 'text', cheer: null, reply: null, channel_points_custom_reward_id: null,
        source_broadcaster_user_id: null, source_broadcaster_user_name: null, source_broadcaster_user_login: null,
        source_message_id: null, source_badges: null, is_source_only: null,
        ...extra,
    };
}

async function settle() {
    let quiet = 0;
    for (let turn = 0; turn < 100_000 && quiet < 30; turn++) {
        await new Promise((resolve) => setTimeout(resolve, turn < 50 ? 0 : 2));
        if (R.metrics.started === R.metrics.ended && R.pending.size === 0) quiet++;
        else quiet = 0;
    }
}

async function dragonflyState(channels: string[], started: number) {
    const state: Record<string, unknown> = {};
    for (const channel of channels) {
        const history = await cache.lRange(`twitch:${channel}:chat:history`, 0, -1);
        if (history.length) state[`twitch:${channel}:chat:history`] = history.map((item: string) => JSON.parse(item));
        const keys = [...await cache.keys(`command:execution:cooldown:${channel}:*`), ...await cache.keys(`twitch:${channel}:variable:*`)].sort();
        for (const key of keys) {
            const pttl = await cache.pTTL(key);
            // Seconds of lifetime as set: what is left plus the time since the case started (+50 ms of rounding).
            const ttl = pttl < 0 ? pttl : Math.floor((pttl + (performance.now() - started) + 50) / 1000);
            state[key] = { type: await cache.type(key), value: await cache.get(key).catch(() => null), ttl };
        }
    }
    return state;
}

async function mongoState() {
    const state: Record<string, unknown[]> = {};
    for (const info of await scratch.listCollections().toArray()) {
        if (['users', 'eventsubs'].includes(info.name)) continue;
        const docs = await scratch.collection(info.name).find({}).sort({ _id: 1 }).toArray();
        if (docs.length) state[info.name] = docs.map(canonical);
    }
    return state;
}

const recorded: unknown[] = [];
try {
    for (const [index, item] of cases.entries()) {
        const caseIndex = index + 1;
        for (const info of await scratch.listCollections().toArray()) await scratch.collection(info.name).deleteMany({});
        const users = item.channels.filter(([, o]) => o.user !== false).map(([id, o]) => userOf(id, o));
        const sessions = item.channels.filter(([, o]) => o.live).map(([id]) => sessionOf(id));
        if (users.length) await scratch.collection('users').insertMany(users);
        if (sessions.length) await scratch.collection('streamsessions').insertMany(sessions);
        if (item.commands?.length) await scratch.collection('commands').insertMany(item.commands);
        if (item.eventsubs?.length) await scratch.collection('eventsubs').insertMany(item.eventsubs);
        for (const command of item.dragonfly ?? []) await cache.sendCommand(command);
        R.config = item.config ?? {};
        R.calls.splice(0);
        R.metrics.started = 0; R.metrics.ended = 0; R.metrics.failed = 0;
        posts.splice(0);
        reseed(caseIndex);
        const started = performance.now();
        const messages: unknown[] = [];
        for (const [channel, from, text, extra] of item.messages) {
            const event = eventOf(caseIndex, channel, from, text, extra);
            messages.push(event);
            const subscription = { id: `sub-${channel}`, status: 'enabled', type: 'channel.chat.message', version: '1',
                condition: { broadcaster_user_id: channel, user_id: BOT }, transport: { method: 'webhook', callback: 'https://example.invalid/eventsub' },
                created_at: TIMESTAMP, cost: 0 };
            const chatEffectContext = createTwitchEffectContext({
                channelId: event.broadcaster_user_id, origin: { kind: 'chat-command', id: event.message_id, occurredAt: TIMESTAMP },
                actor: { userId: event.chatter_user_id, displayName: event.chatter_user_name || '',
                    chat: { login: event.chatter_user_login || '', message: event.message?.text || '',
                        badges: (event.badges || []).map((b: any) => ({ set_id: b.set_id || '', id: b.id || '', info: b.info || '' })) } },
            });
            await eventsubHandler(subscription, event, chatEffectContext ? { chatEffectContext } : {});
            await settle();
        }
        const calls: Record<string, unknown[]> = {};
        for (const call of R.calls) {
            const { kind, ...rest } = call as any;
            (calls[kind] ??= []).push(rest);
        }
        const channels = item.channels.map(([id]) => id);
        recorded.push({
            name: item.name,
            channels: item.channels.map(([id, o]) => ({ id, plan: o.plan ?? 'free', chatEnabled: o.chatEnabled ?? true, live: Boolean(o.live), user: o.user !== false })),
            seed: { users: users.map(canonical), streamsessions: sessions.map(canonical), commands: (item.commands ?? []).map(canonical),
                eventsubs: (item.eventsubs ?? []).map(canonical), dragonfly: item.dragonfly ?? [] },
            config: item.config ?? {},
            messages,
            observed: {
                posts: posts.map((p) => [p.channel, p.text, p.replyTo]),
                calls,
                metrics: { ...R.metrics },
                mongo: await mongoState(),
                dragonfly: await dragonflyState(channels, started),
            },
        });
    }
    writeFileSync(out, JSON.stringify({ reference, sources, nowMs: NOW_MS, timestamp: TIMESTAMP, outbound, cases: recorded }, null, 1) + '\n');
} finally {
    for (const key of await cache.keys('*')) if (!keysBefore.has(key)) await cache.del(key);
    await Promise.all(mongoose.modelNames().map((name: string) => mongoose.model(name).init().catch(() => {})));
    await scratch.dropDatabase();
    await mongoose.disconnect().catch(() => {});
}
process.exit(0);
