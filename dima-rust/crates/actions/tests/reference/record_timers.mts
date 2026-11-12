// Records the reference's AST timers (`utils/ast_timer_runtime.ts`), the carried `ast:timers:*`
// family, for `tests/timers.rs`: for each case, the job the TypeScript writes when a command
// schedules a timer (the payload as written, the index scores, the key lifetimes), then what the
// TypeScript's own executor posts when that job runs.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC DRAGONFLY_HOST=127.0.0.1 DRAGONFLY_PORT=6379/8 \
//     SECRET_KEY=dima-actions-test-key OBSERVABILITY_DISABLED=true DOMAIN_EVENTS_WAKEUPS_ENABLED=false \
//     node_modules/.bin/tsx /path/to/dima-rust/crates/actions/tests/reference/record_timers.mts \
//     /path/to/dima-rust/crates/actions/tests/fixtures/timers_recorded.json
//
// The outside world is mocked by `harness.mts`. The texts are synthetic (no streamer content).
// Each case renders its text with `parseSpecialCommands` for channel 1001 (a Premium channel)
// with a chat event as context, with the randomness reseeded with the case's position; the job
// is read back raw, then claimed and run with `AstTimerScheduler`'s own `fire` (through a
// scheduler instance whose clock has moved past the due time) and delivered, which posts to the
// mocked Twitch.
import { writeFileSync } from 'node:fs';
import { posts, imported, scratch, cache, finish, reseed, stubGroups, NOW_MS } from './harness.mts';

const out = process.argv[2];
if (!out) throw new Error('usage: record_timers.mts <out.json>');

const CHANNEL = '1001';
const CASES: [string, string][] = [
    ['plain', 'now $(timer 30 later)'],
    ['variables and the argument', '%(who Ana)$(timer 5 hola %(who) &p1 y &t)'],
    ['a list and a count', '%(l %[1, "dos", "😀 tres"])$(scount)$(timer 61.4 items: %(l.length) count $(count))'],
    ['a reference in the body', '$(timer 2 #(ref) pong)'],
    ['nested timers', '$(timer 1 one $(timer 1 two))'],
    ['user and event', '$(timer 10 $(user) / $(touser))'],
    ['a failing body', '$(timer 3 before $(ban x) after)'],
    ['emoji and rtl', '$(timer 4 ¡Hola 👋 مرحبا ✋🏽!)'],
];
const event = {
    broadcaster_user_id: CHANNEL, broadcaster_user_login: 'streamer', broadcaster_user_name: 'Streamer',
    chatter_user_id: '5001', chatter_user_login: 'viewerone', chatter_user_name: 'ViewerOne', message_id: 'chat-1',
    badges: [], message: { text: '!x uno dos tres', fragments: [] },
};

const { parseSpecialCommands } = await imported('src/handlers/special_parser.handler.ts');
const { deliverAstMessage } = await imported('src/utils/ast_command_delivery.ts');
const runtime = await imported('src/utils/ast_timer_runtime.ts');
await stubGroups();
await scratch.collection('users').insertOne({ accounts: [{ type: 'twitch', id: CHANNEL, name: 'streamer', chat_enabled: true, actived: true }], plan_tier: 'premium', __v: 0 });
await scratch.collection('commands').insertOne({ cmd: 'ref', name: 'ref', message: 'from ref', channelID: CHANNEL, enabled: true, cooldown: 0, count: 0, userLevel: 0, type: 'command', func: 'custom', reserved: false, platform: 'twitch', __v: 0 });
await cache.set('app:twitch:token', 'app-token-recorder', { EX: 86400 });

const recorded: unknown[] = [];
try {
    for (const [index, [name, text]] of CASES.entries()) {
        posts.splice(0);
        for (const key of await cache.keys('ast:timers:*')) await cache.del(key);
        reseed(1000 + index);
        const parsed = await parseSpecialCommands(text, { channelID: CHANNEL, eventData: event, argument: 'uno dos tres', literalArguments: true });
        await deliverAstMessage(CHANNEL, parsed);
        const scheduled = posts.splice(0).map(p => p.text);
        const ids: string[] = await cache.zRange('ast:timers:pending', 0, -1);
        const jobs = [];
        for (const id of ids) {
            const payload = await cache.get(`ast:timers:job:${id}`);
            const pending = await cache.zScore('ast:timers:pending', id);
            const byChannel = await cache.zScore(`ast:timers:channel:${CHANNEL}`, id);
            jobs.push({ id, payload, pending, byChannel });
        }
        const channelExpiry = await cache.sendCommand(['PEXPIRETIME', `ast:timers:channel:${CHANNEL}`]).catch((e: any) => String(e?.message));
        // Run each job with the reference's executor (claim, evaluate, deliver).
        const fired: string[][] = [];
        for (const job of jobs) {
            const due = JSON.parse(job.payload).dueAt;
            (globalThis as any).Date.now = () => due;
            const scheduler = new runtime.AstTimerScheduler(cache);
            (scheduler as any).stopped = false;
            await (scheduler as any).fire(job.id);
            (globalThis as any).Date.now = () => NOW_MS;
            fired.push(posts.splice(0).map(p => p.text));
        }
        // Timers the jobs scheduled in turn (nested): their payloads.
        const nested: string[] = [];
        for (const id of await cache.zRange('ast:timers:pending', 0, -1)) nested.push(await cache.get(`ast:timers:job:${id}`));
        recorded.push({ name, text, seed: 1000 + index, scheduled, jobs, channelExpiry, fired, nested });
    }
    writeFileSync(out, JSON.stringify({ nowMs: NOW_MS, channel: CHANNEL, cases: recorded }, null, 1) + '\n');
} finally {
    for (const key of await cache.keys('ast:timers:*')) await cache.del(key);
    await finish();
}
process.exit(0);
