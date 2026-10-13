import pg from 'pg';
export const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000, 1e12];
const text = (v, max = 100) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v);
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e15;
export function validateBatch(batch, now = Date.now()) {
  if (!batch || batch.version !== 1 || !/^[a-f0-9-]{36}$/.test(batch.id || '') || !text(batch.service, 50) || !text(batch.instance, 100)) throw new Error('Invalid envelope');
  for (const [key, limit] of [['metrics', 100], ['spans', 50], ['logs', 25]]) if (!Array.isArray(batch[key]) || batch[key].length > limit) throw new Error('Invalid batch size');
  const validTime = at => number(at) && at >= now - 3600000 && at <= now + 60000;
  for (const m of batch.metrics) {
    if (!validTime(m.at) || !text(m.kind, 30) || !text(m.name) || !text(m.channel, 80) || !text(m.outcome, 30)
      || !Number.isSafeInteger(m.count) || m.count < 1 || m.count > 1e8 || !number(m.sum) || !number(m.max)
      || !Array.isArray(m.histogram) || m.histogram.length !== BOUNDS.length || !m.histogram.every(x => Number.isSafeInteger(x) && x >= 0)
      || m.histogram.reduce((a, b) => a + b, 0) !== m.count) throw new Error('Invalid metric');
  }
  for (const s of batch.spans) if (!validTime(s.at) || !number(s.duration) || !/^[a-f0-9]{32}$/.test(s.traceId || '')
    || !/^[a-f0-9]{16}$/.test(s.spanId || '') || !(s.parentId === null || /^[a-f0-9]{16}$/.test(s.parentId || ''))
    || !text(s.channel, 80) || !text(s.kind, 30) || !text(s.name) || !text(s.outcome, 30)) throw new Error('Invalid span');
  for (const l of batch.logs) if (!validTime(l.at) || !['warn', 'error', 'fatal'].includes(l.level) || !text(l.name)
    || !text(l.channel, 80) || !(l.traceId === null || /^[a-f0-9]{32}$/.test(l.traceId || ''))
    || !l.fields || typeof l.fields !== 'object' || JSON.stringify(l.fields).length > 2000) throw new Error('Invalid log');
  return batch;
}
export function percentile(histogram, fraction) {
  const total = histogram.reduce((a, b) => a + Number(b), 0);
  if (!total) return null;
  let count = 0;
  for (let i = 0; i < BOUNDS.length; i++) { count += Number(histogram[i]); if (count >= total * fraction) return BOUNDS[i] === 1e12 ? null : BOUNDS[i]; }
  return null;
}
export function summarize(rows) {
  const result = { count: 0, sum: 0, max: 0, errors: 0, histogram: BOUNDS.map(() => 0) };
  for (const row of rows) {
    result.count += Number(row.count); result.sum += Number(row.sum); result.max = Math.max(result.max, Number(row.max));
    if (['error', 'aborted', 'failed'].includes(row.outcome)) result.errors += Number(row.count);
    row.histogram.forEach((v, i) => { result.histogram[i] += Number(v); });
  }
  return { ...result, average: result.count ? result.sum / result.count : null, p50: percentile(result.histogram, .5), p95: percentile(result.histogram, .95), p99: percentile(result.histogram, .99) };
}
export function makePool(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000, statement_timeout: 8000 });
  pool.on('error', () => console.error('Analytics PostgreSQL connection unavailable'));
  return pool;
}

export async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_batches (id uuid PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS analytics_metrics (
      resolution integer NOT NULL, at timestamptz NOT NULL, service text NOT NULL, kind text NOT NULL,
      name text NOT NULL, channel text NOT NULL, outcome text NOT NULL,
      count bigint NOT NULL, sum double precision NOT NULL, max double precision NOT NULL, histogram bigint[] NOT NULL,
      PRIMARY KEY (resolution, at, service, kind, name, channel, outcome)
    ) PARTITION BY RANGE (at);
    CREATE TABLE IF NOT EXISTS analytics_spans (
      at timestamptz NOT NULL, trace_id text NOT NULL, span_id text NOT NULL, parent_id text,
      service text NOT NULL, channel text NOT NULL, kind text NOT NULL, name text NOT NULL,
      outcome text NOT NULL, duration double precision NOT NULL, partial boolean NOT NULL,
      PRIMARY KEY(at, span_id)
    ) PARTITION BY RANGE (at);
    CREATE INDEX IF NOT EXISTS analytics_spans_lookup ON analytics_spans(trace_id, at);
    CREATE INDEX IF NOT EXISTS analytics_spans_scope ON analytics_spans(channel, at);
    CREATE TABLE IF NOT EXISTS analytics_logs (
      at timestamptz NOT NULL, service text NOT NULL, channel text NOT NULL, level text NOT NULL,
      name text NOT NULL, trace_id text, fields jsonb NOT NULL
    ) PARTITION BY RANGE (at);
    CREATE INDEX IF NOT EXISTS analytics_logs_scope ON analytics_logs(channel, at);
    CREATE TABLE IF NOT EXISTS analytics_resources (
      at timestamptz NOT NULL, service text NOT NULL, name text NOT NULL, value double precision NOT NULL,
      PRIMARY KEY(at, service, name)
    ) PARTITION BY RANGE (at);
    CREATE TABLE IF NOT EXISTS analytics_grants (
      user_id text PRIMARY KEY, role text NOT NULL CHECK(role IN ('viewer','investigator')),
      channels text[] NOT NULL DEFAULT '{}', services text[] NOT NULL DEFAULT '{}',
      expires_at timestamptz, granted_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS analytics_audit (
      at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL, subject text NOT NULL
    );
  `);
  await partitions(pool);
}
export async function partitions(pool, now = Date.now()) {
  // Identifiers and dates are generated locally, never supplied through the API.
  for (let offset = -1; offset <= 2; offset++) {
    const date = new Date(now + offset * 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
    const suffix = date.replaceAll('-', '');
    for (const table of ['metrics', 'spans', 'logs', 'resources']) await pool.query(`CREATE TABLE IF NOT EXISTS analytics_${table}_${suffix} PARTITION OF analytics_${table} FOR VALUES FROM ('${date}') TO ('${tomorrow}')`);
  }
}
export async function retain(pool) {
  await partitions(pool);
  await pool.query("DELETE FROM analytics_batches WHERE received_at < now() - interval '2 days'");
  // Coarser aggregates are written at ingestion. Never average percentiles.
  await pool.query("DELETE FROM analytics_metrics WHERE (resolution=10 AND at < now()-interval '2 days') OR (resolution=60 AND at < now()-interval '30 days')");
  const children = await pool.query("SELECT relname FROM pg_class WHERE relname ~ '^analytics_(metrics|spans|logs|resources)_[0-9]{8}$'");
  for (const { relname } of children.rows) {
    const [, table, day] = /^analytics_(metrics|spans|logs|resources)_(\d{8})$/.exec(relname);
    const expiry = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`) + 86400000;
    const days = { metrics: 365, spans: 3, logs: 7, resources: 30 }[table];
    if (expiry < Date.now() - days * 86400000) await pool.query(`DROP TABLE ${relname}`);
  }
  await pool.query("DELETE FROM analytics_audit WHERE at < now()-interval '365 days'");
}

export async function ingest(pool, batch) {
  validateBatch(batch);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const receipt = await db.query('INSERT INTO analytics_batches(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [batch.id]);
    if (!receipt.rowCount) { await db.query('ROLLBACK'); return false; }
    // A JSON recordset avoids a query per observation and keeps ingestion bounded.
    if (batch.metrics.length) await db.query(`
      INSERT INTO analytics_metrics AS existing
      SELECT resolution, to_timestamp(floor(m.at / 1000 / resolution) * resolution), $2, kind, name, channel, outcome,
             sum(count), sum(sum), max(max), ARRAY[${BOUNDS.map((_, i) => `sum(histogram[${i + 1}])`).join(',')}]
      FROM jsonb_to_recordset($1::jsonb) AS m(at double precision, kind text, name text, channel text, outcome text, count bigint, sum double precision, max double precision, histogram bigint[])
      CROSS JOIN (VALUES (10),(60),(3600)) AS r(resolution)
      GROUP BY resolution, floor(m.at / 1000 / resolution), kind, name, channel, outcome
      ON CONFLICT (resolution, at, service, kind, name, channel, outcome) DO UPDATE SET
        count=existing.count+excluded.count, sum=existing.sum+excluded.sum, max=greatest(existing.max,excluded.max),
        histogram=ARRAY[${BOUNDS.map((_, i) => `existing.histogram[${i + 1}]+excluded.histogram[${i + 1}]`).join(',')}]
    `, [JSON.stringify(batch.metrics), batch.service]);
    if (batch.spans.length) await db.query(`INSERT INTO analytics_spans SELECT to_timestamp(at/1000), "traceId", "spanId", "parentId", $2, channel, kind, name, outcome, duration, partial
      FROM jsonb_to_recordset($1::jsonb) AS s(at double precision,"traceId" text,"spanId" text,"parentId" text,channel text,kind text,name text,outcome text,duration double precision,partial boolean)
      ON CONFLICT DO NOTHING`, [JSON.stringify(batch.spans), batch.service]);
    if (batch.logs.length) await db.query(`INSERT INTO analytics_logs SELECT to_timestamp(at/1000),$2,channel,level,name,"traceId",fields
      FROM jsonb_to_recordset($1::jsonb) AS l(at double precision,channel text,level text,name text,"traceId" text,fields jsonb)`, [JSON.stringify(batch.logs), batch.service]);
    await db.query('COMMIT'); return true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export function rangeQuery(query) {
  const minutes = Number(query.minutes || 60);
  if (![15, 60, 360, 1440, 10080, 43200, 525600].includes(minutes)) throw Object.assign(new Error('Unsupported time range'), { status: 400 });
  return { minutes, resolution: minutes <= 1440 ? 10 : minutes <= 43200 ? 60 : 3600 };
}
export function scopeSql(grant, params, filters = {}) {
  const parts = [];
  const add = (sql, value) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
  // Empty arrays mean global only for grants deliberately created by the owner.
  if (grant.channels.length) add('channel = ANY(?::text[])', grant.channels);
  if (grant.services.length) add('service = ANY(?::text[])', grant.services);
  if (filters.channel) add('channel = ?', String(filters.channel).slice(0, 80));
  if (filters.service) add('service = ?', String(filters.service).slice(0, 50));
  if (filters.kind) add('kind = ?', String(filters.kind).slice(0, 30));
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

export async function overview(pool, grant, query) {
  const { minutes, resolution } = rangeQuery(query);
  const params = [resolution, minutes];
  const scope = scopeSql(grant, params, query);
  const result = await pool.query(`SELECT at,service,kind,name,channel,outcome,count,sum,max,histogram FROM analytics_metrics
    WHERE resolution=$1 AND at>=now()-($2::int*interval '1 minute')${scope} ORDER BY at DESC LIMIT 25001`, params);
  const truncated = result.rows.length > 25000;
  const rows = result.rows.slice(0, 25000), grouped = new Map(), times = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.service, row.kind, row.name, row.channel]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
    if (!['http','chat'].includes(row.kind)) continue;
    const bucket = Math.floor(new Date(row.at).getTime() / (minutes > 1440 ? 3600000 : 60000)) * (minutes > 1440 ? 3600000 : 60000);
    const current = times.get(bucket) || { at: bucket, http: 0, chat: 0 };
    current[row.kind] += Number(row.count); times.set(bucket, current);
  }
  const groups = [...grouped.values()].map(items => ({ service: items[0].service, kind: items[0].kind, name: items[0].name, channel: items[0].channel, ...summarize(items), lastAt: items[0].at, lastValue: Number(items[0].sum) / Number(items[0].count) }));
  const http = summarize(rows.filter(r => r.kind === 'http'));
  const chat = summarize(rows.filter(r => r.kind === 'chat'));
  const timeline = [...times.values()].sort((a,b)=>a.at-b.at).map(t=>({...t, httpRps:t.http/(minutes>1440?3600:60), chatRps:t.chat/(minutes>1440?3600:60)}));
  return { minutes, resolution, generatedAt: new Date().toISOString(), lastAt: rows[0]?.at || null, truncated, http, chat,
    timeline, groups: groups.sort((a,b)=>b.count-a.count), measured: 'completed operations; latency percentiles are histogram upper bounds; missing buckets are not zero' };
}
