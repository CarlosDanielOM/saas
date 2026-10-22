// Host and container stats from the read-only dima-hoststats sidecar.
// The sidecar holds the Docker socket; this service only fetches its JSON, validates it field by field,
// stores numeric trends in analytics_resources and keeps the latest snapshot in Redis.

export const INFRA_KEY = 'observability:v1:infra:latest';
export const HOST_SERVICE = 'host';
export const CONTAINER_PREFIX = 'container:';

const HOST_NUMBERS = ['cpus', 'uptimeSec', 'cpuPct', 'iowaitPct', 'stealPct', 'load1', 'load5', 'load15', 'running', 'procs',
  'memTotal', 'memAvailable', 'memUsed', 'memFree', 'memCache', 'memShared', 'swapTotal', 'swapUsed',
  'diskTotal', 'diskFree', 'diskUsed', 'inodesTotal', 'inodesUsed', 'diskReadBps', 'diskWriteBps', 'netRxBps', 'netTxBps', 'netRx', 'netTx'];
const DF_NUMBERS = ['imagesCount', 'imagesBytes', 'imagesUnusedBytes', 'buildCacheBytes', 'buildCacheReclaimable', 'volumesCount', 'volumesBytes', 'containersBytes'];
const CONTAINER_NUMBERS = ['failingStreak', 'exitCode', 'restartCount', 'cpuPct', 'cpuLimit', 'memBytes', 'memLimit', 'pids', 'pidsLimit',
  'netRx', 'netTx', 'netRxBps', 'netTxBps', 'blkRead', 'blkWrite', 'blkReadBps', 'blkWriteBps', 'imageBytes', 'writableBytes', 'volumeBytes'];
const STATES = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown']);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,199}$/;

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const match = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
const when = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const pick = (source, keys) => Object.fromEntries(keys.map((k) => [k, finite(source?.[k])]));

/** Rebuild the snapshot from known fields only, so nothing unexpected reaches storage or the browser. */
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !when(raw.at)) throw new Error('Invalid host stats snapshot');
  const df = raw.docker?.df;
  const containers = (Array.isArray(raw.containers) ? raw.containers : []).slice(0, 64).flatMap((c) => {
    const name = match(c?.name, NAME);
    if (!name) return [];
    return [{
      name,
      project: match(c.project, LABEL),
      service: match(c.service, LABEL),
      image: match(c.image, IMAGE),
      state: STATES.has(c.state) ? c.state : 'unknown',
      health: ['healthy', 'unhealthy', 'starting'].includes(c.health) ? c.health : null,
      startedAt: when(c.startedAt),
      finishedAt: when(c.finishedAt),
      oomKilled: c.oomKilled === true,
      restartPolicy: match(c.restartPolicy, LABEL),
      ...pick(c, CONTAINER_NUMBERS),
    }];
  });
  return {
    at: when(raw.at),
    sampleMs: finite(raw.sampleMs),
    host: { ...pick(raw.host, HOST_NUMBERS), pressure: pick(raw.host?.pressure, ['cpu', 'memory', 'io']) },
    docker: {
      reachable: raw.docker?.reachable === true,
      version: match(raw.docker?.version, /^[0-9][0-9a-zA-Z.+-]{0,39}$/),
      df: df && typeof df === 'object' ? { at: when(df.at), ...pick(df, DF_NUMBERS) } : null,
    },
    containers,
    errors: (Array.isArray(raw.errors) ? raw.errors : []).filter((e) => typeof e === 'string').slice(0, 5).map((e) => e.slice(0, 120)),
  };
}

// Stored trend series. Hosts every 30 s; containers every 60 s to keep the table small.
export const HOST_SERIES = {
  cpu_pct: 'cpuPct', iowait_pct: 'iowaitPct', load1: 'load1', mem_used_bytes: 'memUsed', mem_total_bytes: 'memTotal',
  swap_used_bytes: 'swapUsed', disk_used_bytes: 'diskUsed', disk_total_bytes: 'diskTotal',
  disk_read_bps: 'diskReadBps', disk_write_bps: 'diskWriteBps', net_rx_bps: 'netRxBps', net_tx_bps: 'netTxBps',
};
export const CONTAINER_SERIES = {
  cpu_pct: 'cpuPct', mem_bytes: 'memBytes', net_rx_bps: 'netRxBps', net_tx_bps: 'netTxBps',
  blk_read_bps: 'blkReadBps', blk_write_bps: 'blkWriteBps', restart_count: 'restartCount',
};

export function infraResources(snapshot, { containers = true } = {}) {
  const rows = [];
  const add = (service, name, value) => { if (value !== null && value !== undefined && Number.isFinite(value)) rows.push({ service, name, value }); };
  for (const [name, key] of Object.entries(HOST_SERIES)) add(HOST_SERVICE, name, snapshot.host[key]);
  add(HOST_SERVICE, 'containers_running', snapshot.containers.filter((c) => c.state === 'running').length);
  add(HOST_SERVICE, 'containers_total', snapshot.containers.length);
  add(HOST_SERVICE, 'docker_up', snapshot.docker.reachable ? 1 : 0);
  if (containers) {
    for (const c of snapshot.containers) {
      const service = CONTAINER_PREFIX + c.name;
      add(service, 'running', c.state === 'running' ? 1 : 0);
      for (const [name, key] of Object.entries(CONTAINER_SERIES)) add(service, name, c[key]);
    }
  }
  return rows;
}

export async function fetchSnapshot(url, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const response = await fetchImpl(`${url}/v1/snapshot`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!response.ok) throw new Error('Host stats unavailable');
  const body = await response.text();
  if (body.length > 512000) throw new Error('Host stats snapshot too large');
  return sanitizeSnapshot(JSON.parse(body));
}

const LIST_NAMES = ['running', 'cpu_pct', 'mem_bytes', 'restart_count'];
const HOST_LIST = ['cpu_pct', 'mem_used_bytes', 'disk_used_bytes', 'load1', 'net_rx_bps', 'net_tx_bps', 'disk_read_bps', 'disk_write_bps', 'swap_used_bytes', 'iowait_pct'];
const DETAIL_NAMES = Object.keys(CONTAINER_SERIES);
const HOUR = 3600000;
const AVG = '.h_avg', MAX = '.h_max';
const INFRA_SQL = `(service='${HOST_SERVICE}' OR service LIKE '${CONTAINER_PREFIX}%')`;
const cache = new Map();
export const clearInfraCache = () => cache.clear();

/**
 * Hourly rollups (average + max) stored in analytics_resources itself, stamped exactly on the hour.
 * Long ranges then read ~720 timestamps through the (at, service, name) primary key instead of
 * aggregating millions of raw rows. They expire with the same 30-day partitions.
 */
export async function rollupHour(pool, hourMs) {
  await pool.query(`INSERT INTO analytics_resources(at,service,name,value)
    SELECT $1::timestamptz,service,name||x.suffix,x.v FROM (
      SELECT service,name,avg(value) AS a,max(value) AS m FROM analytics_resources
      WHERE at>=$1::timestamptz AND at<$1::timestamptz+interval '1 hour' AND ${INFRA_SQL} AND name NOT LIKE '%.h\\_%'
      GROUP BY 1,2) g CROSS JOIN LATERAL (VALUES ('${AVG}',g.a),('${MAX}',g.m)) AS x(suffix,v)
    ON CONFLICT (at,service,name) DO UPDATE SET value=excluded.value`, [new Date(hourMs).toISOString()]);
}

/** Roll up any completed hour of the last two days that has raw samples but no rollup yet. */
export async function ensureRollups(pool, now = Date.now(), hours = 48) {
  const current = Math.floor(now / HOUR) * HOUR;
  const wanted = Array.from({ length: hours }, (_, i) => current - (i + 1) * HOUR);
  const done = await pool.query(`SELECT DISTINCT at FROM analytics_resources WHERE at=ANY($1::timestamptz[]) AND service='${HOST_SERVICE}' AND name LIKE '%${AVG}'`,
    [wanted.map((ms) => new Date(ms).toISOString())]);
  const have = new Set(done.rows.map((r) => new Date(r.at).getTime()));
  const raw = await pool.query(`SELECT DISTINCT date_trunc('hour',at) AS hour FROM analytics_resources WHERE at>=$1::timestamptz AND at<$2::timestamptz AND service='${HOST_SERVICE}' AND name='docker_up'`,
    [new Date(current - hours * HOUR).toISOString(), new Date(current).toISOString()]);
  let rolled = 0;
  for (const { hour } of raw.rows) {
    const ms = new Date(hour).getTime();
    if (have.has(ms)) continue;
    await rollupHour(pool, ms);
    rolled++;
  }
  return rolled;
}

// Four significant digits is plenty for a trend line and roughly halves the payload.
const round = (v) => (Number.isFinite(v) ? Number(v.toPrecision(4)) : null);

/** Bucket [atMs, avg, max] rows into fixed slots: slot average of averages, slot max of maxima. */
function bucket(rows, slotMs, detail) {
  const series = new Map();
  for (const row of rows) {
    const id = `${row.service}|${row.name}`;
    if (!series.has(id)) series.set(id, { service: row.service, name: row.name, detail, slots: new Map() });
    const slot = Math.floor(row.at / slotMs) * slotMs;
    const point = series.get(id).slots.get(slot) ?? { sum: 0, n: 0, max: -Infinity };
    point.sum += row.avg; point.n++; point.max = Math.max(point.max, row.max);
    series.get(id).slots.set(slot, point);
  }
  return [...series.values()].map(({ slots, ...s }) => ({ ...s, points: [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([at, p]) => [at, round(p.sum / p.n), round(p.max)]) }));
}

/**
 * Downsampled trends: [epochMs, average, max] per slot, so long ranges keep their spikes.
 * The list view gets running/CPU/memory for every container; one container can ask for all of its series.
 * Up to 24 h reads raw samples; longer ranges read hourly rollups plus the raw current hour.
 */
export async function infraSeries(pool, { minutes, container = null, now = Date.now() }) {
  const span = Math.min(minutes, 43200);
  const long = span > 1440;
  const hostSlot = Math.max(long ? HOUR / 1000 : 30, Math.ceil((span * 60) / 120));
  const listSlot = Math.max(long ? HOUR / 1000 : 60, Math.ceil((span * 60) / 60));
  // Containers are stored every 60 s, so their detail never asks for finer slots than that.
  const detailSlot = Math.max(60, hostSlot);
  const key = `${span}|${container || ''}`;
  const hit = cache.get(key);
  // Cache for half a list slot (15 s–5 min): every viewer's 15 s refresh doesn't rescan the range.
  if (hit && hit.until > now) return hit.value;
  const groups = [
    { slot: hostSlot, where: `service='${HOST_SERVICE}'`, names: HOST_LIST, detail: false },
    { slot: listSlot, where: `service LIKE '${CONTAINER_PREFIX}%'`, names: LIST_NAMES, detail: false },
    ...(container ? [{ slot: detailSlot, where: 'service=$3', names: DETAIL_NAMES, detail: true, param: CONTAINER_PREFIX + container }] : []),
  ];
  const since = now - span * 60000;
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const series = (await Promise.all(groups.map(async (g) => {
    const params = g.param ? [g.param] : [];
    const raw = async (from, slot) => (await pool.query(
      `SELECT service,name,(floor(extract(epoch FROM at)/$2::int)*$2::int)::bigint AS slot,avg(value) AS avg,max(value) AS max
       FROM analytics_resources WHERE at>=$1::timestamptz AND ${g.where} AND name=ANY($${params.length + 3}::text[])
       GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 20000`, [new Date(from).toISOString(), slot, ...params, g.names])).rows
      .map((r) => ({ service: r.service, name: r.name, at: Number(r.slot) * 1000, avg: Number(r.avg), max: Number(r.max) }));
    if (!long) return bucket(await raw(since, g.slot), g.slot * 1000, g.detail);
    const hours = [];
    for (let h = Math.ceil(since / HOUR) * HOUR; h < currentHour; h += HOUR) hours.push(new Date(h).toISOString());
    const names = g.names.flatMap((n) => [n + AVG, n + MAX]);
    const [rolled, recent] = await Promise.all([
      pool.query(`SELECT at,service,name,value FROM analytics_resources WHERE at=ANY($1::timestamptz[]) AND ${g.where} AND name=ANY($2::text[])`,
        [hours, names, ...params]),
      raw(currentHour, 60),
    ]);
    const merged = new Map();
    for (const r of rolled.rows) {
      const base = r.name.slice(0, -AVG.length);
      const id = `${r.service}|${base}|${new Date(r.at).getTime()}`;
      const row = merged.get(id) ?? { service: r.service, name: base, at: new Date(r.at).getTime(), avg: null, max: null };
      if (r.name.endsWith(AVG)) row.avg = Number(r.value); else row.max = Number(r.value);
      merged.set(id, row);
    }
    const rows = [...merged.values()].filter((r) => r.avg !== null && r.max !== null);
    return bucket([...rows, ...recent], g.slot * 1000, g.detail);
  }))).flat();
  const value = { slotSeconds: { host: hostSlot, list: listSlot, detail: detailSlot }, series };
  if (cache.size > 200) cache.clear();
  cache.set(key, { value, until: now + Math.min(300000, Math.max(15000, (listSlot * 1000) / 2)) });
  return value;
}
