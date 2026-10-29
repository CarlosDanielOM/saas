'use strict';
// Actual installed SDK oracle. Execute only in the parent's isolated snapshot.
// No application module is evaluated; its constructor options are read via AST.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const ts = require('typescript');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.v8, '13.6.233.17-node.58');
assert.equal(ts.version, '5.9.3');
const [mode, directory, ...extra] = process.argv.slice(2);
assert(['--write', '--check'].includes(mode) && directory && extra.length === 0,
  'use --write NEW_DIR or --check EXISTING_DIR');
const dir = path.resolve(directory);
if (mode === '--write') fs.mkdirSync(dir); // Exclusive: never overwrite evidence.
else assert(fs.statSync(dir).isDirectory());
const root = path.resolve(__dirname, '../..');
const sdkRoot = process.env.POSTHOG_RS_SOURCE || '/root/.local/state/rust-full-migration-20261028-lu443ytp/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/posthog-rs-0.27.0';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pinned = {
  'src/utils/posthog_events.ts': '19a330a48e8f013f753b1a38d5e03b7d36fb2838e7de69426cd229c78c81086d',
  'package-lock.json': 'abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7',
  'Cargo.lock': '787333fa269752a606040d7393767040ef749ce1e01c2512386bf305bcd7a2c3',
  'node_modules/posthog-node/dist/client.js': 'd4e0d4c6e7e1595bd323dac2d92807354df99e486584903b0134bd320e97b42b',
  'node_modules/posthog-node/dist/entrypoints/index.node.js': '1565d78edad825a52a9efb84742033c5141d2d42065a2577e0e200c1f9ff1792',
  'node_modules/posthog-node/package.json': 'd0d1da472434119faf932ce53d2a4e374d5044c5f75e8e6c63e5c657194e63a1',
  'node_modules/@posthog/core/package.json': '7102a87a3c23e38c628e1f761262c50a5a7c4dd2b4fb912678e977938dbeca86',
  'node_modules/@posthog/core/dist/posthog-core-stateless.js': 'bfe3cf1ad982bb2a6a98f4f603e2e6dff5e740ee1b7428b59c56d055845354b7',
  'node_modules/typescript/package.json': '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
};
const hashes = {};
for (const [file, expected] of Object.entries(pinned)) {
  hashes[file] = sha(fs.readFileSync(path.join(root, file)));
  assert.equal(hashes[file], expected, `installed source changed: ${file}`);
}
// Pin all actually shipped JS files in both SDK packages, not only snippets.
function tree(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) tree(file);
    else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) hashes[file] = sha(fs.readFileSync(path.join(root, file)));
  }
}
tree('node_modules/posthog-node/dist'); tree('node_modules/@posthog/core/dist');
for (const file of ['src/utils/js_string.rs', 'src/utils/lossless_json.rs', 'src/utils/json_number.rs',
  'src/utils/credit_policy.rs', 'src/utils/posthog_lossless.rs', 'tests/posthog_lossless.rs',
  'tests/fixtures/posthog_lossless_reference.cjs']) hashes[file] = sha(fs.readFileSync(path.join(root, file)));
hashes['posthog-rs-0.27.0/src/event.rs'] = sha(fs.readFileSync(path.join(sdkRoot, 'src/event.rs')));
assert.equal(hashes['posthog-rs-0.27.0/src/event.rs'], '5a4112ea152b483a2dc25195bd56901ece4e6da363dd0904babe48776ceae312');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/posthog-node/package.json'))).version, '5.47.3');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@posthog/core/package.json'))).version, '1.46.1');
const source = ts.createSourceFile('posthog_events.ts', fs.readFileSync(path.join(root, 'src/utils/posthog_events.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
let constructor;
function visit(node) {
  if (ts.isNewExpression(node) && node.expression.getText(source) === 'PostHog') {
    assert(!constructor, 'exactly one app client'); constructor = node;
  }
  ts.forEachChild(node, visit);
}
visit(source); assert(constructor && constructor.arguments.length === 2);
const optionsNode = constructor.arguments[1]; assert(ts.isObjectLiteralExpression(optionsNode));
const appOptions = {};
for (const prop of optionsNode.properties) {
  assert(ts.isPropertyAssignment(prop)); const name = prop.name.getText(source);
  if (ts.isNumericLiteral(prop.initializer)) appOptions[name] = Number(prop.initializer.text);
  else if (ts.isStringLiteral(prop.initializer)) appOptions[name] = prop.initializer.text;
  else assert.fail(`unsupported app option ${name}`);
}
assert.deepEqual(appOptions, {host: 'https://us.i.posthog.com', flushInterval: 1000, flushAt: 20});
// Defence against accidental fallthrough. Only our injected fetch can respond.
globalThis.fetch = () => { throw Error('unexpected global fetch; oracle forbids network'); };
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = module.get = () => { throw Error('oracle forbids sockets'); };
}
const {PostHog} = require('posthog-node');
const KEY = 'phc_lossless_installed_sdk_fixture_only';
const HOST = 'http://posthog-lossless.invalid';
const URL = `${HOST}/batch/`;
const clients = [];
const cases = [];
const lifecycle = [];
const timeout = async (promise, label, ms = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} deadline`)), ms); })]); }
  finally { clearTimeout(timer); }
};
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function session(overrides = {}, replies = []) {
  const requests = [], errors = [], notifications = [];
  let cursor = 0;
  const client = new PostHog(KEY, {flushAt: appOptions.flushAt, flushInterval: appOptions.flushInterval,
    ...overrides, host: HOST, fetch: async (url, options) => {
      assert.equal(String(url), URL, 'unexpected SDK URL'); assert.equal(options.method, 'POST');
      const headers = new Headers(options.headers); assert.equal(headers.get('content-type'), 'application/json');
      let bytes;
      if (typeof options.body === 'string') bytes = Buffer.from(options.body);
      else if (options.body instanceof Blob) bytes = Buffer.from(await options.body.arrayBuffer());
      else bytes = Buffer.from(options.body);
      // This oracle contains no performance measurement. Gzip decode is solely
      // a fixture reader, outside any transport/timing measurement boundary.
      if (headers.get('content-encoding') === 'gzip') bytes = zlib.gunzipSync(bytes);
      else assert.equal(headers.get('content-encoding'), null);
      const payload = JSON.parse(bytes.toString('utf8'));
      assert.equal(payload.api_key, KEY); assert(Array.isArray(payload.batch) && payload.batch.length > 0);
      assert.equal(new Date(payload.sent_at).toISOString(), payload.sent_at);
      const request = {raw: bytes.toString('utf8'), payload, encoding: headers.get('content-encoding')};
      requests.push(request);
      for (const listener of notifications.splice(0)) listener();
      const reply = replies[cursor++] ?? 200;
      if (reply === 'network') throw new TypeError('fixture network disconnect');
      if (reply && typeof reply === 'object' && reply.gate) await reply.gate.promise;
      if (reply === 'abort') {
        await new Promise((_, reject) => {
          const abort = () => reject(new DOMException('fixture aborted', 'AbortError'));
          if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once:true});
        });
      }
      return new Response('{}', {status: typeof reply === 'number' ? reply : 200});
    }});
  client.on('error', error => errors.push(error.name));
  clients.push(client);
  async function seen(n) {
    while (requests.length < n) { const d = deferred(); notifications.push(d.resolve); await timeout(d.promise, 'fetch notification'); }
    return requests[n - 1];
  }
  return {client, requests, errors, seen};
}
async function prepared(s) {
  await timeout(s.client.waitForPendingPromises(s.client.promiseQueue.maxId), 'capture preparation');
}
function snapshot(s) {
  const ids = new Map();
  return s.requests.map(({payload, encoding}) => ({encoding,
    api_key: payload.api_key, sent_at: '<sdk-send-time>', batch: payload.batch.map(event => {
      assert.match(event.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
      assert(!Object.hasOwn(event, 'type') && !Object.hasOwn(event, 'library') && !Object.hasOwn(event, 'library_version'));
      assert.equal(event.properties.$lib, 'posthog-node'); assert.equal(event.properties.$lib_version, '5.47.3');
      if (!ids.has(event.uuid)) ids.set(event.uuid, `<sdk-uuid-${ids.size}>`);
      return {...event, timestamp: '<sdk-capture-time>', uuid: ids.get(event.uuid)};
    })}));
}
async function finish(s) { await timeout(s.client.shutdown(), 'SDK shutdown'); clients.splice(clients.indexOf(s.client), 1); }
async function run() {
  const defaults = session();
  assert.equal(defaults.requests.length, 0);
  const actualDefaults = {flushAt: defaults.client.flushAt, flushInterval: defaults.client.flushInterval,
    maxBatchSize: defaults.client.maxBatchSize, maxQueueSize: defaults.client.maxQueueSize,
    requestTimeout: defaults.client.requestTimeout, retries: defaults.client._retryOptions.retryCount,
    retryDelay: defaults.client._retryOptions.retryDelay, disableGeoip: defaults.client.disableGeoip};
  assert.deepEqual(actualDefaults, {flushAt:20, flushInterval:1000, maxBatchSize:100, maxQueueSize:10000,
    requestTimeout:10000, retries:3, retryDelay:3000, disableGeoip:true});
  await defaults.client.flush(); assert.equal(defaults.requests.length, 0); await finish(defaults);
  lifecycle.push({name:'defaults-and-empty', actualDefaults, requests:0});

  const nested = {'\udc00': ['\ud800', '😀', NaN, Infinity, -Infinity, -0, 1e21],
    object: {'10':'ten', '2':'two', lone:'\udfff'}, $is_server:false, $geoip_disable:false,
    $lib:'caller-library', $lib_version:'caller-version'};
  const input = [
    {event:'$identify', distinct_id:'\ud800id\udc00', properties:{$set:{channel_name:'\ud800😀'}, $set_once:{}}},
    {event:'fixture', distinct_id:'id😀\ud800', properties:nested},
  ];
  const lossless = session({flushInterval:0});
  lossless.client.identify({distinctId: input[0].distinct_id, properties:{channel_name:'\ud800😀'}});
  lossless.client.capture({distinctId: input[1].distinct_id, event:input[1].event, properties:nested});
  await prepared(lossless); await lossless.client.flush();
  assert.equal(lossless.requests.length, 1);
  const batch = snapshot(lossless)[0].batch;
  assert.equal(batch[0].properties.$set.channel_name, '\ud800😀');
  assert.equal(batch[0].properties.$set_once && Object.keys(batch[0].properties.$set_once).length, 0);
  for (const event of batch) { assert.equal(event.properties.$is_server, true); assert.equal(event.properties.$geoip_disable, true); }
  assert.deepEqual(batch[1].properties['\udc00'], ['\ud800','😀',null,null,null,0,1e21]);
  assert(lossless.requests[0].raw.includes('\\ud800'));
  cases.push({name:'identify-capture-normalization-and-utf16', input, batch}); await finish(lossless);

  const threshold = session();
  for (let n=0; n<20; n++) threshold.client.capture({event:'threshold', distinctId:'id', properties:{n}});
  await threshold.seen(1); await threshold.client.flush();
  assert.deepEqual(threshold.requests.map(r => r.payload.batch.length), [20]);
  lifecycle.push({name:'app-threshold', batchSizes:[20]}); await finish(threshold);
  const future = session();
  future.client.capture({event:'future', distinctId:'id'}); await prepared(future);
  assert.equal(future.requests.length, 0); await future.seen(1); await future.client.flush();
  lifecycle.push({name:'app-future-timer', batchSizes:future.requests.map(r=>r.payload.batch.length)}); await finish(future);

  const backlog = session({flushInterval:0});
  for (let n=0;n<251;n++) backlog.client.capture({event:'backlog',distinctId:'id',properties:{n}});
  await prepared(backlog); await backlog.client.flush();
  assert.deepEqual(backlog.requests.map(r=>r.payload.batch.length), [100,100,51]);
  assert.deepEqual(backlog.requests.flatMap(r=>r.payload.batch.map(e=>e.properties.n)), Array.from({length:251},(_,n)=>n));
  lifecycle.push({name:'ready-backlog', batchSizes:[100,100,51]}); await finish(backlog);

  for (const capacity of [10000,3]) {
    const overflow = session({flushInterval:0, flushAt:1, maxQueueSize:capacity});
    // Controlled SDK scheduler boundary only. Queueing, normalization, eviction
    // and flush are real SDK code. Prevent automatic drain while filling it.
    const background = overflow.client.flushBackground;
    overflow.client.flushBackground = () => {};
    for(let n=0;n<capacity+2;n++) overflow.client.capture({event:'overflow', distinctId:'id', properties:{n}});
    await prepared(overflow);
    assert.equal(overflow.client.getRouteQueue('default').length, capacity);
    overflow.client.flushBackground = background;
    await overflow.client.flush();
    const numbers = overflow.requests.flatMap(r=>r.payload.batch.map(e=>e.properties.n));
    assert.deepEqual(numbers, Array.from({length:capacity},(_,n)=>n+2));
    lifecycle.push({name:'drop-oldest', capacity, first:numbers[0], last:numbers.at(-1), count:numbers.length,
      boundary:'automatic flush held until queue filled'}); await finish(overflow);
  }
  for (const code of [408,429,500]) {
    const retry = session({flushInterval:0, fetchRetryDelay:1}, [code,200]);
    retry.client.capture({event:'retry',distinctId:'id'}); await prepared(retry); await retry.client.flush();
    assert.equal(retry.requests.length,2); assert.equal(retry.requests[0].raw, retry.requests[1].raw);
    lifecycle.push({name:'retryable-http', code, attempts:2, stableBody:true, fixtureRetryDelay:1}); await finish(retry);
  }
  for (const code of [400,413,503]) {
    const terminal = session({flushInterval:0, fetchRetryDelay:1}, [code,code,code,code]);
    terminal.client.capture({event:'terminal',distinctId:'id'}); await prepared(terminal);
    await assert.rejects(terminal.client.flush());
    assert.equal(terminal.client.getRouteQueue('default').length,0);
    assert.equal(terminal.requests.length, code===503?4:1);
    lifecycle.push({name:'terminal-http-dequeue', code, attempts:terminal.requests.length, remaining:0, fixtureRetryDelay:1}); await finish(terminal);
  }
  const split = session({flushInterval:0}, [413,200,200,200]);
  for(let n=0;n<5;n++) split.client.capture({event:'split',distinctId:'id',properties:{n}});
  await prepared(split); await split.client.flush();
  assert.deepEqual(split.requests.map(r=>r.payload.batch.length),[5,2,2,1]);
  const originalEvents = split.requests[0].payload.batch;
  assert.deepEqual(split.requests.slice(1).flatMap(r=>r.payload.batch), originalEvents);
  lifecycle.push({name:'413-split', batchSizes:[5,2,2,1], stableEvents:true}); await finish(split);
  const network = session({flushInterval:0, fetchRetryDelay:1}, ['network','network','network','network',200]);
  network.client.capture({event:'network',distinctId:'id'}); await prepared(network);
  await assert.rejects(network.client.flush()); assert.equal(network.requests.length,4);
  assert.equal(network.client.getRouteQueue('default').length,1);
  for(const r of network.requests) assert.equal(r.raw, network.requests[0].raw);
  await network.client.flush(); assert.equal(network.client.getRouteQueue('default').length,0);
  assert.deepEqual(network.requests[4].payload.batch,network.requests[0].payload.batch);
  lifecycle.push({name:'exhausted-network-retention', attemptsBefore:4, retained:1, attemptsAfter:5,
    stableRetryBody:true, stableReflushEvent:true, fixtureRetryDelay:1}); await finish(network);

  const request = session({flushInterval:0, fetchRetryCount:0, requestTimeout:10}, ['abort',200]);
  request.client.capture({event:'request-timeout',distinctId:'id'}); await prepared(request);
  await assert.rejects(request.client.flush()); assert.equal(request.client.getRouteQueue('default').length,1);
  await request.client.flush(); lifecycle.push({name:'request-abort-retains', attempts:2, fixtureTimeout:10}); await finish(request);

  const gate = deferred(); const closing = session({flushInterval:0}, [{gate}]);
  closing.client.capture({event:'shutdown',distinctId:'id'}); await prepared(closing);
  const a = closing.client.shutdown(1000); await closing.seen(1); const b = closing.client.shutdown(1000);
  gate.resolve(); await timeout(Promise.all([a,b]), 'concurrent shutdown');
  await closing.client.shutdown(1000); assert.equal(closing.requests.length,1);
  lifecycle.push({name:'shared-repeated-shutdown', requests:1});
  closing.client.capture({event:'after-shutdown',distinctId:'id'}); await prepared(closing); await closing.client.flush();
  assert.equal(closing.requests.length,2);
  lifecycle.push({name:'SDK-capture-after-shutdown', requests:2,
    difference:'SDK permits later capture; native shutdown permanently closes admission'}); await finish(closing);

  const held = deferred(); const timed = session({flushInterval:0}, [{gate:held}]);
  timed.client.capture({event:'shutdown-timeout',distinctId:'id'}); await prepared(timed);
  const stopping = timed.client.shutdown(10); await timed.seen(1);
  await assert.rejects(stopping); held.resolve(); await timed.client.flush();
  lifecycle.push({name:'SDK-shutdown-timeout', fixtureTimeout:10,
    difference:'SDK timeout returns before held fetch settles; native cancels owned HTTP at its deadline'}); await finish(timed);

  const output = {provenance:{node:process.version,v8:process.versions.v8,typescript:ts.version,
    posthogNode:'5.47.3',posthogCore:'1.46.1',hashes}, cases, lifecycle};
  assert(cases.length && cases.every(c=>c.input.length && c.batch.length)); assert(lifecycle.length >= 15);
  const text = JSON.stringify(output,null,2)+'\n';
  const file = path.join(dir,'reference.json');
  if (mode === '--write') fs.writeFileSync(file,text,{flag:'wx'});
  else {
    assert.deepEqual(fs.readdirSync(dir).sort(), ['reference.json'], 'exact fixture directory required');
    assert(fs.statSync(file).size > 0, 'empty oracle'); assert.equal(fs.readFileSync(file,'utf8'),text,'oracle replay differs');
  }
  process.stdout.write(`PostHog installed-SDK oracle ${mode}: ${cases.length} payload cases, ${lifecycle.length} lifecycle records\n`);
}
const watchdog = setTimeout(()=>{ process.stderr.write('oracle global deadline\n'); process.exit(1); },90000);
run().catch(error=>{ process.stderr.write(String(error.stack || error)+'\n'); process.exitCode=1; })
  .finally(async()=>{
    for(const client of clients) { client.clearFlushTimer(); try { await timeout(client.shutdown(100), 'cleanup',500); } catch {} }
    clearTimeout(watchdog);
  });
