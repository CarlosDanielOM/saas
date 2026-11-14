// Owner activity rows for TTS against the exact API candidate: how each made message ended on stream
// (`voice`/`playback`: played after moving off a page that could not start it, failed on the only page) and
// the refusal codes the speech service now sends with a refused request (read by the bot for `voice`/`request`).
// Disposable Mongo/Redis and the Fish provider mocks; no real accounts, keys or credits:
//   scripts/saas-ops verify api-<run> --dependency mongo --dependency redis \
//     --fixtures ops/checks/fish-fixtures --test-env ops/checks/fish-fixtures/test-env.json \
//     --check ops/checks/admin-console-tts-activity-api.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// 1. The candidate's own unit tests for these rows (and the queue they hook into).
for (const file of ['utils/tts/tts_activity', 'schemas/activity_log.schema', 'utils/activity_command', 'handlers/tts_delivery', 'handlers/tts_controls']) {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test-force-exit', '--test', `/app/dist/${file}.test.js`],
    { stdio: 'inherit', timeout: 90_000, env: { ...process.env, NODE_OPTIONS: '' } });
}
console.log('PASS: candidate unit tests (row mapping, problem rule, command errors, delivery, controls)');

// 2. The real server.
const requireApp = createRequire('/app/package.json');
const { createClient } = requireApp('redis');
const { MongoClient } = requireApp('mongodb');
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
const mongo = new MongoClient('mongodb://mongo:27017/saas_ops_fish_test');
await mongo.connect();
const db = mongo.db();
const channel = '999993';
const namespace = `/speech/${channel}`;

const wait = async (condition, message, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

/** A raw Socket.IO client for one current speech page. */
function speechPage(name, pageId) {
  const page = { name, events: [], open: false };
  const ws = page.ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  page.send = (event, payload) => ws.send(`42${namespace},${JSON.stringify([event, payload])}`);
  ws.addEventListener('message', event => {
    const data = String(event.data);
    if (data === '2') return ws.send('3');
    if (data.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify({ v: 2, pageId })}`);
    if (data.startsWith(`40${namespace},`)) { page.open = true; return; }
    const match = data.match(/^42([^,]*),(\d*)(\[[\s\S]*\])$/);
    if (!match || match[1] !== namespace) return;
    const [eventName, payload] = JSON.parse(match[3]);
    page.events.push([eventName, payload]);
    if (eventName === 'speech-cancel' && match[2]) ws.send(`43${namespace},${match[2]}${JSON.stringify([{ stopped: true, started: false }])}`);
  });
  page.got = (eventName, speechID) => page.events.filter(([type, payload]) => type === eventName && (!speechID || payload?.speechID === speechID)).length;
  page.state = () => page.send('speech-state', { v: 2, pageId, visible: true, obs: true, played: true, probe: 'ok' });
  page.close = () => ws.close();
  return page;
}

const post = async body => {
  const response = await fetch(`http://127.0.0.1:3000/speech/${channel}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'clone', cloneName: 'rias_gremory', language: 'en', requestedBy: { userID: '7001', userLogin: 'check_viewer', userName: 'Check_Viewer' }, ...body }),
  });
  return { status: response.status, body: await response.json() };
};
const processing = () => redis.get(`twitch:${channel}:tts:processing`);
const playbackRow = async speechID => db.collection('activity_logs').findOne({ channelID: channel, kind: 'voice', name: 'playback', ref: speechID });

const pages = [];
try {
  // Rows are only written for channels that still have an account.
  await db.collection('users').insertOne({ name: 'TTS Activity Fixture', accounts: [{ type: 'twitch', id: channel, name: 'ttsactivity' }] });
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'ttsactivity', polar_sh_customer_id: 'test-customer', plan_tier: 'premium' });
  await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 10000, balance: 10000, available: true, status: 'available' }));

  // Refusals carry a code the bot turns into a reason. No page open: 409 no_speech_page.
  const noPage = await post({ text: 'nobody is listening' });
  assert.deepEqual([noPage.status, noPage.body.code], [409, 'no_speech_page'], JSON.stringify(noPage.body));
  await db.collection('channel_tts_settings').updateOne({ channelID: channel }, { $set: { channelID: channel, channel: 'ttsactivity', enabled: false, provider: 'fish' } }, { upsert: true });
  const off = await post({ text: 'tts is off' });
  assert.deepEqual([off.status, off.body.code], [403, 'tts_disabled'], JSON.stringify(off.body));
  await db.collection('channel_tts_settings').updateOne({ channelID: channel }, { $set: { enabled: true } });
  console.log('PASS: a refused request says why with a code (no_speech_page, tts_disabled)');

  // Two current pages. The first cannot start the sound: the message moves and plays on the second.
  const first = speechPage('first', 'page-first-00001');
  const second = speechPage('second', 'page-second-0001');
  pages.push(first, second);
  await wait(() => pages.every(page => page.got('speech-reset') > 0), 'pages synchronised');
  for (const page of pages) page.state();
  await new Promise(resolve => setTimeout(resolve, 300));
  const one = await post({ text: 'First sentence' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const moved = one.body.data.speechID;
  await wait(() => first.got('speech', moved) + second.got('speech', moved) === 1, 'message sent to one page');
  const [failing, playing] = first.got('speech', moved) ? [first, second] : [second, first];
  failing.send('speech-ended', { speechID: moved, reason: 'play-error', position: 0 });
  await wait(() => playing.got('speech', moved) === 1, 'moved to the other page');
  playing.send('speech-playback', { speechID: moved, phase: 'playing', position: 0 });
  playing.send('speech-playback', { speechID: moved, phase: 'progress', position: 0.6 });
  playing.send('speech-ended', { speechID: moved, reason: 'ended', position: 1, started: true });
  await wait(async () => await processing() !== moved, 'first message finished');
  await wait(async () => !!await playbackRow(moved), 'played row written', 10_000);
  const played = await playbackRow(moved);
  assert.deepEqual([played.outcome, played.reason, played.actorLogin, played.service], ['ok', '', 'check_viewer', 'api']);
  assert.deepEqual([played.data.movedBecause, played.data.pages, played.data.heard, played.data.provider], ['play-error', 2, true, 'fish']);
  assert.ok(played.durationMs > 0);
  console.log('PASS: a message that moved off a failing page and played leaves one ok row that says it moved and why');

  // Only one page left, and it cannot start the sound: nowhere to move, so it did not play.
  playing.close();
  pages.splice(pages.indexOf(playing), 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  const two = await post({ text: 'Second sentence' });
  assert.equal(two.status, 200, JSON.stringify(two.body));
  const lost = two.body.data.speechID;
  await wait(() => failing.got('speech', lost) === 1, 'second message to the remaining page');
  failing.send('speech-ended', { speechID: lost, reason: 'play-error', position: 0 });
  await wait(async () => !!await playbackRow(lost), 'failed row written', 10_000);
  const failed = await playbackRow(lost);
  assert.deepEqual([failed.outcome, failed.reason, failed.data.heard, failed.data.pages, failed.data.endReason], ['failed', 'play_error', false, 1, 'play-error']);
  assert.equal(await db.collection('activity_logs').countDocuments({ channelID: channel, kind: 'voice', name: 'playback' }), 2, 'one row per message');
  // The feed's problem filter finds the failure and not the played message.
  const problems = await db.collection('activity_logs').find({ channelID: channel, outcome: { $in: ['skipped', 'blocked', 'failed'], $ne: 'skipped' },
    $nor: [{ outcome: 'blocked', reason: { $in: ['permission_denied'] } }] }).toArray();
  assert.deepEqual(problems.map(row => row.ref), [lost]);
  console.log('PASS: a message the only page could not play leaves one failed row with the page\'s reason');
} finally {
  for (const page of pages) page.close();
  await redis.quit();
  await mongo.close();
}
