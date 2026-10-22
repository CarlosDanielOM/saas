import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient } from 'redis';
import { sanitizeSnapshot, infraResources, fetchSnapshot, INFRA_KEY, clearInfraCache, ensureRollups } from '../src/infrastructure.mjs';
import { makePool, migrate, partitions } from '../src/store.mjs';
import { createCollectors } from '../src/collectors.mjs';
import { createApp } from '../src/index.mjs';
import { fixtureSnapshot } from './infra-fixture.mjs';

test('host stats snapshot keeps known fields only', () => {
  const clean = sanitizeSnapshot(fixtureSnapshot());
  assert.deepEqual(clean.containers.map((c) => c.name), ['dima-server', 'mongodb', 'dima-cron', 'weird']);
  const weird = clean.containers[3];
  assert.equal(weird.state, 'unknown'); assert.equal(weird.image, null); assert.equal(weird.cpuPct, null); assert.equal('env' in weird, false);
  assert.equal('volumes' in clean.containers[0], false, 'volume names are not exported');
  assert.equal('hostname' in clean.host, false);
  assert.deepEqual(clean.errors, ['docker: fine']);
  assert.throws(() => sanitizeSnapshot({ version: 2, at: new Date().toISOString() }));
  const rows = infraResources(clean);
  assert(rows.some((r) => r.service === 'host' && r.name === 'cpu_pct' && r.value === 26));
  assert(rows.some((r) => r.service === 'container:mongodb' && r.name === 'mem_bytes'));
  assert(rows.some((r) => r.service === 'container:dima-cron' && r.name === 'running' && r.value === 0));
  assert(!rows.some((r) => r.service === 'container:dima-cron' && r.name === 'cpu_pct'), 'missing values are not stored as zero');
  assert(!infraResources(clean, { containers: false }).some((r) => r.service.startsWith('container:')));
});

test('collector, storage and API with a mock sidecar', { skip: !process.env.ANALYTICS_TEST }, async () => {
  assert.match(process.env.DATABASE_URL, /observability_test/);
  const pool = makePool(process.env.DATABASE_URL), redis = createClient({ url: process.env.REDIS_URL }); redis.on('error', () => {}); await redis.connect(); await migrate(pool);
  let snapshot = fixtureSnapshot(), sidecarUp = true;
  const sidecar = http.createServer((req, res) => { if (!sidecarUp || req.url !== '/v1/snapshot') { res.writeHead(503); return res.end('{}'); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(snapshot)); });
  await new Promise((r) => sidecar.listen(0, '127.0.0.1', r));
  const hoststatsUrl = `http://127.0.0.1:${sidecar.address().port}`;
  const app = createApp({ pool, redis, config: { ownerId: '1' }, health: { ingestedAt: null }, validateToken: async () => null });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = async (path, token = 'owner') => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json() }; };
  try {
    await pool.query("DELETE FROM analytics_resources WHERE service='host' OR service LIKE 'container:%'");
    for (const [token, id] of [['owner', '1'], ['svc', '21'], ['chan', '22']]) await redis.hSet('token:' + token, { id, login: token });
    await pool.query("INSERT INTO analytics_grants(user_id,role,channels,services,granted_by) VALUES('21','viewer','{}','{dragonfly}','1'),('22','viewer','{c1}','{}','1') ON CONFLICT(user_id) DO UPDATE SET channels=excluded.channels,services=excluded.services");
    const collectors = createCollectors({ pool, redis, config: { hoststatsUrl } });
    await collectors.sample();
    const stored = await pool.query("SELECT service,name,value FROM analytics_resources WHERE service='host' OR service LIKE 'container:%'");
    assert(stored.rows.some((r) => r.service === 'host' && r.name === 'collector_up' && r.value === 1));
    assert(stored.rows.some((r) => r.service === 'container:mongodb' && r.name === 'cpu_pct' && r.value === 23));
    const pg = await pool.query("SELECT value FROM analytics_resources WHERE service='postgres' AND name='server_bytes' ORDER BY at DESC LIMIT 1");
    assert(pg.rows[0]?.value > 0, 'all-database size is collected');
    clearInfraCache();
    const plain = await call('/api/resources?minutes=60');
    assert.equal(plain.status, 200); assert.equal(plain.body.infrastructure, undefined);
    assert(!plain.body.samples.some((s) => s.service === 'host' || s.service.startsWith('container:')), 'database tiles never see host/container rows');
    const infra = await call('/api/resources?minutes=60&include=infra&container=mongodb');
    const block = infra.body.infrastructure;
    assert.equal(block.snapshot.containers.length, 4); assert.equal(block.snapshot.host.cpus, 16); assert.equal(block.container, 'mongodb');
    assert(!JSON.stringify(block).includes('secret-volume-name') && !JSON.stringify(block).includes('SECRET'));
    const cpu = block.series.find((s) => s.service === 'host' && s.name === 'cpu_pct');
    assert.equal(cpu.points.length, 1); assert.equal(cpu.points[0][1], 26);
    assert(block.series.some((s) => s.detail && s.service === 'container:mongodb' && s.name === 'net_rx_bps'));
    assert(!block.series.some((s) => s.detail && s.service !== 'container:mongodb'));
    assert(!block.series.some((s) => !s.detail && s.service.startsWith('container:') && s.name === 'net_rx_bps'), 'list view stays light');
    const snap = await call('/api/resources?minutes=15&include=snapshot');
    assert.equal(snap.body.infrastructure.series.length, 0); assert.equal(snap.body.infrastructure.snapshot.docker.version, '29.8.0');
    assert.equal((await call('/api/resources?minutes=60&include=infra&container=../x')).body.infrastructure.container, null);
    assert.equal((await call('/api/resources?include=infra', 'svc')).body.infrastructure, undefined, 'service-scoped grant gets no host/container block');
    assert.equal((await call('/api/resources?include=infra', 'chan')).status, 403);
    // Sidecar down: host collector reports 0, other collectors keep working, the last snapshot stays readable until it expires.
    sidecarUp = false;
    await collectors.sample();
    const down = await pool.query("SELECT value FROM analytics_resources WHERE service='host' AND name='collector_up' ORDER BY at DESC LIMIT 1");
    assert.equal(down.rows[0].value, 0);
    // 30 days of history for 17 containers (60 s) + host (30 s): raw samples for the last 26 h, hourly rollups before that.
    await pool.query("DELETE FROM analytics_resources WHERE service='host' OR service LIKE 'container:%'");
    for (let day = 0; day <= 31; day += 3) await partitions(pool, Date.now() - day * 86400000);
    const CNAMES = "ARRAY['running','cpu_pct','mem_bytes','net_rx_bps','net_tx_bps','blk_read_bps','blk_write_bps','restart_count']";
    const HNAMES = "ARRAY['cpu_pct','iowait_pct','load1','mem_used_bytes','mem_total_bytes','swap_used_bytes','disk_used_bytes','disk_total_bytes','disk_read_bps','disk_write_bps','net_rx_bps','net_tx_bps','containers_running','containers_total','docker_up','collector_up']";
    const seed = await pool.connect();
    try {
      await seed.query('SET statement_timeout = 0');
      // Raw value cycles 0..59 each hour, so every hourly average is 29.5 and max 59.
      await seed.query(`INSERT INTO analytics_resources SELECT date_trunc('minute',now())-s*interval '60 seconds','container:c'||c,n,(extract(minute FROM date_trunc('minute',now())-s*interval '60 seconds'))::float FROM generate_series(0,1559) s CROSS JOIN generate_series(1,17) c CROSS JOIN unnest(${CNAMES}) n ON CONFLICT DO NOTHING`);
      await seed.query(`INSERT INTO analytics_resources SELECT date_trunc('minute',now())-s*interval '30 seconds','host',n,(extract(minute FROM date_trunc('minute',now())-s*interval '30 seconds'))::float FROM generate_series(0,3119) s CROSS JOIN unnest(${HNAMES}) n ON CONFLICT DO NOTHING`);
      const started = Date.now();
      const rolled = await ensureRollups(pool);
      console.log(`rolled up ${rolled} hours in ${Date.now() - started} ms`);
      assert(rolled >= 24 && rolled <= 27, `rolled ${rolled}`);
      assert.equal(await ensureRollups(pool), 0, 'rollups are idempotent');
      const check = await seed.query("SELECT name,value FROM analytics_resources WHERE at=date_trunc('hour',now())-interval '3 hours' AND service='container:c5' AND name IN ('cpu_pct.h_avg','cpu_pct.h_max')");
      assert.deepEqual(Object.fromEntries(check.rows.map((r) => [r.name, r.value])), { 'cpu_pct.h_avg': 29.5, 'cpu_pct.h_max': 59 });
      // Older history as rollups only (hours 27..720).
      await seed.query(`INSERT INTO analytics_resources SELECT date_trunc('hour',now())-h*interval '1 hour','container:c'||c,n||x,CASE WHEN x='.h_max' THEN 90 ELSE 40 END FROM generate_series(27,720) h CROSS JOIN generate_series(1,17) c CROSS JOIN unnest(${CNAMES}) n CROSS JOIN unnest(ARRAY['.h_avg','.h_max']) x ON CONFLICT DO NOTHING`);
      await seed.query(`INSERT INTO analytics_resources SELECT date_trunc('hour',now())-h*interval '1 hour','host',n||x,CASE WHEN x='.h_max' THEN 99 ELSE 40 END FROM generate_series(27,720) h CROSS JOIN unnest(${HNAMES}) n CROSS JOIN unnest(ARRAY['.h_avg','.h_max']) x ON CONFLICT DO NOTHING`);
      await seed.query('ANALYZE analytics_resources');
      await seed.query('RESET statement_timeout');
    } finally { seed.release(); }
    clearInfraCache();
    const plainLong = await call('/api/resources?minutes=43200');
    assert(!plainLong.body.samples.some((s) => s.service === 'host' || s.service.startsWith('container:')), 'rollups stay out of the database tiles');
    for (const minutes of [60, 1440, 10080, 43200]) {
      const started = Date.now();
      const r = await call(`/api/resources?minutes=${minutes}&include=infra&container=c3`);
      const ms = Date.now() - started;
      const series = r.body.infrastructure.series;
      const list = series.find((s) => !s.detail && s.service === 'container:c1' && s.name === 'cpu_pct');
      const host = series.find((s) => s.service === 'host' && s.name === 'cpu_pct');
      const detail = series.find((s) => s.detail && s.name === 'blk_write_bps');
      console.log(`infra ${minutes}m: ${ms} ms, ${JSON.stringify(r.body).length} bytes, list ${list.points.length} host ${host.points.length} detail ${detail.points.length} points`);
      const want = [55, 62, 115, 122];
      assert(list.points.length >= want[0] && list.points.length <= want[1], `${minutes}m list slots ${list.points.length}`);
      assert(host.points.length >= want[2] && host.points.length <= want[3], `${minutes}m host slots ${host.points.length}`);
      assert(Math.max(...host.points.map((p) => p[2])) === (minutes > 1440 ? 99 : 59), 'slot max keeps spikes');
      if (minutes > 1440) assert(Date.now() - host.points.at(-1)[0] < 3 * 3600000, 'long ranges include the most recent hours');
      assert(ms < 3000, `infra ${minutes}m took ${ms} ms`);
    }
  } finally {
    await pool.query("DELETE FROM analytics_resources WHERE service='host' OR service LIKE 'container:%'");
    await pool.query("DELETE FROM analytics_grants WHERE user_id IN ('21','22')");
    await redis.del(INFRA_KEY);
    await new Promise((r) => server.close(r)); sidecar.close(); await redis.quit(); await pool.end();
  }
});

test('fetchSnapshot rejects non-OK and oversized replies', async () => {
  await assert.rejects(fetchSnapshot('http://x', { fetchImpl: async () => ({ ok: false }) }));
  await assert.rejects(fetchSnapshot('http://x', { fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(600000) }) }), /too large/);
});
