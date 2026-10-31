'use strict';
// Captures the installed @polar-sh/sdk 0.42.5 events.ingest wire against
// loopback. The Rust batch adapter must reproduce these body bytes.
const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const {Polar} = require('@polar-sh/sdk');
const {eventsIngestToJSON} = require('@polar-sh/sdk/models/components/eventsingest.js');
const sdkPackage = require('@polar-sh/sdk/package.json');
assert.equal(sdkPackage.name, '@polar-sh/sdk');
assert.equal(sdkPackage.version, '0.42.5');
const sdkRoot = path.dirname(require.resolve('@polar-sh/sdk/package.json'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sdkHashes = Object.fromEntries(Object.entries({
  package: 'package.json',
  ingest: 'dist/commonjs/funcs/eventsIngest.js',
  schema: 'dist/commonjs/models/components/eventsingest.js',
}).map(([name, file]) => [name, sha(fs.readFileSync(path.join(sdkRoot, file)))]));
assert.deepEqual(sdkHashes, {
  package: '0742172127e5952a0df7277b244c00280f777fe4d9a7816b27c6482d19f125ab',
  ingest: '375a684df2fcf680394bca04df3721d8649011a13fa7a2bb730e39763a622096',
  schema: '0b1c349193f9f1503f8cae99b701e41b58a8135bfe61f1a80b72760bb0f884f8',
});

const USER_AGENT = 'speakeasy-sdk/typescript 0.42.5 2.801.0 0.1.0 @polar-sh/sdk';

const cases = [
  {
    id: 'tts',
    events: [{
      name: 'ai_usage',
      customerId: 'fixture-customer',
      externalId: 'entry-piper',
      metadata: {
        _cost: {amount: 1, currency: 'usd'},
        cost: 0.5,
        credits: 1,
        currency: 'usd',
        reason: 'tts_piper',
        characters: 100,
        schema_version: 1,
        entry_id: 'entry-piper',
        provider: 'piper',
        channel_id: 'channel',
        quantity: 100,
        unit: 'characters'
      }
    }]
  },
  {
    id: 'llm',
    events: [{
      name: 'ai_usage',
      customerId: 'fixture-customer',
      externalId: 'entry-llm',
      metadata: {
        _cost: {amount: 1.5, currency: 'usd'},
        _llm: {
          vendor: 'openai',
          model: 'gpt-4o',
          prompt: 'hi',
          response: null,
          inputTokens: 10,
          cachedInputTokens: 4,
          outputTokens: 2,
          totalTokens: 12
        },
        cost: 0.5,
        credits: 13,
        currency: 'usd',
        reason: 'contextual_moderation'
      }
    }]
  },
  {
    id: 'external-customer',
    events: [{
      name: 'ai_usage',
      externalCustomerId: 'external-customer',
      externalId: null,
      metadata: {reason: 'note', flagged: true}
    }]
  }
];

const boundaryCases = [
  {id: 'scalar', events: [1]},
  {id: 'null-event', events: [null]},
  {id: 'missing-customer', events: [{name: 'ai_usage'}]},
  {id: 'null-metadata', events: [{name: 'ai_usage', customerId: 'c', metadata: null}]},
  {id: 'null-reason', events: [{name: 'ai_usage', customerId: 'c', metadata: {reason: null}}]},
  {id: 'null-quantity', events: [{name: 'ai_usage', customerId: 'c', metadata: {quantity: null}}]},
  {id: 'empty-nested', events: [{name: 'ai_usage', customerId: 'c', metadata: {nested: {}}}]},
  {id: 'null-timestamp', events: [{name: 'ai_usage', customerId: 'c', timestamp: null}]},
];

function listen() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function capture(events) {
  let recorded = null;
  const server = await listen();
  server.on('request', (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      recorded = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      };
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({inserted: events.length, duplicates: 0}));
    });
  });
  const {port} = server.address();
  const polar = new Polar({accessToken: 'fixture-oat', serverURL: `http://127.0.0.1:${port}`});
  const serialized = eventsIngestToJSON({events});
  const result = await polar.events.ingest({events});
  await new Promise(resolve => server.close(resolve));
  assert.equal(result.inserted, events.length);
  assert.equal(recorded.method, 'POST');
  assert.equal(recorded.path, '/v1/events/ingest');
  assert.equal(recorded.headers.authorization, 'Bearer fixture-oat');
  assert.equal(recorded.headers.accept, 'application/json');
  assert.equal(recorded.headers['user-agent'], USER_AGENT);
  assert.equal(String(recorded.headers['content-type']).split(';')[0], 'application/json');
  assert.equal(serialized, recorded.body);
  return {
    method: recorded.method,
    path: recorded.path,
    authorization: recorded.headers.authorization,
    accept: recorded.headers.accept,
    contentType: recorded.headers['content-type'],
    userAgent: recorded.headers['user-agent'],
    body: recorded.body
  };
}

async function boundary(item) {
  const server = await listen();
  let requests = 0;
  let wire = '';
  server.on('request', (req, res) => {
    requests++;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { wire = Buffer.concat(chunks).toString('utf8'); res.writeHead(200, {'content-type': 'application/json'}); res.end('{"inserted":1,"duplicates":0}'); });
  });
  const polar = new Polar({accessToken: 'fixture-oat', serverURL: `http://127.0.0.1:${server.address().port}`});
  let accepted = true;
  try { await polar.events.ingest({events: item.events}); } catch { accepted = false; }
  await new Promise(resolve => server.close(resolve));
  assert.equal(requests, accepted ? 1 : 0, `${item.id} request count`);
  return {id: item.id, events: item.events, accepted, body: accepted ? wire : null};
}

async function responseBoundary(item) {
  const server = await listen();
  let requests = 0;
  server.on('request', (req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      const contentType = item.contentType === undefined ? 'application/json' : item.contentType;
      res.writeHead(item.status, contentType === null ? {} : {'content-type': contentType});
      res.end(JSON.stringify(item.reply));
    });
  });
  const polar = new Polar({accessToken: 'fixture-oat', serverURL: `http://127.0.0.1:${server.address().port}`});
  let accepted = true;
  let result = null;
  try { result = await polar.events.ingest({events: [{name: 'ai_usage', customerId: 'c'}]}); } catch { accepted = false; }
  await new Promise(resolve => server.close(resolve));
  assert.equal(requests, 1, `${item.id} does not retry`);
  return {id: item.id, status: item.status, contentType: item.contentType === undefined ? 'application/json' : item.contentType, reply: item.reply, accepted,
    result: accepted ? {inserted: result.inserted, duplicates: result.duplicates} : null};
}

(async () => {
  const [mode, dir, ...extra] = process.argv.slice(2);
  assert(['--write', '--check'].includes(mode) && dir && extra.length === 0, 'usage: --write DIR | --check DIR');
  assert(fs.statSync(dir).isDirectory(), 'parent creates the owned output directory');
  const captured = [];
  for (const item of cases) {
    const wire = await capture(item.events);
    captured.push({id: item.id, events: item.events, ...wire});
  }
  const boundaries = [];
  for (const item of boundaryCases) boundaries.push(await boundary(item));
  const replies = [];
  for (const item of [
    {id: 'created-status', status: 201, reply: {inserted: 1, duplicates: 0}},
    {id: 'fractional-count', status: 200, reply: {inserted: 1.5, duplicates: 0}},
    {id: 'string-count', status: 200, reply: {inserted: '1', duplicates: 0}},
    {id: 'default-duplicates', status: 200, reply: {inserted: 1}},
    {id: 'missing-inserted', status: 200, reply: {duplicates: 1}},
    {id: 'null-inserted', status: 200, reply: {inserted: null, duplicates: 1}},
    {id: 'null-duplicates', status: 200, reply: {inserted: 1, duplicates: null}},
    {id: 'duplicate-only', status: 200, reply: {inserted: 0, duplicates: 1}},
    {id: 'wrong-content-type', status: 200, contentType: 'text/plain', reply: {inserted: 1}},
    {id: 'missing-content-type', status: 200, contentType: null, reply: {inserted: 1}},
    {id: 'json-with-parameter', status: 200, contentType: 'application/json; charset=utf-8', reply: {inserted: 1}},
  ]) replies.push(await responseBoundary(item));
  const document = {
    sdk: '@polar-sh/sdk',
    version: '0.42.5',
    sdkHashes,
    userAgent: USER_AGENT,
    cases: captured,
    boundaries,
    replies
  };
  const body = JSON.stringify(document, null, 2) + '\n';
  const output = require('node:path').join(fs.realpathSync(dir), 'polar_events_ingest_reference.json');
  if (mode === '--write') {
    assert(!fs.existsSync(output), 'refuse overwrite');
    fs.writeFileSync(output, body, {flag: 'wx'});
  } else {
    assert.equal(fs.readFileSync(output, 'utf8'), body, 'sdk wire drift');
  }
  process.stdout.write(`${mode} ${captured.length} polar ingest wires, ${boundaries.length} input and ${replies.length} response boundaries\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
