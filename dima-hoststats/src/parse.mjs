// Pure parsers for host /proc files and Docker API payloads. No I/O here so tests can feed fixtures.

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** First "cpu" line of /proc/stat, in jiffies. */
export function parseCpuStat(text) {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return Number.isFinite(total) ? { total, idle, iowait, steal } : null;
}

/** CPU percentages between two /proc/stat readings (whole machine, 0–100). */
export function cpuBetween(prev, next) {
  if (!prev || !next) return null;
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const pct = (v) => Math.max(0, Math.min(100, (v / total) * 100));
  return {
    cpuPct: pct(total - (next.idle - prev.idle) - (next.iowait - prev.iowait)),
    iowaitPct: pct(next.iowait - prev.iowait),
    stealPct: pct(next.steal - prev.steal),
  };
}

/** /proc/meminfo in bytes. */
export function parseMeminfo(text) {
  const kb = {};
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) kb[match[1]] = Number(match[2]) * 1024;
  }
  if (!kb.MemTotal) return null;
  const available = kb.MemAvailable ?? kb.MemFree ?? 0;
  return {
    memTotal: kb.MemTotal,
    memAvailable: available,
    memUsed: Math.max(0, kb.MemTotal - available),
    memFree: kb.MemFree ?? null,
    memCache: (kb.Cached ?? 0) + (kb.Buffers ?? 0) + (kb.SReclaimable ?? 0),
    memShared: kb.Shmem ?? null,
    swapTotal: kb.SwapTotal ?? 0,
    swapUsed: Math.max(0, (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)),
  };
}

export function parseLoadavg(text) {
  const [load1, load5, load15, tasks] = text.trim().split(/\s+/);
  const [running, procs] = String(tasks || '').split('/');
  return { load1: num(load1), load5: num(load5), load15: num(load15), running: num(running), procs: num(procs) };
}

export function parseUptime(text) {
  return num(text.trim().split(/\s+/)[0]);
}

// Whole disks only: partitions, loop, ram and device-mapper devices would double count.
const DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
/** Bytes read/written since boot across whole disks in /proc/diskstats. */
export function parseDiskstats(text) {
  let read = 0, written = 0, found = false;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !DISK.test(f[2])) continue;
    found = true;
    read += Number(f[5]) * 512;
    written += Number(f[9]) * 512;
  }
  return found ? { read, written } : null;
}

// Virtual interfaces mirror container traffic that already crossed the physical NIC.
const VIRTUAL_NIC = /^(lo|docker\d*|br-|veth|virbr|cni|flannel|tunl|vxlan|wg|tailscale)/;
/** Physical NIC totals from the host's /proc/net/dev. */
export function parseNetDev(text) {
  let rx = 0, tx = 0, found = false;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || VIRTUAL_NIC.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    found = true;
    rx += f[0];
    tx += f[8];
  }
  return found ? { rx, tx } : null;
}

/** "some avg10" of a /proc/pressure file: share of time some task waited on the resource. */
export function parsePressure(text) {
  const match = /^some avg10=([\d.]+)/m.exec(text);
  return match ? num(match[1]) : null;
}

/** Rate per second between two counters; counter resets (restart, recreate) give null, not a negative spike. */
export function rate(prev, next, seconds) {
  if (prev === null || prev === undefined || next === null || next === undefined || seconds <= 0 || next < prev) return null;
  return (next - prev) / seconds;
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : null);
const date = (value) => (typeof value === 'string' && value && !value.startsWith('0001-') ? value : null);

/**
 * Keep only containers whose Compose project is allowlisted. Containers outside Compose
 * (test candidates, one-off runs) are never reported.
 */
export function selectContainers(list, projects) {
  return (Array.isArray(list) ? list : [])
    .map((c) => ({ id: c.Id, name: String(c.Names?.[0] || '').replace(/^\//, ''), project: c.Labels?.['com.docker.compose.project'] }))
    .filter((c) => /^[a-f0-9]{64}$/.test(c.id) && NAME.test(c.name) && projects.has(c.project));
}

/** Counters from a one-shot stats payload (cgroup v1 or v2). */
export function statsCounters(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const mem = stats.memory_stats || {};
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  let rx = 0, tx = 0, hasNet = false;
  for (const nic of Object.values(stats.networks || {})) {
    hasNet = true;
    rx += Number(nic.rx_bytes) || 0;
    tx += Number(nic.tx_bytes) || 0;
  }
  let read = 0, written = 0;
  for (const entry of stats.blkio_stats?.io_service_bytes_recursive || []) {
    const op = String(entry.op).toLowerCase();
    if (op === 'read') read += Number(entry.value) || 0;
    if (op === 'write') written += Number(entry.value) || 0;
  }
  return {
    cpuNs: num(stats.cpu_stats?.cpu_usage?.total_usage),
    // Same as `docker stats`: page cache that can be dropped is not counted as used.
    memBytes: mem.usage === undefined ? null : Math.max(0, Number(mem.usage) - Number(cache)),
    pids: num(stats.pids_stats?.current),
    rx: hasNet ? rx : null,
    tx: hasNet ? tx : null,
    read,
    written,
  };
}

/** One container row: inspect facts + counters + rates against the previous sample. */
export function containerView(entry, inspect, counters, prev, now) {
  const state = inspect?.State || {};
  const host = inspect?.HostConfig || {};
  const labels = inspect?.Config?.Labels || {};
  const seconds = prev ? (now - prev.at) / 1000 : 0;
  const cpuLimit = host.NanoCpus > 0 ? host.NanoCpus / 1e9 : host.CpuQuota > 0 && host.CpuPeriod > 0 ? host.CpuQuota / host.CpuPeriod : null;
  const running = state.Status === 'running';
  const cpuPct = running && prev && counters?.cpuNs !== null && prev.cpuNs !== null && counters.cpuNs >= prev.cpuNs && seconds > 0
    ? ((counters.cpuNs - prev.cpuNs) / (seconds * 1e9)) * 100
    : null;
  const health = state.Health?.Status;
  return {
    name: entry.name,
    project: entry.project,
    service: text(labels['com.docker.compose.service'], 80),
    image: text(inspect?.Config?.Image),
    imageId: text(inspect?.Image, 80),
    state: text(state.Status, 20) || 'unknown',
    health: ['healthy', 'unhealthy', 'starting'].includes(health) ? health : null,
    failingStreak: num(state.Health?.FailingStreak),
    startedAt: date(state.StartedAt),
    finishedAt: date(state.FinishedAt),
    exitCode: num(state.ExitCode),
    oomKilled: state.OOMKilled === true,
    restartCount: num(inspect?.RestartCount) ?? 0,
    restartPolicy: text(host.RestartPolicy?.Name, 40),
    cpuPct,
    cpuLimit,
    memBytes: running ? counters?.memBytes ?? null : null,
    memLimit: host.Memory > 0 ? host.Memory : null,
    pids: running ? counters?.pids ?? null : null,
    pidsLimit: host.PidsLimit > 0 ? host.PidsLimit : null,
    netRx: counters?.rx ?? null,
    netTx: counters?.tx ?? null,
    netRxBps: running ? rate(prev?.rx, counters?.rx, seconds) : null,
    netTxBps: running ? rate(prev?.tx, counters?.tx, seconds) : null,
    blkRead: counters?.read ?? null,
    blkWrite: counters?.written ?? null,
    blkReadBps: running ? rate(prev?.read, counters?.read, seconds) : null,
    blkWriteBps: running ? rate(prev?.written, counters?.written, seconds) : null,
    imageBytes: null,
    writableBytes: null,
    volumeBytes: null,
    volumes: Array.isArray(inspect?.Mounts) ? inspect.Mounts.filter((m) => m.Type === 'volume' && typeof m.Name === 'string').map((m) => m.Name.slice(0, 128)) : [],
  };
}

/** Docker's own disk accounting from /system/df. */
export function parseDf(df, now) {
  if (!df || typeof df !== 'object') return null;
  const images = Array.isArray(df.Images) ? df.Images : [];
  const volumes = Array.isArray(df.Volumes) ? df.Volumes : [];
  const cache = Array.isArray(df.BuildCache) ? df.BuildCache : [];
  const containers = Array.isArray(df.Containers) ? df.Containers : [];
  const sum = (list, pick) => list.reduce((total, item) => total + (Number(pick(item)) > 0 ? Number(pick(item)) : 0), 0);
  const inUse = new Set(containers.map((c) => c.ImageID));
  // Shared layers are counted once: LayersSize is the real total on disk.
  const imagesBytes = Number(df.LayersSize) > 0 ? Number(df.LayersSize) : sum(images, (i) => i.Size);
  return {
    at: new Date(now).toISOString(),
    imagesCount: images.length,
    imagesBytes,
    imagesUnusedBytes: sum(images.filter((i) => !inUse.has(i.Id) && !(i.Containers > 0)), (i) => i.Size - (i.SharedSize > 0 ? i.SharedSize : 0)),
    buildCacheBytes: sum(cache, (c) => c.Size),
    buildCacheReclaimable: sum(cache.filter((c) => !c.InUse && !c.Shared), (c) => c.Size),
    volumesCount: volumes.length,
    volumesBytes: sum(volumes, (v) => v.UsageData?.Size),
    containersBytes: sum(containers, (c) => c.SizeRw),
    byImage: Object.fromEntries(images.filter((i) => typeof i.Id === 'string').map((i) => [i.Id, Number(i.Size) || 0])),
    byContainer: Object.fromEntries(containers.filter((c) => typeof c.Id === 'string').map((c) => [c.Id, Number(c.SizeRw) || 0])),
    byVolume: Object.fromEntries(volumes.filter((v) => typeof v.Name === 'string').map((v) => [v.Name, Number(v.UsageData?.Size) > 0 ? Number(v.UsageData.Size) : 0])),
  };
}
