import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SessionAuthService } from '../../services/session-auth.service';
import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { ObservabilityAccessComponent, type AccessGrant } from './observability-access.component';
import { KIND_LABEL, SERVICE_LABEL, formatMs, isFailedOutcome } from './observability-format';
import { ObservabilityTraceComponent, type Span } from './observability-trace.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

interface NamedChannels {
  channelNames?: Record<string, string | null>;
}
interface Summary {
  count: number;
  average: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errors: number;
  max: number;
}
interface Group extends Summary {
  service: string;
  kind: string;
  name: string;
  channel: string;
  lastAt: string;
  lastValue: number;
}
interface Overview extends NamedChannels {
  lastAt: string | null;
  generatedAt: string;
  http: Summary;
  chat: Summary;
  groups: Group[];
  timeline: Array<{ at: number; httpRps: number; chatRps: number }>;
  minutes: number;
}
export interface Grant {
  role: 'owner' | 'viewer' | 'investigator';
  channels: string[];
  services: string[];
}
interface Resource {
  at: string;
  service: string;
  name: string;
  value: number;
}
interface Log {
  at: string;
  service: string;
  channel: string;
  level: string;
  name: string;
  trace_id: string | null;
  fields: Record<string, unknown>;
}

/** Exact merge across channels: counts, failures and averages add up; p95 only as a worst case. */
interface Merged {
  count: number;
  errors: number;
  totalMs: number;
  average: number | null;
  worstP95: number | null;
  lastAt: string;
  lastValue: number;
}
interface Attention {
  tone: 'live' | 'warn';
  title: string;
  text: string;
  action?: { label: string; tab: Tab; kind?: CallKind; sort?: CallSort };
}
interface QueueView {
  key: string;
  label: string;
  wait: Merged | null;
  runs: Array<{ name: string; merged: Merged }>;
  phases: Array<{ name: string; merged: Merged }>;
  total: Merged | null;
  waiting: number | null;
  oldestWait: number | null;
  gaugeAt: string | null;
  jobs: number;
  failures: number;
}
interface DependencyView {
  service: string;
  label: string;
  role: string;
  up: boolean | null;
  at: string | null;
  meter: { label: string; used: number; limit: number; pct: number } | null;
  facts: Array<{ label: string; value: string; warn?: boolean }>;
  spark: string;
  sparkLabel: string;
}
interface ProcessView {
  key: string;
  label: string;
  service: string;
  rss: number | null;
  heap: number | null;
  cpu: number | null;
  lag: number | null;
  dropped: number | null;
  at: string;
  raidHealth?: {
    status: string;
    warning: boolean;
    at: string | null;
    facts: Array<{ label: string; value: string; at: string | null; stale: boolean }>;
  };
}

export type Tab = 'overview' | 'endpoints' | 'chat' | 'queues' | 'resources' | 'traces' | 'logs' | 'access';
type CallKind = 'all' | 'http' | 'http_client' | 'database' | 'cache';
type CallSort = 'busiest' | 'slowest' | 'failing';

const TABS: Tab[] = ['overview', 'endpoints', 'chat', 'queues', 'resources', 'traces', 'logs', 'access'];
const RANGES = [
  { minutes: 15, label: '15m', long: '15 minutes' },
  { minutes: 60, label: '1h', long: 'hour' },
  { minutes: 360, label: '6h', long: '6 hours' },
  { minutes: 1440, label: '24h', long: '24 hours' },
  { minutes: 10080, label: '7d', long: '7 days' },
  { minutes: 43200, label: '30d', long: '30 days' },
];
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  endpoints: 'Calls',
  chat: 'Chat & events',
  queues: 'Queues',
  resources: 'Servers',
  traces: 'Traces',
  logs: 'Logs',
  access: 'Access',
};
const CALL_KINDS: Array<{ id: CallKind; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'http', label: 'Our API' },
  { id: 'http_client', label: 'Outside services' },
  { id: 'database', label: 'Database' },
  { id: 'cache', label: 'Cache' },
];
const CHAT_STAGES = [
  { name: 'receive_to_route', label: 'Received', hint: 'Twitch → our handler' },
  { name: 'identity', label: 'Who is talking', hint: 'Roles & account lookup' },
  { name: 'moderation', label: 'Moderation', hint: 'Filters & AI checks' },
  { name: 'keywords', label: 'Keywords', hint: 'Auto-replies & triggers' },
  { name: 'delivery', label: 'Reply sent', hint: 'Message back to chat' },
];
const EVENT_LABEL: Record<string, string> = {
  'channel.chat.message': 'Chat messages',
  'channel.chat.notification': 'Subs, gifts & announcements',
  'channel.follow': 'Follows',
  'channel.bits.use': 'Bits',
  'channel.raid': 'Raids',
  'channel.ad_break.begin': 'Ad breaks',
  'channel.update': 'Title or category changes',
  'channel.shoutout.receive': 'Shoutouts received',
  'channel.channel_points_custom_reward_redemption.add': 'Channel point redemptions',
  'channel.subscribe': 'Subscriptions',
  'channel.cheer': 'Cheers',
  'stream.online': 'Went live',
  'stream.offline': 'Went offline',
};
const RUNTIME_METRIC = /^(.*)\.(cpu_cores|event_loop_p99_ms|heap_bytes|rss_bytes|telemetry_dropped)$/;
const RAID_PHASE_LABELS: Record<string, string> = {
  claimMs: 'Claim work', followQueriesMs: 'Read follows', followWriteMs: 'Write follow totals',
  period7Ms: '7-day summary', period30Ms: '30-day summary', reciprocityMs: 'Reciprocity',
  publishMs: 'Publish update', releaseMs: 'Release claim',
};
const RAID_HEALTH_STALE_MS = 90000;
const CALL_PAGE = 30;
const SLOW_API_MS = 2500;
const SLOW_WAIT_MS = 300000;
const LAG_MS = 200;
const CHART_W = 680;
const CHART_H = 180;
const CHART_TOP = 12;

@Component({
  selector: 'app-observability-page',
  imports: [DatePipe, IconComponent, AvatarComponent, SkeletonComponent, ObservabilityAccessComponent, ObservabilityTraceComponent],
  templateUrl: './observability-page.component.html',
  styleUrl: './observability-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObservabilityPageComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly auth = inject(SessionAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly base = `${environment.DIMA_API}/observability/api`;

  readonly Math = Math;
  readonly ranges = RANGES;
  readonly callKinds = CALL_KINDS;
  readonly chartW = CHART_W;
  readonly chartH = CHART_H;
  readonly chartTop = CHART_TOP;

  // ---------- Session, filters & loaded data ----------
  readonly grant = signal<Grant | null>(null);
  readonly channelNames = signal<Record<string, string | null>>({});
  readonly data = signal<Overview | null>(null);
  readonly resources = signal<Resource[]>([]);
  readonly resourcesLimited = signal(false);
  readonly spans = signal<Span[]>([]);
  readonly logs = signal<Log[]>([]);
  readonly grants = signal<AccessGrant[]>([]);
  readonly selectedTrace = signal<{ spans: Span[]; partial: boolean } | null>(null);
  readonly tab = signal<Tab>('overview');
  readonly minutes = signal(60);
  readonly service = signal('');
  readonly channel = signal('');
  readonly search = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly denied = signal(false);
  readonly refreshedAt = signal<Date | null>(null);
  private request = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------- View-only state ----------
  readonly callKind = signal<CallKind>('all');
  readonly callSort = signal<CallSort>('busiest');
  readonly callQuery = signal('');
  readonly callLimit = signal(CALL_PAGE);
  readonly showAllStreamers = signal(false);
  readonly showFilters = signal(false);
  readonly traceFilter = signal<'all' | 'failed' | 'slow'>('all');
  readonly logLevel = signal<'all' | 'error' | 'warn'>('all');
  readonly hoverIndex = signal<number | null>(null);


  readonly tabs = computed(() => {
    const grant = this.grant();
    const result: Tab[] = ['overview', 'endpoints', 'chat', 'queues'];
    if (!grant?.channels.length) result.push('resources');
    if (grant?.role !== 'viewer') result.push('traces', 'logs');
    if (grant?.role === 'owner') result.push('access');
    return result;
  });
  readonly systemWide = computed(() => !this.grant()?.channels.length);
  readonly rangeLong = computed(() => RANGES.find((r) => r.minutes === this.minutes())?.long ?? `${this.minutes()} minutes`);
  readonly knownChannels = computed(() =>
    Object.entries(this.channelNames())
      .map(([id, name]) => ({ id, name: name || `Unknown channel (${id})` }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  readonly serviceOptions = computed(() => {
    const options = ['api', 'bot', 'cron', 'queues'];
    if (this.tab() === 'resources') options.push('dragonfly', 'mongodb', 'qdrant', 'postgres', 'analytics');
    return options.map((id) => ({ id, label: SERVICE_LABEL[id] }));
  });
  readonly groups = computed(() => this.data()?.groups ?? []);
  readonly stale = computed(() => {
    const data = this.data();
    return !!data?.lastAt && Date.parse(data.generatedAt) - Date.parse(data.lastAt) > 90000;
  });
  readonly failures = computed(() => {
    let api = 0,
      chat = 0,
      other = 0;
    for (const row of this.groups()) {
      if (!row.errors) continue;
      if (row.kind === 'http') api += row.errors;
      else if (row.kind === 'chat') chat += row.errors;
      else if (row.kind !== 'chat_stage' && row.kind !== 'command_body' && row.kind !== 'queue_total') other += row.errors;
    }
    return { api, chat, other, total: api + chat + other };
  });

  // ---------- The answer: does anything need me? ----------
  readonly attention = computed<Attention[]>(() => {
    const data = this.data();
    if (!data) return [];
    const items: Attention[] = [];
    const groups = data.groups;
    if (this.stale() && data.lastAt) {
      items.push({
        tone: 'live',
        title: `No new data for ${this.age(data.lastAt, data.generatedAt)}`,
        text: 'The services may be down, or analytics stopped receiving data. Numbers below stop at the last observation.',
      });
    }
    const failing = (kind: string) => groups.filter((g) => g.kind === kind && g.errors > 0).sort((a, b) => b.errors - a.errors);
    const apiFails = failing('http');
    if (data.http.errors > 0) {
      const rate = data.http.count ? data.http.errors / data.http.count : 0;
      items.push({
        tone: rate >= 0.05 ? 'live' : 'warn',
        title: `${this.num(data.http.errors)} API ${this.plural(data.http.errors, 'request', 'requests')} failed (${this.pct(rate)})`,
        text: `${apiFails[0] ? `Most on ${apiFails[0].name}. ` : ''}Failed means a server error (5xx) or the caller gave up.`,
        action: { label: 'See failing calls', tab: 'endpoints', kind: 'http', sort: 'failing' },
      });
    }
    if (data.chat.errors > 0) {
      items.push({
        tone: 'live',
        title: `${this.num(data.chat.errors)} chat ${this.plural(data.chat.errors, 'message', 'messages')} failed to process`,
        text: 'The bot may have missed commands or moderation for these messages.',
        action: { label: 'Open chat', tab: 'chat' },
      });
    }
    const outside = failing('http_client');
    const outsideErrors = outside.reduce((sum, g) => sum + g.errors, 0);
    if (outsideErrors) {
      items.push({
        tone: 'warn',
        title: `${this.num(outsideErrors)} ${this.plural(outsideErrors, 'call', 'calls')} to outside services failed`,
        text: `Mostly ${this.unique(outside.map((g) => g.name)).slice(0, 2).join(' and ')}.`,
        action: { label: 'See failing calls', tab: 'endpoints', kind: 'http_client', sort: 'failing' },
      });
    }
    const storage = [...failing('database'), ...failing('cache')];
    const storageErrors = storage.reduce((sum, g) => sum + g.errors, 0);
    if (storageErrors) {
      items.push({
        tone: 'live',
        title: `${this.num(storageErrors)} database or cache ${this.plural(storageErrors, 'operation', 'operations')} failed`,
        text: `First seen on ${storage[0].name} (${this.serviceLabel(storage[0].service)}).`,
        action: { label: 'See failing calls', tab: 'endpoints', kind: storage[0].kind as CallKind, sort: 'failing' },
      });
    }
    const jobFails = failing('queue_run').filter((row) => !this.isRaidPhase(row));
    const jobErrors = jobFails.reduce((sum, g) => sum + g.errors, 0);
    if (jobErrors) {
      items.push({
        tone: 'warn',
        title: `${this.num(jobErrors)} background ${this.plural(jobErrors, 'job', 'jobs')} failed`,
        text: `In ${this.unique(jobFails.map((g) => this.queueLabel(this.queueKey(g.name)))).slice(0, 3).join(', ')}.`,
        action: { label: 'Open queues', tab: 'queues' },
      });
    }
    const slow = groups
      .filter((g) => g.kind === 'http' && !this.isStream(g) && g.count >= 5 && (g.p95 === null || g.p95 >= SLOW_API_MS))
      .sort((a, b) => (b.p95 ?? Infinity) - (a.p95 ?? Infinity));
    if (slow.length) {
      items.push({
        tone: 'warn',
        title: slow.length === 1 ? `${slow[0].name} is slow` : `${slow.length} API endpoints are slow`,
        text: `${slow.length === 1 ? '' : `Slowest: ${slow[0].name}. `}5% of its requests take longer than ${this.ms(slow[0].p95 ?? 300000)}.`,
        action: { label: 'See slowest calls', tab: 'endpoints', kind: 'http', sort: 'slowest' },
      });
    }
    const waits = this.queues().filter((q) => q.wait && (q.wait.worstP95 === null || q.wait.worstP95 >= SLOW_WAIT_MS));
    if (waits.length) {
      const worst = waits[0];
      items.push({
        tone: 'warn',
        title: `${worst.label} jobs waited up to ${this.ms(worst.wait!.worstP95 ?? 300000)}${worst.wait!.worstP95 === null ? '+' : ''} to start`,
        text: `Average wait ${this.ms(worst.wait!.average)}. ${waits.length > 1 ? `${waits.length - 1} more ${this.plural(waits.length - 1, 'queue is', 'queues are')} slow to start.` : 'Check that the worker is keeping up.'}`,
        action: { label: 'Open queues', tab: 'queues' },
      });
    }
    const lagging = this.processes().filter((p) => (p.lag ?? 0) >= LAG_MS);
    if (lagging.length) {
      items.push({
        tone: 'warn',
        title: `${lagging[0].label} is stalling for up to ${this.ms(lagging[0].lag)}`,
        text: 'A blocked event loop delays every request and chat message in that process.',
        action: this.tabs().includes('resources') ? { label: 'Open servers', tab: 'resources' } : undefined,
      });
    }
    for (const dep of this.dependencies()) {
      if (dep.up === false) {
        items.push({ tone: 'live', title: `${dep.label} isn't reporting`, text: `The analytics collector can't reach ${dep.label}, or ${dep.label} is down.`, action: { label: 'Open servers', tab: 'resources' } });
      } else if (dep.meter && dep.meter.pct >= 90) {
        items.push({ tone: 'warn', title: `${dep.label} ${dep.meter.label.toLowerCase()} is ${Math.round(dep.meter.pct)}% full`, text: `${this.bytes(dep.meter.used)} of ${this.bytes(dep.meter.limit)}.`, action: { label: 'Open servers', tab: 'resources' } });
      }
    }
    const dropped = this.processes().reduce((sum, p) => sum + (p.dropped ?? 0), 0) + this.resourceIncrease('analytics', 'buffer_dropped_batches');
    if (dropped > 0) {
      items.push({ tone: 'warn', title: 'Some telemetry was dropped', text: 'A buffer was full or Dragonfly was unreachable, so totals here may be a little low.' });
    }
    return items;
  });
  readonly health = computed(() => {
    const data = this.data();
    if (!data) return null;
    const items = this.attention();
    if (!data.lastAt) {
      return { tone: 'muted', icon: 'info', title: 'No data in this range yet', text: 'Numbers appear as soon as the API, bot and workers handle traffic.' };
    }
    if (items.length) {
      const live = items.some((i) => i.tone === 'live');
      return {
        tone: live ? 'live' : 'warn',
        icon: 'alert',
        title: items.length === 1 ? '1 thing needs a look' : `${items.length} things need a look`,
        text: `Over the last ${this.rangeLong()}${this.channel() ? ` for ${this.channelName(this.channel())}` : ''}.`,
      };
    }
    const p95 = data.http.p95;
    return {
      tone: 'ok',
      icon: 'ok',
      title: 'Everything looks healthy',
      text: `${this.num(data.http.count)} API requests and ${this.num(data.chat.count)} chat messages in the last ${this.rangeLong()}, nothing failed${
        data.http.count ? `, and 95% of requests finished within ${this.ms(p95 ?? 300000)}` : ''
      }.`,
    };
  });

  // ---------- Overview ----------
  readonly perMinute = computed(() => {
    const data = this.data();
    return data ? data.http.count / data.minutes : 0;
  });
  readonly timeline = computed(() => [...(this.data()?.timeline ?? [])].sort((a, b) => a.at - b.at));
  readonly chartMax = computed(() => this.niceMax(Math.max(0, ...this.timeline().flatMap((p) => [p.httpRps, p.chatRps]))));
  readonly chartSpan = computed(() => {
    const data = this.data();
    const end = data ? Date.parse(data.generatedAt) : Date.now();
    return { start: end - this.minutes() * 60000, end };
  });
  readonly chartPaths = computed(() => ({ http: this.paths('httpRps'), chat: this.paths('chatRps') }));
  readonly chartTicks = computed(() => {
    const { start, end } = this.chartSpan();
    return [start, start + (end - start) / 2, end];
  });
  readonly hoverPoint = computed(() => {
    const index = this.hoverIndex();
    const point = index === null ? null : this.timeline()[index];
    if (!point) return null;
    return { ...point, x: this.chartX(point.at), left: Math.min(88, Math.max(12, (this.chartX(point.at) / CHART_W) * 100)) };
  });
  readonly timeSinks = computed(() => {
    const merged = new Map<string, { service: string; kind: string; name: string; rows: Group[] }>();
    for (const row of this.groups()) {
      if (!['http', 'http_client', 'database', 'cache', 'command', 'queue_run', 'chat'].includes(row.kind) || this.isStream(row) || this.isRaidPhase(row) || !row.count) continue;
      const key = `${row.service}|${row.kind}|${row.name}`;
      const entry = merged.get(key) ?? { service: row.service, kind: row.kind, name: row.name, rows: [] };
      entry.rows.push(row);
      merged.set(key, entry);
    }
    const list = [...merged.values()]
      .map((entry) => ({ ...entry, merged: this.merge(entry.rows) }))
      .filter((entry) => entry.merged.totalMs > 0)
      .sort((a, b) => b.merged.totalMs - a.merged.totalMs)
      .slice(0, 6);
    const top = list[0]?.merged.totalMs || 1;
    return list.map((entry) => ({ ...entry, share: (entry.merged.totalMs / top) * 100 }));
  });
  readonly streamers = computed(() => {
    const counts = new Map<string, { channel: string; events: number; commands: number; calls: number }>();
    for (const row of this.groups()) {
      if (!row.channel) continue;
      const value = counts.get(row.channel) ?? { channel: row.channel, events: 0, commands: 0, calls: 0 };
      if (row.kind === 'event') value.events += row.count;
      if (row.kind === 'command') value.commands += row.count;
      if (['http_client', 'database', 'cache'].includes(row.kind)) value.calls += row.count;
      counts.set(row.channel, value);
    }
    const list = [...counts.values()].sort((a, b) => b.events - a.events || b.calls - a.calls).slice(0, 30);
    const top = Math.max(1, ...list.map((s) => s.events));
    return list.map((s) => ({ ...s, share: (s.events / top) * 100 }));
  });
  readonly visibleStreamers = computed(() => (this.showAllStreamers() ? this.streamers() : this.streamers().slice(0, 6)));
  readonly lifecycle = computed(() =>
    this.groups()
      .filter((r) => r.kind === 'lifecycle')
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
  );

  // ---------- Calls ----------
  readonly callCounts = computed(() => {
    const counts: Record<CallKind, number> = { all: 0, http: 0, http_client: 0, database: 0, cache: 0 };
    for (const row of this.groups()) {
      if (!(row.kind in counts) || row.kind === 'all') continue;
      counts[row.kind as CallKind]++;
      counts.all++;
    }
    return counts;
  });
  readonly callRows = computed(() => {
    const kind = this.callKind();
    const query = this.callQuery().trim().toLowerCase();
    const sort = this.callSort();
    const rows = this.groups().filter(
      (row) =>
        ['http', 'http_client', 'database', 'cache'].includes(row.kind) &&
        (kind === 'all' || row.kind === kind) &&
        (!query || `${row.name} ${row.service} ${this.channelName(row.channel)}`.toLowerCase().includes(query)),
    );
    const slowness = (row: Group) => (this.isStream(row) ? -1 : row.p95 === null ? Infinity : row.p95);
    return rows.sort((a, b) =>
      sort === 'failing'
        ? b.errors - a.errors || b.errors / b.count - a.errors / a.count || b.count - a.count
        : sort === 'slowest'
          ? slowness(b) - slowness(a) || (b.average ?? 0) - (a.average ?? 0)
          : b.count - a.count,
    );
  });
  readonly callScale = computed(() => Math.max(1, ...this.callRows().filter((r) => !this.isStream(r)).map((r) => r.p95 ?? r.max)));
  readonly visibleCalls = computed(() => this.callRows().slice(0, this.callLimit()));
  readonly callSummary = computed(() => {
    const rows = this.callRows();
    const failed = rows.reduce((sum, r) => sum + r.errors, 0);
    const calls = rows.reduce((sum, r) => sum + r.count, 0);
    return { calls, failed };
  });

  // ---------- Chat ----------
  readonly pipeline = computed(() => {
    const stages = CHAT_STAGES.map((stage) => {
      const rows = this.groups().filter((g) => g.kind === 'chat_stage' && g.name === stage.name);
      return { ...stage, merged: rows.length ? this.merge(rows) : null };
    }).filter((stage) => stage.merged);
    const total = stages.reduce((sum, s) => sum + (s.merged!.average ?? 0), 0) || 1;
    return stages.map((s) => ({ ...s, share: ((s.merged!.average ?? 0) / total) * 100 }));
  });
  readonly commands = computed(() =>
    this.groups()
      .filter((g) => g.kind === 'command' || g.kind === 'command_body')
      .sort((a, b) => b.count - a.count),
  );
  readonly commandScale = computed(() => Math.max(1, ...this.commands().map((r) => r.p95 ?? r.max)));
  readonly events = computed(() => {
    const merged = new Map<string, number>();
    for (const row of this.groups()) if (row.kind === 'event') merged.set(row.name, (merged.get(row.name) ?? 0) + row.count);
    const list = [...merged.entries()].map(([name, count]) => ({ name, count, label: EVENT_LABEL[name] ?? name })).sort((a, b) => b.count - a.count);
    const top = Math.max(1, ...list.map((e) => e.count));
    return list.map((e) => ({ ...e, share: (e.count / top) * 100 }));
  });

  // ---------- Queues ----------
  readonly queues = computed<QueueView[]>(() => {
    const byKey = new Map<string, Group[]>();
    for (const row of this.groups()) {
      if (!row.kind.startsWith('queue')) continue;
      const key = this.queueKey(row.name);
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const list = [...byKey.entries()].map(([key, rows]) => {
      const of = (kind: string) => rows.filter((r) => r.kind === kind);
      const runNames = this.unique(of('queue_run').filter((r) => !this.isRaidPhase(r)).map((r) => r.name));
      const phaseNames = this.unique(of('queue_run').filter((r) => this.isRaidPhase(r)).map((r) => r.name));
      const gauge = (suffix: string) => {
        const latest = of('queue')
          .filter((r) => r.name.endsWith(suffix))
          .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
        return latest.length ? latest.reduce((sum, r) => sum + (Date.parse(r.lastAt) === Date.parse(latest[0].lastAt) ? r.lastValue : 0), 0) : null;
      };
      const gauges = of('queue').sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
      const runs = runNames.map((name) => ({ name: name.includes('.') ? name.slice(name.indexOf('.') + 1) : '', merged: this.merge(of('queue_run').filter((r) => r.name === name)) }));
      const wait = of('queue_wait').length ? this.merge(of('queue_wait')) : null;
      const total = of('queue_total').length ? this.merge(of('queue_total')) : null;
      return {
        key,
        label: this.queueLabel(key),
        wait,
        runs,
        phases: phaseNames.map((name) => ({ name: RAID_PHASE_LABELS[name.slice('raid_analytics_rust.phase.'.length)], merged: this.merge(of('queue_run').filter((r) => r.name === name)) })),
        total,
        waiting: gauge('.waiting'),
        oldestWait: gauge('.oldest_wait_ms'),
        gaugeAt: gauges[0]?.lastAt ?? null,
        jobs: runs.reduce((sum, r) => sum + r.merged.count, 0) || wait?.count || 0,
        failures: runs.reduce((sum, r) => sum + r.merged.errors, 0),
      };
    });
    const waitScore = (q: QueueView) => (q.wait ? (q.wait.worstP95 ?? Infinity) : 0);
    return list.sort((a, b) => b.failures - a.failures || waitScore(b) - waitScore(a) || b.jobs - a.jobs);
  });

  // ---------- Servers ----------
  readonly latestResources = computed(() => {
    const latest = new Map<string, Resource>();
    for (const row of this.resources()) {
      const key = `${row.service}|${row.name}`;
      const known = latest.get(key);
      if (!known || Date.parse(row.at) > Date.parse(known.at)) latest.set(key, row);
    }
    return latest;
  });
  readonly dependencies = computed<DependencyView[]>(() => {
    const latest = this.latestResources();
    const services = this.unique([...latest.values()].map((r) => r.service));
    const order = ['dragonfly', 'mongodb', 'qdrant', 'postgres', 'analytics'];
    services.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    return services.map((service) => this.dependency(service));
  });
  readonly processes = computed<ProcessView[]>(() => {
    const byKey = new Map<string, ProcessView>();
    for (const row of this.groups()) {
      if (row.kind !== 'runtime') continue;
      const match = RUNTIME_METRIC.exec(row.name);
      if (!match) continue;
      const [, proc, metric] = match;
      const key = `${row.service}|${proc}`;
      const view = byKey.get(key) ?? { key, label: this.processLabel(row.service, proc), service: row.service, rss: null, heap: null, cpu: null, lag: null, dropped: null, at: row.lastAt };
      if (metric === 'rss_bytes') view.rss = row.lastValue;
      if (metric === 'heap_bytes') view.heap = row.lastValue;
      if (metric === 'cpu_cores') view.cpu = row.lastValue;
      if (metric === 'event_loop_p99_ms') view.lag = row.lastValue;
      // Dropped counts add up over the range, so use the total rather than the last bucket.
      if (metric === 'telemetry_dropped') view.dropped = (row.average ?? 0) * row.count;
      byKey.set(key, view);
    }
    const healthRows = this.groups().filter((row) => row.service === 'cron' && row.kind === 'worker' && row.channel === ''
      && ['health_query', 'backlog_channels', 'oldest_due_age_ms', 'last_success_age_ms'].some((metric) => row.name === `raid_analytics_rust.${metric}`));
    const key = 'cron|raid_analytics_rust';
    if (byKey.has(key) || healthRows.length) {
      const view: ProcessView = byKey.get(key) ?? { key, label: this.processLabel('cron', 'raid_analytics_rust'), service: 'cron', rss: null, heap: null, cpu: null, lag: null, dropped: null, at: '' };
      const latest = (metric: string) => healthRows.filter((row) => row.name === `raid_analytics_rust.${metric}`).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))[0];
      const check = latest('health_query');
      const fresh = (row: Group | undefined) => !!row && Number.isFinite(Date.parse(row.lastAt))
        && Date.now() - Date.parse(row.lastAt) <= RAID_HEALTH_STALE_MS && Date.parse(row.lastAt) <= Date.now() + 10000;
      const failed = check?.lastValue === 0;
      const succeeded = check?.lastValue === 1;
      const backlog = latest('backlog_channels');
      const currentBacklog = fresh(check) && succeeded && fresh(backlog) && backlog!.lastAt === check!.lastAt;
      view.raidHealth = {
        status: !check ? 'Refresh health unknown' : !fresh(check) ? 'Refresh health is stale'
          : failed ? 'Backlog check failed — pending work is unknown'
          : !succeeded ? 'Refresh health is uncertain — mixed query results'
          : !currentBacklog ? 'Pending work is unknown' : backlog!.lastValue === 0 ? 'No channels are due for refresh' : 'Channels are waiting for refresh',
        warning: !fresh(check) || !succeeded || !currentBacklog,
        at: check?.lastAt ?? null,
        facts: [
          ['backlog_channels', 'Pending channels'], ['oldest_due_age_ms', 'Oldest overdue'], ['last_success_age_ms', 'Last successful refresh'],
        ].map(([metric, label]) => {
          const row = latest(metric);
          const current = fresh(row) && fresh(check) && row!.lastAt === check!.lastAt;
          const valid = !!row && Number.isFinite(row.lastValue) && row.lastValue >= 0;
          const available = valid && current && (succeeded || (metric === 'last_success_age_ms' && failed));
          const empty = metric === 'oldest_due_age_ms' && currentBacklog && backlog!.lastValue === 0;
          return { label, value: empty ? 'None pending' : !available ? 'Unknown' : metric === 'backlog_channels' ? `${row!.count > 1 ? '≈ ' : ''}${this.num(row!.lastValue)}` : metric === 'last_success_age_ms' ? `${this.ms(row!.lastValue)} ago at sample` : this.ms(row!.lastValue),
            at: empty ? check!.lastAt : row?.lastAt ?? null, stale: !!row && !current && !empty };
        }),
      };
      byKey.set(key, view);
    }
    const lagging = (p: ProcessView) => Number((p.lag ?? 0) >= LAG_MS);
    return [...byKey.values()].sort((a, b) => lagging(b) - lagging(a) || (b.rss ?? 0) - (a.rss ?? 0));
  });
  readonly processScale = computed(() => Math.max(1, ...this.processes().map((p) => p.rss ?? 0)));

  // ---------- Traces & logs ----------
  readonly visibleSpans = computed(() => {
    const filter = this.traceFilter();
    return this.spans().filter((s) => filter === 'all' || (filter === 'failed' ? s.outcome === 'error' || s.outcome === 'aborted' : s.duration >= 1000));
  });
  readonly visibleLogs = computed(() => {
    const level = this.logLevel();
    return this.logs().filter((log) => level === 'all' || (level === 'error' ? log.level !== 'warn' : log.level === 'warn'));
  });
  readonly logCounts = computed(() => {
    const errors = this.logs().filter((l) => l.level !== 'warn').length;
    return { errors, warnings: this.logs().length - errors };
  });

  // ---------- Lifecycle ----------
  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const minutes = Number(params.get('minutes'));
    if (RANGES.some((r) => r.minutes === minutes)) this.minutes.set(minutes);
    this.service.set(params.get('service') || '');
    this.channel.set(params.get('channel') || '');
    const tab = params.get('tab') as Tab | null;
    if (tab && TABS.includes(tab)) this.tab.set(tab);
    const kind = params.get('kind') as CallKind | null;
    if (kind && CALL_KINDS.some((k) => k.id === kind)) this.callKind.set(kind);
    const sort = params.get('sort') as CallSort | null;
    if (sort && ['busiest', 'slowest', 'failing'].includes(sort)) this.callSort.set(sort);
    if (this.auth.token()) await this.initialize();
    const timer = setInterval(() => {
      if (!document.hidden && this.grant() && !this.loading() && this.tab() !== 'access') void this.refresh(false);
    }, 15000);
    this.destroy.onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.searchTimer);
      this.request++;
    });
  }

  async initialize(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const session = await firstValueFrom(this.http.get<{ grant: Grant } & NamedChannels>(this.base + '/session'));
      this.grant.set(session.grant);
      this.channelNames.set(session.channelNames || {});
      this.denied.set(false);
      if (!this.tabs().includes(this.tab())) this.tab.set('overview');
      await this.refresh(false);
    } catch (error) {
      this.handleError(error);
    } finally {
      this.loading.set(false);
    }
  }

  selectTab(tab: Tab): void {
    if (this.tab() === tab) return;
    this.tab.set(tab);
    this.selectedTrace.set(null);
    this.hoverIndex.set(null);
    void this.refresh();
  }
  setRange(minutes: number): void {
    this.minutes.set(minutes);
    this.hoverIndex.set(null);
    void this.refresh();
  }
  setService(value: string): void {
    this.service.set(value);
    void this.refresh();
  }
  setChannel(value: string): void {
    this.channel.set(value);
    void this.refresh();
  }
  focusStreamer(id: string): void {
    this.channel.set(id);
    void this.refresh();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  setSearch(value: string): void {
    this.search.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.refresh(), 450);
  }
  follow(action: NonNullable<Attention['action']>): void {
    if (action.kind) this.callKind.set(action.kind);
    if (action.sort) this.callSort.set(action.sort);
    this.callLimit.set(CALL_PAGE);
    this.tab.set(action.tab);
    void this.refresh();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  setCallKind(kind: CallKind): void {
    this.callKind.set(kind);
    this.callLimit.set(CALL_PAGE);
    this.updateUrl();
  }
  setCallSort(sort: CallSort): void {
    this.callSort.set(sort);
    this.callLimit.set(CALL_PAGE);
    this.updateUrl();
  }

  private updateUrl(): void {
    const calls = this.tab() === 'endpoints';
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        tab: this.tab(),
        minutes: this.minutes(),
        service: this.service() || null,
        channel: this.channel() || null,
        kind: calls && this.callKind() !== 'all' ? this.callKind() : null,
        sort: calls && this.callSort() !== 'busiest' ? this.callSort() : null,
      },
      replaceUrl: true,
    });
  }

  async refresh(updateUrl = true): Promise<void> {
    const id = ++this.request;
    const tab = this.tab();
    this.loading.set(true);
    this.error.set('');
    if (updateUrl) this.updateUrl();
    let params = new HttpParams().set('minutes', this.minutes());
    if (this.service()) params = params.set('service', this.service());
    if (this.channel()) params = params.set('channel', this.channel());
    try {
      if (tab === 'access') {
        const value = await firstValueFrom(this.http.get<{ grants: AccessGrant[] } & NamedChannels>(this.base + '/grants'));
        if (id === this.request) {
          this.grants.set(value.grants);
          this.mergeNames(value);
        }
      } else if (tab === 'traces') {
        const value = await firstValueFrom(this.http.get<{ spans: Span[] } & NamedChannels>(this.base + '/traces', { params }));
        if (id === this.request) {
          this.spans.set(value.spans);
          this.mergeNames(value);
        }
      } else if (tab === 'logs') {
        const query = this.search().trim() ? params.set('search', this.search().trim()) : params;
        const value = await firstValueFrom(this.http.get<{ logs: Log[] } & NamedChannels>(this.base + '/logs', { params: query }));
        if (id === this.request) {
          this.logs.set(value.logs);
          this.mergeNames(value);
        }
      } else {
        // The overview also reads the last 15 minutes of server samples so it can warn about them.
        const wantsResources = tab === 'resources' || (tab === 'overview' && this.systemWide());
        let resourceParams = new HttpParams().set('minutes', tab === 'resources' ? this.minutes() : 15);
        if (this.service()) resourceParams = resourceParams.set('service', this.service());
        const [value, resources] = await Promise.all([
          firstValueFrom(this.http.get<Overview>(this.base + '/overview', { params })),
          wantsResources
            ? firstValueFrom(this.http.get<{ samples: Resource[]; limited?: boolean }>(this.base + '/resources', { params: resourceParams })).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (id === this.request) {
          this.data.set(value);
          this.mergeNames(value);
          if (resources) {
            this.resources.set(resources.samples);
            this.resourcesLimited.set(!!resources.limited);
          }
        }
      }
      if (id === this.request) this.refreshedAt.set(new Date());
    } catch (error) {
      if (id === this.request) this.handleError(error);
    } finally {
      if (id === this.request) this.loading.set(false);
    }
  }

  private handleError(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      this.denied.set(error.status === 401 || error.status === 403);
      if (this.denied()) {
        this.grant.set(null);
        this.data.set(null);
        this.selectedTrace.set(null);
        this.resources.set([]);
        this.spans.set([]);
        this.logs.set([]);
        this.grants.set([]);
        this.channelNames.set({});
        if (error.status === 401) this.auth.clearSession();
      }
      this.error.set(
        error.status === 403
          ? "Your account doesn't have analytics access."
          : error.status === 401
            ? 'Your session expired. Sign in again to view analytics.'
            : "Analytics isn't answering right now. What you see may be out of date.",
      );
    } else this.error.set("Analytics isn't answering right now. What you see may be out of date.");
  }

  retry(): void {
    void (this.grant() ? this.refresh(false) : this.initialize());
  }

  async openTrace(id: string): Promise<void> {
    try {
      const value = await firstValueFrom(this.http.get<{ spans: Span[]; partial: boolean } & NamedChannels>(this.base + '/traces/' + id));
      this.mergeNames(value);
      this.selectedTrace.set(value);
    } catch (error) {
      this.handleError(error);
    }
  }
  openLogTrace(id: string): void {
    this.tab.set('traces');
    void this.refresh();
    void this.openTrace(id);
  }

  // ---------- Chart interaction ----------
  onChartPointer(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (!rect.width) return;
    const { start, end } = this.chartSpan();
    const at = start + ((event.clientX - rect.left) / rect.width) * (end - start);
    this.hoverIndex.set(this.nearestPoint(at));
  }
  onChartKey(event: KeyboardEvent): void {
    const count = this.timeline().length;
    if (!count) return;
    const current = this.hoverIndex();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      this.hoverIndex.set(current === null ? count - 1 : Math.min(count - 1, Math.max(0, current + step)));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.hoverIndex.set(event.key === 'Home' ? 0 : count - 1);
    } else if (event.key === 'Escape') this.hoverIndex.set(null);
  }
  private nearestPoint(at: number): number | null {
    const points = this.timeline();
    if (!points.length) return null;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].at - at) < Math.abs(points[best].at - at)) best = i;
    return best;
  }
  chartX(at: number): number {
    const { start, end } = this.chartSpan();
    return Math.max(0, Math.min(CHART_W, ((at - start) / Math.max(1, end - start)) * CHART_W));
  }
  chartY(value: number): number {
    return CHART_H - (value / this.chartMax()) * (CHART_H - CHART_TOP);
  }
  private paths(series: 'httpRps' | 'chatRps'): string[] {
    const step = this.minutes() > 1440 ? 3600000 : 60000;
    const result: string[] = [];
    let previous = 0;
    let current = '';
    for (const point of this.timeline()) {
      const x = this.chartX(point.at).toFixed(1);
      const y = this.chartY(point[series]).toFixed(1);
      // A gap in buckets means nothing was observed: break the line instead of drawing zero.
      if (point.at - previous > step * 1.5) {
        if (current) result.push(current);
        current = `M${x},${y}`;
      } else current += ` L${x},${y}`;
      previous = point.at;
    }
    if (current) result.push(current);
    return result;
  }
  private niceMax(value: number): number {
    if (value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
    return 10 * power;
  }

  // ---------- Derivations ----------
  private merge(rows: Group[]): Merged {
    let count = 0,
      errors = 0,
      totalMs = 0,
      worst: number | null = 0,
      newest = rows[0];
    for (const row of rows) {
      count += row.count;
      errors += row.errors;
      totalMs += (row.average ?? 0) * row.count;
      if (row.count && worst !== null) worst = row.p95 === null ? null : Math.max(worst, row.p95);
      if (Date.parse(row.lastAt) > Date.parse(newest.lastAt)) newest = row;
    }
    return { count, errors, totalMs, average: count ? totalMs / count : null, worstP95: count ? worst : null, lastAt: newest.lastAt, lastValue: newest.lastValue };
  }
  private dependency(service: string): DependencyView {
    const latest = this.latestResources();
    const value = (name: string) => latest.get(`${service}|${name}`)?.value ?? null;
    const at = [...latest.values()].filter((r) => r.service === service).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.at ?? null;
    const up = value('collector_up');
    const facts: DependencyView['facts'] = [];
    const add = (label: string, raw: number | null, format: (v: number) => string, warn = false) => {
      if (raw !== null) facts.push({ label, value: format(raw), warn });
    };
    const bytes = (v: number) => this.bytes(v);
    const count = (v: number) => this.num(v);
    let meter: DependencyView['meter'] = null;
    const makeMeter = (label: string, used: number | null, limit: number | null) =>
      used !== null && limit ? { label, used, limit, pct: Math.min(100, (used / limit) * 100) } : null;
    let sparkName = '';
    let sparkLabel = '';
    if (service === 'dragonfly') {
      meter = makeMeter('Memory', value('used_memory'), value('maxmemory'));
      add('Memory used', meter ? null : value('used_memory'), bytes);
      add('Operations / s', value('instantaneous_ops_per_sec'), count);
      add('Clients', value('connected_clients'), count);
      const hits = value('keyspace_hits');
      const misses = value('keyspace_misses');
      if (hits !== null && misses !== null && hits + misses > 0) facts.push({ label: 'Hit rate since restart', value: this.pct(hits / (hits + misses)) });
      const evicted = this.resourceIncrease(service, 'evicted_keys');
      add('Evicted in range', evicted, count, evicted > 0);
      add('Expired keys (total)', value('expired_keys'), count);
      sparkName = 'used_memory';
      sparkLabel = 'Memory';
    } else if (service === 'mongodb') {
      meter = makeMeter('Working cache', value('cache_bytes'), value('cache_limit_bytes'));
      add('Data', value('dataSize'), bytes);
      add('Indexes', value('indexSize'), bytes);
      add('On disk', value('storageSize'), bytes);
      add('Resident memory', value('resident_bytes'), bytes);
      add('Connections', value('connections'), count);
      sparkName = 'resident_bytes';
      sparkLabel = 'Resident memory';
    } else if (service === 'qdrant') {
      add('Resident memory', value('memory_resident_bytes'), bytes);
      add('Allocated', value('memory_allocated_bytes'), bytes);
      add('Active', value('memory_active_bytes'), bytes);
      add('Collections', value('collections_total'), count);
      add('Vectors', value('collections_vector_total'), count);
      sparkName = 'memory_resident_bytes';
      sparkLabel = 'Resident memory';
    } else if (service === 'postgres') {
      add('Analytics database', value('database_bytes'), bytes);
      add('Table data', value('table_bytes'), bytes);
      add('Connections', value('connections'), count);
      sparkName = 'database_bytes';
      sparkLabel = 'Database size';
    } else if (service === 'analytics') {
      add('Batches waiting', value('buffer_batches'), count, (value('buffer_batches') ?? 0) > 50);
      const dropped = this.resourceIncrease(service, 'buffer_dropped_batches');
      add('Dropped in range', dropped, count, dropped > 0);
      add('Queues tracked', value('queue_keys_observed'), count);
      add('Memory', value('rss_bytes'), bytes);
      sparkName = 'rss_bytes';
      sparkLabel = 'Memory';
    } else {
      for (const row of latest.values()) {
        if (row.service !== service || row.name === 'collector_up') continue;
        add(row.name, row.value, (v) => (/bytes|size/i.test(row.name) ? bytes(v) : count(v)));
      }
    }
    return {
      service,
      label: this.serviceLabel(service),
      role: { dragonfly: 'Cache, sessions & job queues', mongodb: 'Main database', qdrant: 'Vector search for chat memory', postgres: 'Analytics storage', analytics: 'Collects these numbers' }[service] ?? '',
      up: up === null ? null : up > 0,
      at,
      meter,
      facts,
      spark: sparkName ? this.sparkline(service, sparkName) : '',
      sparkLabel,
    };
  }
  private series(service: string, name: string): Resource[] {
    return this.resources()
      .filter((r) => r.service === service && r.name === name)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  private resourceIncrease(service: string, name: string): number {
    const series = this.series(service, name);
    if (series.length < 2) return 0;
    // Counters reset when the service restarts; only count increases.
    let total = 0;
    for (let i = 1; i < series.length; i++) total += Math.max(0, series[i].value - series[i - 1].value);
    return total;
  }
  private sparkline(service: string, name: string): string {
    const series = this.series(service, name);
    if (series.length < 2) return '';
    const values = series.map((r) => r.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const first = Date.parse(series[0].at);
    const span = Math.max(1, Date.parse(series[series.length - 1].at) - first);
    return series
      .map((r, i) => `${i ? 'L' : 'M'}${(((Date.parse(r.at) - first) / span) * 120).toFixed(1)},${(30 - (max === min ? 0.5 : (r.value - min) / (max - min)) * 26 - 2).toFixed(1)}`)
      .join(' ');
  }
  queueKey(name: string): string {
    return name.split('.')[0];
  }
  private isRaidPhase(row: Group): boolean {
    return row.service === 'cron' && row.kind === 'queue_run' && row.name.startsWith('raid_analytics_rust.phase.')
      && Object.hasOwn(RAID_PHASE_LABELS, row.name.slice('raid_analytics_rust.phase.'.length));
  }
  queueLabel(key: string): string {
    if (key === 'tts') return 'Text to speech';
    const text = key.replace(/-v\d+$/, '').replace(/[-_]+/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  private processLabel(service: string, proc: string): string {
    if (proc === 'index') return { api: 'API server', bot: 'Chat bot', cron: 'Workers host' }[service] ?? `${this.serviceLabel(service)} process`;
    const text = proc.replace(/\.worker$/, '').replace(/[-_.]+/g, ' ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)} worker`;
  }

  // ---------- Formatting ----------
  mergeNames(value: NamedChannels): void {
    if (value.channelNames) this.channelNames.update((current) => Object.fromEntries(Object.entries({ ...current, ...value.channelNames }).slice(-1000)));
  }
  isStream(row: { kind: string; name: string }): boolean {
    return row.kind === 'http' && /\/stream$/.test(row.name);
  }
  tabLabel(tab: Tab): string {
    return TAB_LABEL[tab];
  }
  kindLabel(kind: string): string {
    return KIND_LABEL[kind] ?? kind;
  }
  serviceLabel(service: string): string {
    return SERVICE_LABEL[service] ?? service;
  }
  roleLabel(role: string): string {
    return role === 'owner' ? 'Owner' : role === 'investigator' ? 'Investigator' : 'Viewer';
  }
  channelName(id: string): string {
    return id ? this.channelNames()[id] || 'Unknown channel' : 'System';
  }
  channelLabel(id: string): string {
    return id ? `${this.channelName(id)} (${id})` : 'System';
  }
  commandName(row: Group): string {
    return row.name.startsWith('!') ? row.name : `!${row.name}`;
  }
  num(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
    return Math.round(value).toLocaleString('en-US');
  }
  pct(value: number): string {
    const pct = value * 100;
    return `${pct > 0 && pct < 0.1 ? '<0.1' : pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
  }
  rate(value: number): string {
    return value >= 10 ? Math.round(value).toLocaleString('en-US') : value >= 1 ? value.toFixed(1) : value.toFixed(2);
  }
  ms(value: number | null | undefined): string {
    return formatMs(value);
  }

  /** Percentiles are histogram upper bounds; `null` with traffic means beyond the last bucket. */
  bound(value: number | null, count: number): string {
    if (!count) return '—';
    return value === null ? '> 5 min' : `≤ ${this.ms(value)}`;
  }
  bytes(value: number | null): string {
    if (value === null) return '—';
    if (value < 1024) return `${value.toFixed(0)} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1073741824) return `${(value / 1048576).toFixed(value < 104857600 ? 1 : 0)} MiB`;
    return `${(value / 1073741824).toFixed(2)} GiB`;
  }
  age(from: string, to: string | Date = new Date()): string {
    const seconds = Math.max(0, (new Date(to).getTime() - Date.parse(from)) / 1000);
    if (seconds < 90) return `${Math.round(seconds)} s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
    return `${Math.round(seconds / 86400)} days`;
  }
  plural(count: number, one: string, many: string): string {
    return count === 1 ? one : many;
  }
  barWidth(value: number | null, scale: number): number {
    return value === null ? 100 : Math.max(2, Math.min(100, (value / scale) * 100));
  }
  fieldEntries(log: Log): Array<{ key: string; value: string }> {
    return Object.entries(log.fields).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
  }
  isFailed(outcome: string): boolean {
    return isFailedOutcome(outcome);
  }

  login(): void {
    void this.router.navigate(['/login']);
  }
  private unique<T>(list: T[]): T[] {
    return [...new Set(list)];
  }
}
