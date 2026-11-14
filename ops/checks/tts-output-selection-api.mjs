// TTS output selection against the exact API candidate: which speech page gets a message, the
// cancel handshake, moving a failed message to another page, older pages, and "every page" mode.
// Run with disposable Mongo/Redis and the Fish provider mocks (no real accounts, keys or credits):
//   scripts/saas-ops verify api-<run> --dependency mongo --dependency redis \
//     --fixtures ops/checks/fish-fixtures --test-env ops/checks/fish-fixtures/test-env.json \
//     --check ops/checks/tts-output-selection-api.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// 1. The candidate's own unit tests for this area.
for (const file of ['tts_outputs', 'tts_delivery', 'tts_controls', 'tts_pet_lane', 'tts_queue_credits']) {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test-force-exit', '--test', `/app/dist/handlers/${file}.test.js`],
    { stdio: 'inherit', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' } });
}
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test-force-exit', '--test', '/app/dist/pets/read_tts.test.js'],
  { stdio: 'inherit', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' } });
console.log('PASS: candidate unit tests (ranking, delivery, controls, pet lane, credits, read-TTS)');

// 2. The real server: routes, namespace, ranking and moving between pages.
const requireApp = createRequire('/app/package.json');
const { createClient } = requireApp('redis');
const { MongoClient } = requireApp('mongodb');
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
const mongo = new MongoClient('mongodb://mongo:27017/saas_ops_fish_test');
await mongo.connect();
const channel = '999992';
const namespace = `/speech/${channel}`;

const wait = async (condition, message, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

/** A raw Socket.IO client for one speech page. `auth` = what a current page sends; null = an older page. */
function speechPage(name, auth) {
  const page = { name, events: [], cancels: [], cancelReply: { stopped: true, started: false }, open: false };
  const ws = page.ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  page.send = (event, payload) => ws.send(`42${namespace},${JSON.stringify([event, payload])}`);
  ws.addEventListener('message', event => {
    const data = String(event.data);
    if (data === '2') return ws.send('3');
    if (data.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify(auth ?? {})}`);
    if (data.startsWith(`40${namespace},`)) { page.open = true; return; }
    const match = data.match(/^42([^,]*),(\d*)(\[[\s\S]*\])$/);
    if (!match || match[1] !== namespace) return;
    const [eventName, payload] = JSON.parse(match[3]);
    page.events.push([eventName, payload]);
    if (eventName === 'speech-cancel' && match[2]) {
      page.cancels.push(payload.speechID);
      if (page.cancelReply) ws.send(`43${namespace},${match[2]}${JSON.stringify([page.cancelReply])}`);
    }
  });
  page.got = (eventName, speechID) => page.events.filter(([type, payload]) => type === eventName && (!speechID || payload?.speechID === speechID)).length;
  page.close = () => ws.close();
  return page;
}

const request = async text => {
  const response = await fetch(`http://127.0.0.1:3000/speech/${channel}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'clone', cloneName: 'rias_gremory', text, language: 'en' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.speechID;
};
const processing = () => redis.get(`twitch:${channel}:tts:processing`);

const pages = [];
try {
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'test', polar_sh_customer_id: 'test-customer', plan_tier: 'premium' });
  await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 10000, balance: 10000, available: true, status: 'available' }));

  // A hidden OBS source whose audio is held back, a visible one that played its probe, and an older page.
  const hidden = speechPage('hidden', { v: 2, pageId: 'page-hidden-0001' });
  const visible = speechPage('visible', { v: 2, pageId: 'page-visible-0001' });
  const older = speechPage('older', null);
  pages.push(hidden, visible, older);
  await wait(() => pages.every(page => page.got('speech-reset') > 0), 'all pages synchronised');
  hidden.send('speech-state', { v: 2, pageId: 'page-hidden-0001', visible: false, obs: true, played: false, probe: 'pending' });
  visible.send('speech-state', { v: 2, pageId: 'page-visible-0001', visible: true, obs: true, played: true, probe: 'ok' });
  await new Promise(resolve => setTimeout(resolve, 3_200)); // the hidden page's probe is now "held back"

  // One page mode (default): the visible page gets it, not the lowest socket id.
  const first = await request('First sentence');
  await wait(() => visible.got('speech', first) === 1, 'first message to the visible page');
  assert.equal(hidden.got('speech') + older.got('speech'), 0);
  // It downloads and says ready, but never starts: after ~8 s it is cancelled and the message moves on.
  visible.send('speech-playback', { speechID: first, phase: 'loading', position: 0 });
  visible.send('speech-playback', { speechID: first, phase: 'ready', position: 0 });
  await wait(() => older.got('speech', first) === 1, 'moved to the next page after the start deadline', 15_000);
  assert.deepEqual(visible.cancels, [first], 'the stuck page was asked to stop and confirmed');
  assert.equal(hidden.got('speech'), 0, 'the hidden page is still last');
  assert.equal(await processing(), first, 'the queue still waits for this message');
  // The older page fails to play: the last untried page (hidden) gets it, and plays it.
  older.send('speech-ended', { speechID: first, reason: 'play-error', position: 0 });
  await wait(() => hidden.got('speech', first) === 1, 'moved to the third page');
  const sent = pages.map(page => page.events.find(([type, payload]) => type === 'speech' && payload.speechID === first)?.[1]);
  assert.ok(sent.every(payload => payload && payload.audioUrl === sent[0].audioUrl), 'the same audio file, never synthesized again');
  hidden.send('speech-playback', { speechID: first, phase: 'playing', position: 0 });
  hidden.send('speech-playback', { speechID: first, phase: 'progress', position: 0.6 });
  // Late reports from pages it left are ignored.
  visible.send('speech-ended', { speechID: first, reason: 'ended', position: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await processing(), first);
  hidden.send('speech-ended', { speechID: first, reason: 'ended', position: 1, started: true });
  await wait(async () => await processing() !== first, 'first message finished');

  // The page that played last time (hidden, now visible) wins; the two that failed rank lower.
  hidden.send('speech-state', { v: 2, pageId: 'page-hidden-0001', visible: true, obs: true, played: true, probe: 'ok' });
  const second = await request('Second sentence');
  await wait(() => hidden.got('speech', second) === 1, 'second message to the page that worked');
  hidden.send('speech-playback', { speechID: second, phase: 'playing', position: 0 });
  hidden.send('speech-ended', { speechID: second, reason: 'ended', position: 1, started: true });
  await wait(async () => !await redis.exists(`twitch:${channel}:tts:processing`), 'second message finished');

  // Every page mode, saved in the channel settings: all open pages get each message.
  await mongo.db().collection('channel_tts_settings').updateOne({ channelID: channel },
    { $set: { channelID: channel, channel: 'test', enabled: true, provider: 'fish', playback: { allOutputs: true } } }, { upsert: true });
  const third = await request('Third sentence');
  await wait(() => pages.every(page => page.got('speech', third) === 1), 'every page got the third message');
  for (const page of [hidden, visible]) page.send('speech-playback', { speechID: third, phase: 'playing', position: 0 });
  hidden.send('speech-ended', { speechID: third, reason: 'ended', position: 1, started: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await processing(), third, 'waits for the other page that started');
  const resetsBefore = older.got('speech-reset');
  visible.send('speech-ended', { speechID: third, reason: 'ended', position: 1, started: true });
  await wait(async () => !await redis.exists(`twitch:${channel}:tts:processing`), 'third message finished');
  assert.ok(older.got('speech-reset') > resetsBefore, 'the page that never started is stopped');
  console.log('PASS: runtime picks a page that can play, cancels a stuck page, moves the same audio, ignores stale pages, and plays on every page when asked');
} finally {
  for (const page of pages) page.close();
  await redis.quit();
  await mongo.close();
}
