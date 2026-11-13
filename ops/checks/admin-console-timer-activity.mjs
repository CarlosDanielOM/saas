// A chat timer that fires still posts its message, and leaves owner-only activity rows saying so.
// Run on the cron target (timers run in dima-cron) with the alert check's fixtures, which mock Twitch and keep
// the supervisor's other workers inert:
//   scripts/saas-ops verify cron-<run-id> --check ops/checks/admin-console-timer-activity.mjs \
//     --dependency mongo --dependency redis \
//     --test-env ops/checks/admin-console-alert-activity-fixtures/test-env.json \
//     --fixtures ops/checks/admin-console-alert-activity-fixtures
// The candidate's real timer worker runs one tick (`--once`) under its own lock key. One timer is due, one is
// not yet due and one is switched off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const dist = '/app/dist';
const directory = '/tmp/saas-fixtures';
const load = path => import(`${dist}/${path}`);
const { getMongoDBConnection } = await load('utils/databases/mongodb.database.js');
const { getDragonflyClient } = await load('utils/databases/dragonfly.database.js');
const { default: UsersSchema } = await load('schemas/users.schema.js');
const { ActivityLog } = await load('schemas/activity_log.schema.js');

const chats = () => fs.existsSync(`${directory}/calls.jsonl`)
    ? fs.readFileSync(`${directory}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.chat).map(call => call.chat) : [];
async function until(check, label, ms = 40_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail(`Timed out: ${label}`);
}

await getMongoDBConnection('TimerActivityCheck');
const redis = await getDragonflyClient('TimerActivityCheck');
await ActivityLog.init();

const CHANNEL = '99008801';
await UsersSchema.create({ name: 'timerhost', accounts: [{ type: 'twitch', id: CHANNEL, name: 'timerhost', actived: true, has_permissions: true, chat_enabled: true }] });
await redis.hSet(`accounts:twitch:${CHANNEL}:data`, {
    id: CHANNEL, name: 'timerhost', actived: 'true', has_permissions: 'true', chat_enabled: 'true', plan_tier: 'premium',
    access_token: 'dummy-streamer-token', expires_at: String(Math.floor(Date.now() / 1000) + 3600)
});
await redis.set('app:twitch:token', 'app-token');
const timers = {
    due: { _id: 'due', name: 'hydrate', frequency: 1, frequencyUnit: 'minutes', message: 'Remember to drink water, $(channel) chat!', active: true },
    later: { _id: 'later', name: 'socials', frequency: 5, frequencyUnit: 'minutes', message: 'Follow the socials', active: true },
    off: { _id: 'off', name: 'old', frequency: 1, frequencyUnit: 'minutes', message: 'Switched off', active: false }
};
await redis.sAdd('timer:active', CHANNEL);
await redis.hSet(`timer:channel:${CHANNEL}:timers`, Object.fromEntries(Object.entries(timers).map(([id, timer]) => [id, JSON.stringify(timer)])));

async function tick() {
    const child = spawn(process.execPath, [`${dist}/workers/timer.worker.js`, '--once'], {
        cwd: '/app', stdio: 'inherit', env: { ...process.env, TIMER_WORKER_LOCK_KEY: 'worker:timer:lock:activity-check' }
    });
    return child;
}

const before = chats().length;
const worker = await tick();
try {
    await until(() => chats().length > before, 'the due timer posts its message');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const sent = chats().slice(before);
    assert.equal(sent.length, 1, `only the due timer posts: ${JSON.stringify(sent)}`);
    assert.equal(sent[0].broadcaster_id, CHANNEL);
    assert.match(sent[0].message, /^Remember to drink water, .* chat!$/, 'the rendered timer text is what gets sent');
    console.log('PASS the due timer posts once; the timer that is not due and the switched-off timer stay silent');

    await until(async () => await ActivityLog.countDocuments({ channelID: CHANNEL }) >= 2, 'the worker writes its activity rows');
    const rows = await ActivityLog.find({ channelID: CHANNEL }).lean();
    assert.equal(rows.length, 2, `one timer row and one bot message row: ${JSON.stringify(rows.map(row => [row.kind, row.outcome, row.reason]))}`);
    const command = rows.find(row => row.kind === 'command');
    const message = rows.find(row => row.kind === 'bot_message');
    assert.ok(command && message, 'a command row and a bot_message row');
    assert.deepEqual([command.outcome, command.reason || null], ['ok', null]);
    assert.equal(JSON.stringify(command).includes('hydrate'), true, 'the timer row names the timer');
    assert.equal(JSON.stringify(command).includes('timer'), true, 'the timer row says a timer fired it');
    assert.deepEqual([message.outcome, message.reason || null], ['ok', null]);
    assert.equal(JSON.stringify(message).includes('timer'), true, 'the bot message row says it came from a timer');
    assert.match(String(message.text || ''), /Remember to drink water/, 'the bot message row carries what was sent');
    for (const row of rows) assert.ok(row.expiresAt instanceof Date && row.expiresAt > new Date(), 'rows expire on their own');
    assert.equal(await redis.get(`timer:channel:${CHANNEL}:heartbeat:due`), '0', 'the fired timer starts counting again');
    assert.equal(await redis.get(`timer:channel:${CHANNEL}:heartbeat:later`), '1', 'the other timer moved one minute closer');
    console.log('PASS the timer leaves a command row (ok) and a bot message row (ok, from a timer); heartbeats advance as before');
} finally {
    worker.kill('SIGTERM');
}
process.exit(0);
