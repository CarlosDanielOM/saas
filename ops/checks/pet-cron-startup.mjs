// Narrow companion to the scheduled pet behavior check. No native workload or
// failure injection: actual packaged native index/children, startup identity only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
assert.equal(process.env.SAAS_TARGET, 'cron');
assert.equal(process.env.MONGO_URI, 'mongodb://mongo:27017/saas_ops_pet_producer_test');
assert.equal(process.env.PET_PRODUCER_NATIVE_STARTUP, 'true');
assert.equal(process.env.AI_USAGE_RECEIPTS_ENABLED, 'true', 'all seven unchanged native children enabled');
const expected = JSON.parse(readFileSync('/tmp/saas-fixtures/cron-artifacts.json', 'utf8'));
const names = ['cron_index', 'stream_activity', 'raid_analytics', 'roulette_completion',
  'follow_defense_baseline', 'ai_usage_receipts', 'raid_sessions', 'dashboard_activity'];
assert.deepEqual(Object.keys(expected.binaries).sort(), [...names].sort());
for (const name of names) {
  const hash = createHash('sha256').update(readFileSync(`/usr/local/bin/${name}`)).digest('hex');
  assert.equal(hash, expected.binaries[name], `${name} matches exact build receipt`);
}
const require = createRequire('/app/package.json');
const { createClient } = require('redis');
const redis = createClient({ url: 'redis://redis:6379', socket: { reconnectStrategy: false } });
redis.on('error', () => {});
function records() {
  const text = readFileSync('/tmp/pet-cron-processes.jsonl', 'utf8');
  return text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse);
}
function processInfo(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return { pid, parent: Number(status.match(/^PPid:\s+(\d+)/m)[1]),
    uid: Number(status.match(/^Uid:\s+\d+\s+(\d+)/m)[1]), gid: Number(status.match(/^Gid:\s+\d+\s+(\d+)/m)[1]),
    state: status.match(/^State:\s+(\w)/m)[1], cmd: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
}
async function until(fn, label) {
  const end = Date.now() + 25_000;
  do { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
try {
  await redis.connect();
  const row = await until(() => records().find(row => row.type === 'spawn' && row.command === '/usr/local/bin/cron_index'), 'native index spawn');
  assert.equal(row.real, true, 'native index is not an inert fixture child');
  const index = processInfo(row.pid);
  assert.equal(index.parent, 1); assert.equal(index.uid, 65534); assert.equal(index.gid, 65534);
  assert.deepEqual(index.cmd, ['/usr/local/bin/cron_index']);
  const children = () => {
    const found = {};
    for (const pid of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
      let info;
      try { info = processInfo(Number(pid)); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
      if (info.parent !== index.pid) continue;
      const name = info.cmd[0]?.replace('/usr/local/bin/', '');
      if (!names.includes(name) || name === 'cron_index') continue;
      assert.equal(found[name], undefined, `one ${name} child`);
      assert.equal(info.uid, 65534); assert.equal(info.gid, 65534);
      assert.ok(!['Z', 'X'].includes(info.state), `${name} alive`);
      found[name] = info;
    }
    return Object.keys(found).length === 7 && found;
  };
  const initial = await until(children, 'all seven real native children');
  for (let sample = 0; sample < 3; sample++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const current = children(); assert.ok(current);
    for (const name of Object.keys(initial)) assert.equal(current[name].pid, initial[name].pid, `${name} stable startup PID`);
    assert.equal(processInfo(index.pid).parent, 1);
  }
  const edges = records();
  const dispatch = edges.find(row => row.type === 'spawn' && row.worker === 'domain-events');
  assert.ok(dispatch?.real); assert.equal(processInfo(dispatch.pid).parent, 1);
  const consumer = edges.find(row => row.type === 'fork' && row.consumer === 'chat-announcements-v1');
  assert.ok(consumer?.real); assert.equal(processInfo(consumer.pid).parent, dispatch.pid);
  assert.equal(await redis.lLen('pet:producer:outbound'), 0, 'startup invokes no paid providers');
  console.log(JSON.stringify({ run: expected.run, image: expected.image, rustSourceDigest: expected.rustSourceDigest,
    nativeIndex: index, nativeChildren: initial, receiptBinaryDigests: expected.binaries,
    unrelatedTypeScriptChildrenInert: edges.filter(row => row.type === 'spawn' && !row.real).map(row => row.worker) }));
  console.log('PASS cron startup: eight receipt binary identities, actual index plus seven stable native children; real dispatcher/consumer; no paid outbound');
} finally {
  if (redis.isOpen) await redis.quit();
}
