import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';

import { IconComponent } from '../../shared/icon/icon.component';
import { ObservabilityChartComponent, type ChartSeries } from './observability-chart.component';
import {
  GROUPS, containerMeta, formatAge, formatBytes, formatPct, formatRate, infraIssues, restartsInRange,
  type ContainerStats, type GroupId, type InfraBlock, type Point,
} from './observability-infra';

type Sort = 'group' | 'memory' | 'cpu';
interface Gauge {
  id: string;
  label: string;
  value: string;
  of: string;
  pct: number | null;
  foot: string;
  spark: string;
  spark2?: string;
}
export interface ContainerView {
  c: ContainerStats;
  label: string;
  role: string;
  group: GroupId;
  tone: 'ok' | 'warn' | 'live' | 'muted';
  status: string;
  cpuSpark: string;
  memPct: number | null;
  memScale: number;
  uptimePct: number | null;
  restarts: number;
}

/** Host gauges, where memory and disk go, and every SaaS container with drill-down charts. */
@Component({
  selector: 'app-obs-servers',
  imports: [DatePipe, NgTemplateOutlet, IconComponent, ObservabilityChartComponent],
  templateUrl: './observability-servers.component.html',
  styleUrl: './observability-servers.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityServersComponent {
  readonly infra = input<InfraBlock | null>(null);
  readonly minutes = input(60);
  readonly rangeLong = input('hour');
  readonly loading = input(false);
  readonly selected = input<string | null>(null);
  readonly select = output<string | null>();

  readonly Math = Math;
  readonly groups = GROUPS;
  readonly sort = signal<Sort>('group');
  readonly bytes = formatBytes;
  readonly rate = formatRate;
  readonly pct = formatPct;
  readonly fmtPct = (v: number) => formatPct(v);
  readonly fmtBytes = (v: number) => formatBytes(v);
  readonly fmtRate = (v: number) => formatRate(v);

  readonly snap = computed(() => this.infra()?.snapshot ?? null);
  readonly host = computed(() => this.snap()?.host ?? null);
  readonly issues = computed(() => infraIssues(this.infra(), this.rangeLong()));
  readonly to = computed(() => {
    const at = this.snap()?.at;
    return at ? Math.max(Date.parse(at), Date.now() - 60000) : Date.now();
  });
  readonly from = computed(() => this.to() - this.minutes() * 60000);
  readonly running = computed(() => (this.snap()?.containers ?? []).filter((c) => c.state === 'running').length);

  readonly status = computed(() => {
    const snap = this.snap();
    const issues = this.issues();
    if (!snap) return null;
    if (issues.length) {
      const live = issues.some((i) => i.tone === 'live');
      const first = issues[0];
      return { tone: live ? 'live' : 'warn', icon: 'alert', title: issues.length === 1 ? first.title : `${issues.length} things on the server need a look`, text: issues.length === 1 ? first.text : '' };
    }
    const h = snap.host;
    const parts = [`${this.running()} of ${snap.containers.length} containers running`];
    if (h.cpuPct !== null) parts.push(`CPU ${formatPct(h.cpuPct)}`);
    if (h.memTotal && h.memUsed !== null) parts.push(`memory ${formatPct((h.memUsed / h.memTotal) * 100)}`);
    if (h.diskTotal && h.diskUsed !== null) parts.push(`disk ${formatPct((h.diskUsed / h.diskTotal) * 100)}`);
    return { tone: 'ok', icon: 'ok', title: 'The server is healthy', text: parts.join(' · ') };
  });

  private points(service: string, name: string, detail = false): Point[] {
    return this.infra()?.series.find((s) => s.service === service && s.name === name && s.detail === detail)?.points ?? [];
  }
  private spark(points: Point[], max?: number): string {
    if (points.length < 2) return '';
    const first = points[0][0];
    const span = Math.max(1, points[points.length - 1][0] - first);
    const top = max ?? Math.max(...points.map((p) => p[1]));
    const bottom = max === undefined ? Math.min(...points.map((p) => p[1])) : 0;
    const range = top - bottom || 1;
    return points.map((p, i) => `${i ? 'L' : 'M'}${(((p[0] - first) / span) * 120).toFixed(1)},${(30 - ((p[1] - bottom) / range) * 26 - 2).toFixed(1)}`).join(' ');
  }

  readonly gauges = computed<Gauge[]>(() => {
    const h = this.host();
    if (!h) return [];
    const ratio = (used: number | null, total: number | null) => (used !== null && total ? Math.min(100, (used / total) * 100) : null);
    const memPct = ratio(h.memUsed, h.memTotal);
    const diskPct = ratio(h.diskUsed, h.diskTotal);
    const net = [...this.points('host', 'net_rx_bps'), ...this.points('host', 'net_tx_bps')];
    const netMax = net.length ? Math.max(...net.map((p) => p[1])) : undefined;
    return [
      { id: 'cpu', label: 'CPU', value: formatPct(h.cpuPct), of: h.cpus ? `of ${h.cpus} cores` : '', pct: h.cpuPct,
        foot: h.load1 !== null ? `Load ${h.load1.toFixed(2)} · ${h.load5?.toFixed(2)} · ${h.load15?.toFixed(2)}` : '', spark: this.spark(this.points('host', 'cpu_pct'), 100) },
      { id: 'memory', label: 'Memory', value: formatPct(memPct), of: `${formatBytes(h.memUsed)} of ${formatBytes(h.memTotal)}`, pct: memPct,
        foot: `${formatBytes(h.memAvailable)} available${h.swapTotal ? ` · swap ${formatBytes(h.swapUsed)}` : ' · no swap'}`, spark: this.spark(this.points('host', 'mem_used_bytes'), h.memTotal ?? undefined) },
      { id: 'disk', label: 'Disk', value: formatPct(diskPct), of: `${formatBytes(h.diskUsed)} of ${formatBytes(h.diskTotal)}`, pct: diskPct,
        foot: `${formatBytes(h.diskFree)} free · ${formatRate(h.diskWriteBps)} writes`, spark: this.spark(this.points('host', 'disk_used_bytes')) },
      { id: 'network', label: 'Network', value: formatRate((h.netRxBps ?? 0) + (h.netTxBps ?? 0)), of: 'in + out', pct: null,
        foot: `↓ ${formatRate(h.netRxBps)} · ↑ ${formatRate(h.netTxBps)}`, spark: this.spark(this.points('host', 'net_rx_bps'), netMax), spark2: this.spark(this.points('host', 'net_tx_bps'), netMax) },
    ];
  });

  readonly hostFacts = computed(() => {
    const h = this.host();
    const snap = this.snap();
    if (!h || !snap) return [];
    const facts: Array<{ label: string; value: string; warn?: boolean }> = [];
    const add = (label: string, value: string | null, warn = false) => { if (value) facts.push({ label, value, warn }); };
    add('Uptime', h.uptimeSec !== null ? formatAge(h.uptimeSec * 1000) : null);
    add('Load (1 · 5 · 15 min)', h.load1 !== null ? `${h.load1.toFixed(2)} · ${h.load5?.toFixed(2)} · ${h.load15?.toFixed(2)}` : null, !!h.cpus && (h.load5 ?? 0) > h.cpus);
    add('Waiting on disk (iowait)', h.iowaitPct !== null ? formatPct(h.iowaitPct) : null, (h.iowaitPct ?? 0) > 10);
    add('Stolen by the host (steal)', h.stealPct !== null ? formatPct(h.stealPct) : null, (h.stealPct ?? 0) > 5);
    add('Processes', h.procs !== null ? `${h.procs.toLocaleString('en-US')} (${h.running} running)` : null);
    add('Memory used by page cache', formatBytes(h.memCache));
    add('Shared memory', formatBytes(h.memShared));
    add('Swap', h.swapTotal ? `${formatBytes(h.swapUsed)} of ${formatBytes(h.swapTotal)}` : 'None configured');
    add('Disk reads · writes', `${formatRate(h.diskReadBps)} · ${formatRate(h.diskWriteBps)}`);
    add('Files on disk (inodes)', h.inodesTotal ? `${formatPct(((h.inodesUsed ?? 0) / h.inodesTotal) * 100)} used` : null, !!h.inodesTotal && (h.inodesUsed ?? 0) / h.inodesTotal > 0.9);
    add('Network since boot', h.netRx !== null ? `↓ ${formatBytes(h.netRx)} · ↑ ${formatBytes(h.netTx)}` : null);
    const p = h.pressure;
    add('Time stalled (CPU · memory · disk)', p.cpu !== null ? `${formatPct(p.cpu)} · ${formatPct(p.memory)} · ${formatPct(p.io)}` : null, (p.memory ?? 0) > 5 || (p.io ?? 0) > 20);
    add('Docker version', snap.docker.version);
    return facts;
  });

  /** RAM split by container group, plus whatever the system uses outside containers. */
  readonly memory = computed(() => {
    const snap = this.snap();
    const h = snap?.host;
    if (!snap || !h?.memTotal || h.memUsed === null) return null;
    const segments = GROUPS.map((g, i) => {
      const members = snap.containers.filter((c) => containerMeta(c).group === g.id && c.memBytes !== null).sort((a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0));
      const bytes = members.reduce((sum, c) => sum + (c.memBytes ?? 0), 0);
      return { id: g.id, label: g.label, slot: i + 1, bytes, pct: (bytes / h.memTotal!) * 100, top: members.slice(0, 3).map((c) => `${containerMeta(c).label} ${formatBytes(c.memBytes)}`).join(', ') };
    }).filter((s) => s.bytes > 0);
    const inContainers = segments.reduce((sum, s) => sum + s.bytes, 0);
    const system = Math.max(0, h.memUsed - inContainers);
    return {
      segments: [...segments, { id: 'system', label: 'System & other', slot: 0, bytes: system, pct: (system / h.memTotal) * 100, top: 'Kernel, Docker and programs outside containers' }],
      free: h.memAvailable,
      total: h.memTotal,
    };
  });

  /** Disk split into what Docker reports, everything else, and free space. */
  readonly disk = computed(() => {
    const snap = this.snap();
    const h = snap?.host;
    if (!snap || !h?.diskTotal || h.diskUsed === null) return null;
    const df = snap.docker.df;
    const parts = df ? [
      { id: 'images', label: 'Docker images', slot: 1, bytes: df.imagesBytes ?? 0, note: `${df.imagesCount ?? 0} images · ${formatBytes(df.imagesUnusedBytes)} not used by any container` },
      { id: 'cache', label: 'Build cache', slot: 2, bytes: df.buildCacheBytes ?? 0, note: `${formatBytes(df.buildCacheReclaimable)} could be freed` },
      { id: 'volumes', label: 'Volumes & container files', slot: 3, bytes: (df.volumesBytes ?? 0) + (df.containersBytes ?? 0), note: `${df.volumesCount ?? 0} volumes · ${formatBytes(df.containersBytes)} written inside containers` },
    ] : [];
    const docker = parts.reduce((sum, p) => sum + p.bytes, 0);
    const other = Math.max(0, h.diskUsed - docker);
    const segments = [...parts, { id: 'other', label: 'Databases, code & everything else', slot: 0, bytes: other, note: 'Database files, the checkout, logs and backups' }]
      .map((s) => ({ ...s, pct: (s.bytes / h.diskTotal!) * 100 }));
    const reclaimable = df ? (df.buildCacheReclaimable ?? 0) + (df.imagesUnusedBytes ?? 0) : 0;
    return { segments, free: h.diskFree, total: h.diskTotal, reclaimable, dfAt: df?.at ?? null };
  });

  readonly containers = computed<ContainerView[]>(() => {
    const snap = this.snap();
    if (!snap) return [];
    const memMax = Math.max(1, ...snap.containers.map((c) => c.memBytes ?? 0));
    return snap.containers.map((c) => {
      const meta = containerMeta(c);
      const service = 'container:' + c.name;
      const running = this.points(service, 'running');
      const uptimePct = running.length ? (running.reduce((sum, p) => sum + p[1], 0) / running.length) * 100 : null;
      const restarts = restartsInRange(this.points(service, 'restart_count'));
      const up = c.state === 'running';
      const tone: ContainerView['tone'] = !up || c.health === 'unhealthy' ? 'live'
        : restarts > 0 || c.health === 'starting' || (c.memLimit && (c.memBytes ?? 0) / c.memLimit >= 0.9) ? 'warn' : 'ok';
      const since = (iso: string | null) => (iso ? formatAge(Date.now() - Date.parse(iso)) : '');
      const status = up
        ? [`Up ${since(c.startedAt)}`, c.health, restarts ? `restarted ${restarts}× in ${this.rangeLong()}` : ''].filter(Boolean).join(' · ')
        : `${c.state === 'restarting' ? 'Restarting' : 'Stopped'}${c.finishedAt ? ' ' + since(c.finishedAt) + ' ago' : ''}${c.oomKilled ? ' · out of memory' : c.exitCode ? ' · exit ' + c.exitCode : ''}`;
      return {
        c, label: meta.label, role: meta.role, group: meta.group, tone, status, restarts, uptimePct,
        cpuSpark: this.spark(this.points(service, 'cpu_pct')),
        memPct: c.memBytes !== null && c.memLimit ? Math.min(100, (c.memBytes / c.memLimit) * 100) : null,
        memScale: c.memBytes !== null ? Math.max(2, (c.memBytes / memMax) * 100) : 0,
      };
    });
  });
  readonly sorted = computed(() => {
    const list = [...this.containers()];
    const sort = this.sort();
    const problem = (v: ContainerView) => (v.tone === 'live' ? 2 : v.tone === 'warn' ? 1 : 0);
    if (sort === 'memory') return list.sort((a, b) => (b.c.memBytes ?? -1) - (a.c.memBytes ?? -1));
    if (sort === 'cpu') return list.sort((a, b) => (b.c.cpuPct ?? -1) - (a.c.cpuPct ?? -1));
    return list.sort((a, b) => problem(b) - problem(a) || (b.c.memBytes ?? 0) - (a.c.memBytes ?? 0));
  });
  readonly grouped = computed(() =>
    GROUPS.map((g, i) => {
      const items = this.sorted().filter((v) => v.group === g.id);
      return { ...g, slot: i + 1, items, mem: items.reduce((sum, v) => sum + (v.c.memBytes ?? 0), 0), cpu: items.reduce((sum, v) => sum + (v.c.cpuPct ?? 0), 0) };
    }).filter((g) => g.items.length),
  );

  // ---------- Drill-down ----------
  readonly detail = computed(() => {
    const name = this.selected();
    const view = this.containers().find((v) => v.c.name === name);
    if (!view) return null;
    const service = 'container:' + view.c.name;
    const ready = this.infra()?.container === view.c.name;
    const pts = (n: string) => (ready ? this.points(service, n, true) : []);
    const step = (this.infra()?.slotSeconds?.detail ?? 60) * 1000;
    const c = view.c;
    const facts: Array<{ label: string; value: string; mono?: boolean; warn?: boolean }> = [];
    const add = (label: string, value: string | null | undefined, opts: { mono?: boolean; warn?: boolean } = {}) => { if (value) facts.push({ label, value, ...opts }); };
    add('Container', c.name, { mono: true });
    // Helper-deployed images are referenced by digest: the first 12 characters identify it.
    add('Image', c.image?.startsWith('sha256:') ? c.image.slice(0, 19) : c.image, { mono: true });
    add(c.state === 'running' ? 'Started' : 'Stopped', c.state === 'running' ? (c.startedAt ? `${formatAge(Date.now() - Date.parse(c.startedAt))} ago` : null) : c.finishedAt ? `${formatAge(Date.now() - Date.parse(c.finishedAt))} ago` : null);
    add('Running in this range', view.uptimePct !== null ? formatPct(view.uptimePct) : null, { warn: view.uptimePct !== null && view.uptimePct < 99.5 });
    add('Restarts', `${c.restartCount ?? 0} since created${view.restarts ? ` · ${view.restarts} in ${this.rangeLong()}` : ''}`, { warn: view.restarts > 0 });
    add('Restart policy', c.restartPolicy);
    add('Health check', c.health ? `${c.health}${c.failingStreak ? ` · ${c.failingStreak} failures in a row` : ''}` : 'None', { warn: c.health === 'unhealthy' });
    if (c.state !== 'running') add('Exit', `${c.exitCode ?? '—'}${c.oomKilled ? ' · killed for using too much memory' : ''}`, { warn: true });
    add('Memory limit', c.memLimit ? `${formatBytes(c.memLimit)}${view.memPct !== null ? ` · ${formatPct(view.memPct)} used` : ''}` : 'No limit (shares the server)', { warn: (view.memPct ?? 0) >= 90 });
    add('CPU limit', c.cpuLimit ? `${c.cpuLimit} ${c.cpuLimit === 1 ? 'core' : 'cores'}` : 'No limit');
    add('Processes', c.pids !== null ? `${c.pids}${c.pidsLimit ? ` of ${c.pidsLimit}` : ''}` : null);
    add('Network since start', c.netRx !== null ? `↓ ${formatBytes(c.netRx)} · ↑ ${formatBytes(c.netTx)}` : null);
    add('Disk since start', c.blkRead !== null ? `read ${formatBytes(c.blkRead)} · wrote ${formatBytes(c.blkWrite)}` : null);
    add('Image size', formatBytes(c.imageBytes) === '—' ? null : formatBytes(c.imageBytes));
    add('Files written inside', formatBytes(c.writableBytes) === '—' ? null : formatBytes(c.writableBytes));
    add('Volumes', formatBytes(c.volumeBytes) === '—' ? null : formatBytes(c.volumeBytes));
    const cpuLimitPct = c.cpuLimit ? c.cpuLimit * 100 : null;
    return {
      view, ready, step, facts,
      cpu: [{ label: 'CPU', slot: 1, points: pts('cpu_pct') }] as ChartSeries[],
      cpuLimit: cpuLimitPct,
      mem: [{ label: 'Memory', slot: 1, points: pts('mem_bytes') }] as ChartSeries[],
      net: [{ label: 'In', slot: 1, points: pts('net_rx_bps') }, { label: 'Out', slot: 2, points: pts('net_tx_bps') }] as ChartSeries[],
      io: [{ label: 'Read', slot: 1, points: pts('blk_read_bps') }, { label: 'Write', slot: 2, points: pts('blk_write_bps') }] as ChartSeries[],
    };
  });

  toggle(name: string): void {
    this.select.emit(this.selected() === name ? null : name);
  }
  dfAge(at: string | null): string {
    return at ? formatAge(Date.now() - Date.parse(at)) : '';
  }
}
