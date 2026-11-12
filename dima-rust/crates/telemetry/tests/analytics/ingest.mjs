// Feeds inbox payloads to the analytics service's own ingestion code (dima-analytics/src/store.mjs,
// unchanged) and prints what it stored and what the admin page would read from it.
//
//   node ingest.mjs <path to store.mjs> [--now-from-payloads] <payload.json>...
//
// `pg` is replaced by a stub (the service's dependencies are not installed here), and the pool
// handed to `ingest` records each statement. For every `jsonb_to_recordset($1::jsonb) AS x(...)`
// insert, each JSON row is checked against the declared column types and the target table's NOT
// NULL columns, which is what PostgreSQL would enforce on that recordset. `--now-from-payloads`
// pins Date.now() just after the newest payload, for committed fixtures with fixed timestamps.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'pg') return { url: 'data:text/javascript,export default { Pool: class Pool {} };', shortCircuit: true };
    return next(specifier, context);
  },
});

const args = process.argv.slice(2);
const storePath = args.shift();
const pinNow = args[0] === '--now-from-payloads' && args.shift();
const payloads = args.map(file => ({ file, raw: readFileSync(file, 'utf8') }));
if (pinNow) {
  const newest = Math.max(...payloads.map(p => JSON.parse(p.raw).at));
  Date.now = () => newest + 1000;
}
const store = await import(pathToFileURL(storePath).href);

const NULLABLE = { analytics_spans: new Set(['parentId']), analytics_logs: new Set(['traceId']) };
const failures = [];
function check(table, value, name, type) {
  const fail = why => failures.push(`${table}.${name}: ${why} (${JSON.stringify(value)})`);
  if (value === null || value === undefined) { if (!NULLABLE[table]?.has(name)) fail('missing for a NOT NULL column'); return; }
  if (type === 'double precision') { if (typeof value !== 'number' || !Number.isFinite(value)) fail('not a finite number'); }
  else if (type === 'bigint') { if (!Number.isSafeInteger(value)) fail('not an integer'); }
  else if (type === 'bigint[]') { if (!Array.isArray(value) || !value.every(Number.isSafeInteger)) fail('not an integer array'); }
  else if (type === 'text') { if (typeof value !== 'string') fail('not text'); }
  else if (type === 'boolean') { if (typeof value !== 'boolean') fail('not a boolean'); }
  else if (type === 'jsonb') { if (typeof value !== 'object') fail('not a JSON object'); }
  else fail(`unknown type ${type}`);
}

const stored = { analytics_metrics: [], analytics_spans: [], analytics_logs: [] };
const receipts = new Set();
const pool = {
  async connect() {
    return {
      release() {},
      async query(sql, params = []) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO analytics_batches')) {
          if (receipts.has(params[0])) return { rows: [], rowCount: 0 };
          receipts.add(params[0]);
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        const recordset = /jsonb_to_recordset\(\$1::jsonb\)\s+AS\s+\w+\(([^)]*)\)/.exec(sql);
        const table = /INSERT INTO (analytics_\w+)/.exec(sql)?.[1];
        if (!recordset || !table || !stored[table]) { failures.push(`unexpected statement: ${sql.slice(0, 80)}`); return { rows: [], rowCount: 0 }; }
        const columns = recordset[1].split(',').map(part => part.trim()).map(part => {
          const [name, ...type] = part.split(/\s+/);
          return { name: name.replaceAll('"', ''), type: type.join(' ') };
        });
        for (const row of JSON.parse(params[0])) {
          for (const { name, type } of columns) check(table, row[name], name, type);
          stored[table].push({ ...row, service: params[1] });
        }
        return { rows: [], rowCount: 1 };
      },
    };
  },
};

let accepted = 0, replayed = 0;
for (const { file, raw } of payloads) {
  const batch = JSON.parse(raw);
  try {
    if (await store.ingest(pool, batch)) accepted++;
    if (!(await store.ingest(pool, batch))) replayed++;
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
  }
}

// The admin page's reading of `/api/overview` groups (one per service, kind, name, channel).
const series = new Map();
for (const row of stored.analytics_metrics) {
  const key = JSON.stringify([row.service, row.kind, row.name, row.channel]);
  if (!series.has(key)) series.set(key, []);
  series.get(key).push(row);
}
const groups = [...series.values()].map(rows => {
  const last = rows.reduce((a, b) => (b.at > a.at ? b : a));
  const { service, kind, name, channel } = rows[0];
  return { service, kind, name, channel, ...store.summarize(rows), lastValue: last.sum / last.count };
});
// observability-page.component.ts: processes() and queues().
const RUNTIME_METRIC = /^(.*)\.(cpu_cores|event_loop_p99_ms|heap_bytes|rss_bytes|telemetry_dropped)$/;
const processes = {};
for (const group of groups) {
  if (group.kind !== 'runtime') continue;
  const match = RUNTIME_METRIC.exec(group.name);
  if (!match) continue;
  const key = `${group.service}|${match[1]}`;
  processes[key] ??= {};
  processes[key][match[2]] = group.lastValue;
}
const queues = {};
for (const group of groups) {
  if (!group.kind.startsWith('queue')) continue;
  const key = group.name.split('.')[0];
  queues[key] ??= { jobs: 0, failures: 0 };
  if (group.kind === 'queue_run') { queues[key].jobs += group.count; queues[key].failures += group.errors; }
}
console.log(JSON.stringify({
  accepted, replayed, failures,
  rows: { metrics: stored.analytics_metrics.length, spans: stored.analytics_spans.length, logs: stored.analytics_logs.length },
  groups, processes, queues, spans: stored.analytics_spans, logs: stored.analytics_logs,
}));
