/** Host + container stats (from the dima-hoststats sidecar via analytics): types, grouping, issues and formatting. */

export interface HostStats {
  cpus: number | null;
  uptimeSec: number | null;
  cpuPct: number | null;
  iowaitPct: number | null;
  stealPct: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  running: number | null;
  procs: number | null;
  memTotal: number | null;
  memAvailable: number | null;
  memUsed: number | null;
  memFree: number | null;
  memCache: number | null;
  memShared: number | null;
  swapTotal: number | null;
  swapUsed: number | null;
  diskTotal: number | null;
  diskFree: number | null;
  diskUsed: number | null;
  inodesTotal: number | null;
  inodesUsed: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  netRx: number | null;
  netTx: number | null;
  pressure: { cpu: number | null; memory: number | null; io: number | null };
}
export interface ContainerStats {
  name: string;
  project: string | null;
  service: string | null;
  image: string | null;
  state: string;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  startedAt: string | null;
  finishedAt: string | null;
  oomKilled: boolean;
  restartPolicy: string | null;
  failingStreak: number | null;
  exitCode: number | null;
  restartCount: number | null;
  cpuPct: number | null;
  cpuLimit: number | null;
  memBytes: number | null;
  memLimit: number | null;
  pids: number | null;
  pidsLimit: number | null;
  netRx: number | null;
  netTx: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  blkRead: number | null;
  blkWrite: number | null;
  blkReadBps: number | null;
  blkWriteBps: number | null;
  imageBytes: number | null;
  writableBytes: number | null;
  volumeBytes: number | null;
}
export interface DockerDf {
  at: string | null;
  imagesCount: number | null;
  imagesBytes: number | null;
  imagesUnusedBytes: number | null;
  buildCacheBytes: number | null;
  buildCacheReclaimable: number | null;
  volumesCount: number | null;
  volumesBytes: number | null;
  containersBytes: number | null;
}
export interface InfraSnapshot {
  at: string;
  sampleMs: number | null;
  host: HostStats;
  docker: { reachable: boolean; version: string | null; df: DockerDf | null };
  containers: ContainerStats[];
  errors: string[];
}
/** [epoch ms, slot average, slot max] */
export type Point = [number, number, number];
export interface InfraSeries {
  service: string;
  name: string;
  detail: boolean;
  points: Point[];
}
export interface InfraBlock {
  receivedAt: string | null;
  snapshot: InfraSnapshot | null;
  series: InfraSeries[];
  slotSeconds?: { host: number; list: number; detail: number };
  container: string | null;
}

export type GroupId = 'core' | 'db' | 'ai' | 'web' | 'tools';
/** Fixed order = fixed colour slot (validated categorical palette, see the component CSS). */
export const GROUPS: Array<{ id: GroupId; label: string; hint: string }> = [
  { id: 'core', label: 'Bot & API', hint: 'What streamers and viewers use' },
  { id: 'db', label: 'Databases', hint: 'Where everything is stored' },
  { id: 'ai', label: 'AI helpers', hint: 'Voices and chat memory' },
  { id: 'web', label: 'Websites & extension', hint: 'Sites, Twitch extension and the HTTPS proxy' },
  { id: 'tools', label: 'Internal tools', hint: 'Consoles and these numbers' },
];
const KNOWN: Record<string, { label: string; role: string; group: GroupId }> = {
  'dima-server': { label: 'API server', role: 'Site, dashboard and overlay API', group: 'core' },
  'dima-bot': { label: 'Chat bot', role: 'Twitch chat and events', group: 'core' },
  'dima-cron': { label: 'Workers', role: 'Background jobs and schedules', group: 'core' },
  mongodb: { label: 'MongoDB', role: 'Main database', group: 'db' },
  dragonfly: { label: 'Dragonfly', role: 'Cache, sessions & job queues', group: 'db' },
  postgres: { label: 'PostgreSQL', role: 'Analytics storage', group: 'db' },
  qdrant: { label: 'Qdrant', role: 'Vector search for chat memory', group: 'db' },
  'piper-tts': { label: 'Piper voices', role: 'Text to speech', group: 'ai' },
  'lfm2.5-embeddings': { label: 'Embeddings', role: 'Turns chat into searchable memory', group: 'ai' },
  'dimabot-site': { label: 'Website', role: 'Public site and streamer dashboard', group: 'web' },
  'dima-admin': { label: 'Admin site', role: 'This admin panel', group: 'web' },
  dimadocs: { label: 'Docs site', role: 'Help and documentation', group: 'web' },
  dimafx: { label: 'Extension files', role: 'Twitch extension panel and overlay', group: 'web' },
  'dimafx-server': { label: 'Extension server', role: 'Twitch extension backend', group: 'web' },
  NPM: { label: 'HTTPS proxy', role: 'Routes every domain, renews certificates', group: 'web' },
  dimadb: { label: 'DB console', role: 'Internal database browser', group: 'tools' },
  'dima-analytics': { label: 'Analytics', role: 'Collects these numbers', group: 'tools' },
  'dima-hoststats': { label: 'Host stats', role: 'Reads server and container stats', group: 'tools' },
};
const PROJECT_GROUP: Record<string, GroupId> = { databases: 'db', dimabot: 'core', dimafx: 'web', dimasite: 'web', admin: 'web', dimadocs: 'web', network: 'web' };

export function containerMeta(c: Pick<ContainerStats, 'name' | 'project'>): { label: string; role: string; group: GroupId } {
  return KNOWN[c.name] ?? { label: c.name, role: c.project ? `${c.project} project` : '', group: PROJECT_GROUP[c.project ?? ''] ?? 'tools' };
}

export interface InfraIssue {
  tone: 'live' | 'warn';
  title: string;
  text: string;
  container?: string;
}

const STATE_TEXT: Record<string, string> = { exited: 'stopped', dead: 'died', created: 'was created but never started', paused: 'is paused', restarting: 'keeps restarting', removing: 'is being removed' };
const DISK_WARN = 0.8, DISK_BAD = 0.9, MEM_BAD = 0.9, LIMIT_WARN = 0.9;

/** Restarts inside the range: positive steps of the restart counter (recreating a container resets it). */
export function restartsInRange(points: Point[] | undefined): number {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.max(0, points[i][2] - points[i - 1][2]);
  return Math.round(total);
}

/** Problems worth an operator's attention, most urgent first. Shared by the Servers tab and the overview. */
export function infraIssues(block: InfraBlock | null, rangeLong = ''): InfraIssue[] {
  const snap = block?.snapshot;
  if (!block || !snap) return [];
  const items: InfraIssue[] = [];
  const age = Date.now() - Date.parse(snap.at);
  if (age > 120000) items.push({ tone: 'warn', title: `Server stats are ${formatAge(age)} old`, text: 'The host stats service stopped reporting. Values below are the last reading.' });
  if (!snap.docker.reachable) items.push({ tone: 'warn', title: "Container stats aren't available", text: 'The host stats service cannot read Docker right now.' });
  const h = snap.host;
  if (h.diskTotal && h.diskUsed !== null) {
    const used = h.diskUsed / h.diskTotal;
    if (used >= DISK_WARN) items.push({ tone: used >= DISK_BAD ? 'live' : 'warn', title: `Disk is ${Math.round(used * 100)}% full`, text: `${formatBytes(h.diskFree)} left. Databases stop writing when the disk is full.` });
  }
  if (h.memTotal && h.memUsed !== null && h.memUsed / h.memTotal >= MEM_BAD) {
    items.push({ tone: 'warn', title: `Memory is ${Math.round((h.memUsed / h.memTotal) * 100)}% used`, text: `${formatBytes(h.memAvailable)} available. There is no swap, so a container can be killed when it runs out.` });
  }
  for (const c of snap.containers) {
    const { label } = containerMeta(c);
    if (c.state !== 'running') {
      const why = c.oomKilled ? ' after running out of memory' : c.exitCode ? ` (exit code ${c.exitCode})` : '';
      const state = STATE_TEXT[c.state] ?? c.state;
      items.push({ tone: 'live', title: `${label} is ${c.state === 'restarting' ? 'restarting' : 'not running'}`, text: `Container ${c.name} ${state}${why}.`, container: c.name });
    } else if (c.health === 'unhealthy') {
      items.push({ tone: 'live', title: `${label} is unhealthy`, text: `Its health check failed ${c.failingStreak ?? 'several'} times in a row.`, container: c.name });
    } else if (c.memLimit && c.memBytes !== null && c.memBytes / c.memLimit >= LIMIT_WARN) {
      items.push({ tone: 'warn', title: `${label} is at ${Math.round((c.memBytes / c.memLimit) * 100)}% of its memory limit`, text: `${formatBytes(c.memBytes)} of ${formatBytes(c.memLimit)}. Docker restarts it if it goes over.`, container: c.name });
    }
    const restarts = restartsInRange(block.series.find((s) => !s.detail && s.service === 'container:' + c.name && s.name === 'restart_count')?.points);
    if (restarts > 0 && c.state === 'running') {
      items.push({ tone: 'warn', title: `${label} restarted ${restarts === 1 ? 'once' : restarts + ' times'}${rangeLong ? ' in the last ' + rangeLong : ''}`, text: 'It crashed or was killed and Docker started it again. Check its logs.', container: c.name });
    }
  }
  return items.sort((a, b) => Number(b.tone === 'live') - Number(a.tone === 'live'));
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value.toFixed(0)} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(value < 104857600 ? 1 : 0)} MiB`;
  if (value < 1099511627776) return `${(value / 1073741824).toFixed(value < 10737418240 ? 2 : 1)} GiB`;
  return `${(value / 1099511627776).toFixed(2)} TiB`;
}
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${formatBytes(value)}/s`;
}
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 && value < 0.1 ? '<0.1' : value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}
export function formatAge(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  if (seconds < 1209600) return `${Math.round(seconds / 86400)} days`;
  return `${Math.round(seconds / 604800)} weeks`;
}
