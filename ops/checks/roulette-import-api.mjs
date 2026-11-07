// Roulette bulk import against the actual API entrypoint (run with SAAS_TARGET=api) and
// disposable Mongo/Redis. Covers the production body-size parser order, all-or-nothing
// imports, row-level errors, replace semantics, idempotent replay and concurrent writers.
import assert from 'node:assert/strict';
assert.equal(process.env.SAAS_TARGET, 'api', 'run against the api candidate: it tests the real middleware order');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const svc = await import('/app/dist/roulette/service.js');
const mongo = await getMongoDBConnection('roulette-import-check');
const redis = await getDragonflyClient('roulette-import-check');
await svc.RouletteChannel.init();
const channel = '990021';
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'free' });
await redis.hSet('token:roulette-import-owner', { id: channel, login: 'importer', display_name: 'Importer' });
const base = 'http://127.0.0.1:3000';
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${base}/roulettes/${channel}`)).status === 401) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const root = `/roulettes/${channel}`;
async function call(method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer roulette-import-owner', 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json };
}
async function ok(method, path, body, headers) {
  const res = await call(method, path, body, headers);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data;
}
const state = () => ok('GET', root);
const roulette = async () => (await state()).roulettes.find((r) => r.id === id);

const id = (await ok('POST', root + '/roulettes', { name: 'Import check', alias: 'import-check', design: 'wheel', durationSeconds: 1 })).result;
const path = `${root}/roulettes/${id}`;

// 1. 10k prizes in one request (~300 KB, over the old 100 KB default parser).
const names = Array.from({ length: 10000 }, (_, i) => ({ label: `Viewer name number ${i}`, weight: 1, multiplier: 1 }));
assert(Buffer.byteLength(JSON.stringify({ items: names })) > 200 * 1024);
const big = await ok('POST', path + '/import', { items: names }, { 'Idempotency-Key': 'big-1' });
assert.equal(big.result, '10000');
let r = await roulette();
assert.equal(r.items.length, 10000);
assert.equal(r.order.length, 10000);

// 2. Over capacity (wheel 10000): refused, nothing saved.
let rev = (await state()).revision;
let res = await call('POST', path + '/import', { items: [{ label: 'One more' }] });
assert.equal(res.status, 400); assert.equal(res.json.code, 'capacity');
assert.equal((await state()).revision, rev, 'refused import does not save');

// 3. Replace with a stale If-Match is refused; with the current one it swaps everything atomically.
res = await call('POST', path + '/import', { items: [{ label: 'A' }], replace: true }, { 'If-Match': String(rev - 1) });
assert.equal(res.status, 409); assert.equal(res.json.code, 'revision_conflict');
const replaceBody = { items: [{ label: 'VIP', weight: 5, multiplier: 2 }, { label: 'Hug' }, { label: 'Timeout', action: '$(user) loses' }], replace: true };
await ok('POST', path + '/import', replaceBody, { 'If-Match': String(rev), 'Idempotency-Key': 'replace-1' });
r = await roulette();
assert.deepEqual(r.items.map((i) => [i.label, i.weight, i.multiplier, i.action]), [['VIP', 5, 2, ''], ['Hug', 1, 1, ''], ['Timeout', 1, 1, '$(user) loses']]);
assert.equal(r.order.length, 4);

// 4. Lost response: the retry with the same key (and now-stale If-Match) replays instead of duplicating.
const replay = await ok('POST', path + '/import', replaceBody, { 'If-Match': String(rev), 'Idempotency-Key': 'replace-1' });
assert.equal(replay.replayed, true);
assert.equal((await roulette()).order.length, 4);
res = await call('POST', path + '/import', { items: [{ label: 'Other' }] }, { 'Idempotency-Key': 'replace-1' });
assert.equal(res.status, 409); assert.equal(res.json.code, 'idempotency_conflict');

// 5. A bad row late in the list rejects the whole import and names the row.
rev = (await state()).revision;
const late = Array.from({ length: 600 }, (_, i) => ({ label: `Row ${i + 1}` }));
late[540] = { label: 'Bad', weight: 0 };
res = await call('POST', path + '/import', { items: late });
assert.equal(res.status, 400); assert.equal(res.json.code, 'invalid'); assert.equal(res.json.row, 541);
assert.match(res.json.message, /^Prize 541:/);
res = await call('POST', path + '/import', { items: [{ label: 'ok' }, { label: 'ok 2' }, { label: 'Cmd', action: '$(unclosed' }] });
assert.equal(res.status, 400); assert.equal(res.json.code, 'invalid_action'); assert.equal(res.json.row, 3);
res = await call('POST', path + '/import', { items: [{ label: 'ok' }], surprise: true });
assert.equal(res.status, 400);
res = await call('POST', path + '/import', { items: [] });
assert.equal(res.status, 400);
assert.equal((await state()).revision, rev, 'no partial import was saved');

// 6. 'increase' joins same names and flags weight clashes by row.
await ok('PATCH', path, { settings: { duplicate: 'increase' } });
await ok('POST', path + '/import', { items: [{ label: 'Hug', multiplier: 2 }, { label: 'New' }] });
r = await roulette();
assert.equal(r.items.find((i) => i.label === 'Hug').multiplier, 3);
res = await call('POST', path + '/import', { items: [{ label: 'Fine' }, { label: 'VIP', weight: 1 }] });
assert.equal(res.status, 409); assert.equal(res.json.code, 'weight_conflict'); assert.equal(res.json.row, 2);

// 7. Replace waits for a spin to finish, then clears the old winner from the overlay.
await ok('POST', root + '/actions/switch', { roulette: id });
await svc.execute(channel, { operation: 'start', roulette: id });
res = await call('POST', path + '/import', { items: [{ label: 'Mid-spin' }], replace: true });
assert.equal(res.status, 409); assert.equal(res.json.code, 'spinning');
await ok('POST', path + '/import', { items: [{ label: 'Append during spin is fine' }] });
await new Promise((resolve) => setTimeout(resolve, 1300));
assert.notEqual((await state()).draw, null, 'completed draw stays until replaced');
await ok('POST', path + '/import', { items: [{ label: 'Fresh' }], replace: true });
const after = await state();
assert.equal(after.draw, null); assert.equal(after.hideAt, null);
assert.deepEqual(after.roulettes.find((x) => x.id === id).items.map((i) => i.label), ['Fresh']);

// 8. Concurrent writers: imports and single adds all land (compare-and-swap retries).
await Promise.all([
  ...Array.from({ length: 4 }, (_, n) => svc.execute(channel, { operation: 'import', roulette: id, data: { items: Array.from({ length: 10 }, (_, i) => ({ label: `C${n}-${i}` })) } }, `concurrent-import-${n}`)),
  ...Array.from({ length: 4 }, (_, n) => svc.execute(channel, { operation: 'add', roulette: id, data: { label: `Single ${n}` } }, `concurrent-add-${n}`)),
]);
r = await roulette();
assert.equal(r.items.length, 1 + 40 + 4);
assert.equal(new Set(r.order).size, r.order.length);

// 9. Bodies over 4 MB are refused before reaching the route.
res = await call('POST', path + '/import', JSON.stringify({ items: [{ label: 'x'.repeat(5 * 1024 * 1024) }] }));
assert.equal(res.status, 413);

console.log('PASS api: 10k-prize import through the real parser, capacity, stale revision, replace, lost-response replay, late-row rollback with row numbers, AST validation, increase/weight clash, replace vs spin + overlay reset, concurrent writers, 4 MB limit');
await redis.quit(); await mongo.disconnect(); process.exit(0);
