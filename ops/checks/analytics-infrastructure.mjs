// dima-analytics host/container stats: sanitising, collection from a mock sidecar, storage, API scoping,
// 30-day series performance, plus the existing analytics suite (no regressions). Disposable PostgreSQL + Dragonfly only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
assert.equal(process.env.ANALYTICS_TEST, '1'); assert.match(process.env.DATABASE_URL, /observability_test/);
const output = execFileSync(process.execPath, ['--test', '--test-isolation=none', 'test/infrastructure.test.mjs', 'test/analytics.test.mjs', 'test/channel-names.test.mjs'], { encoding: 'utf8' });
console.log(output); assert.match(output, /[ℹ#] fail 0\n/); assert.match(output, /[ℹ#] skipped 0\n/);
// The running candidate (its real runtime command) answers the new include modes too.
const redis = createRequire('/app/package.json')('redis').createClient({ url: process.env.REDIS_URL });
await redis.connect();
try {
  await redis.hSet('token:check-owner', { id: '1', login: 'owner' });
  const { fixtureSnapshot } = await import('/app/test/infra-fixture.mjs');
  const { sanitizeSnapshot, INFRA_KEY } = await import('/app/src/infrastructure.mjs');
  await redis.set(INFRA_KEY, JSON.stringify({ receivedAt: new Date().toISOString(), snapshot: sanitizeSnapshot(fixtureSnapshot()) }), { EX: 60 });
  const r = await fetch('http://127.0.0.1:3210/api/resources?minutes=360&include=infra', { headers: { Authorization: 'Bearer check-owner' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.infrastructure.snapshot.containers.length, 4);
  assert.equal(body.infrastructure.snapshot.docker.df.buildCacheReclaimable, 19.6e9);
  console.log('Candidate serves host + container stats to system-wide grants');
} finally { await redis.del('token:check-owner'); await redis.quit(); }
