import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, distinctUntilChanged, map, switchMap } from 'rxjs';
import { AnalyticsApiService } from '../../services/analytics-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent, LfIconName } from '../../shared/lf-icon/lf-icon.component';
import { StreamTimeline, TimelineEvent, TimelineStream, TimelinePeople, TimelineCredits, TimelineRank } from '../../models/stream-timeline.model';

type MetricKey = 'viewers' | 'messages' | 'chatters' | 'commands' | 'emotes';
type Sample = { x: number; y: number | null; gap: boolean };
type Swing = { dir: 'up' | 'down'; from: number; to: number; delta: number; cause: TimelineEvent | null };

const KIND_ICONS: Record<string, LfIconName> = { game: 'gamepad', title: 'list', raid: 'users', redemption: 'zap', note: 'pin', follow: 'plus', sub: 'star', gift: 'gift', bits: 'bits' };
const RISE_CAUSES = ['raid', 'game', 'note', 'gift', 'sub', 'bits', 'title'];
const DROP_CAUSES = ['game', 'note', 'title', 'raid'];
const BUCKET = 300;

/** Rounds a chart ceiling up to 1, 2 or 5 × 10ⁿ so gridline labels read cleanly. */
function niceMax(value: number): number {
  if (value <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(value)), n = value / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

function seriesOf(data: StreamTimeline, key: MetricKey): Sample[] {
  switch (key) {
    case 'viewers': return data.points.map(p => ({ x: p.offsetSeconds, y: p.viewers, gap: p.gap }));
    case 'messages': return data.points.map(p => ({ x: p.offsetSeconds, y: p.messagesPerMinute, gap: p.gap }));
    case 'commands': return data.points.map(p => ({ x: p.offsetSeconds, y: p.commandsPerMinute ?? null, gap: p.gap }));
    case 'chatters': return data.chatters.map(p => ({ x: p.offsetSeconds, y: p.count, gap: false }));
    case 'emotes': return (data.activity?.series || []).map(p => ({ x: p.offsetSeconds, y: p.emotes ?? null, gap: false }));
  }
}

@Component({
  selector: 'app-stream-timeline-page', imports: [RouterLink, LfIconComponent],
  templateUrl: './stream-timeline-page.component.html', styleUrl: './stream-timeline-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StreamTimelinePageComponent {
  private readonly api = inject(AnalyticsApiService);
  private readonly auth = inject(SessionAuthService);
  private readonly language = inject(LanguageService);
  private readonly upgrade = inject(UpgradeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  protected readonly Math = Math;
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('markerDialog');
  readonly streamStrip = viewChild<ElementRef<HTMLElement>>('streamStrip');
  readonly chartCard = viewChild<ElementRef<HTMLElement>>('chartCard');
  readonly streamer = signal('');
  readonly channelID = signal('');
  readonly streams = signal<TimelineStream[]>([]);
  readonly selectedID = signal('');
  readonly timeline = signal<StreamTimeline | null>(null);
  readonly loading = signal(true);
  readonly listLoading = signal(false);
  readonly error = signal(false);
  readonly listError = signal(false);
  readonly hasMore = signal(false);
  readonly selectedOffset = signal(0);
  readonly hoverOffset = signal<number | null>(null);
  readonly metric = signal<MetricKey | 'all'>('viewers');
  readonly saving = signal(false);
  readonly markerError = signal(false);
  readonly markerLabel = signal('');
  readonly markerMinutes = signal('0');
  readonly deleting = signal<TimelineEvent | null>(null);
  readonly submitted = signal(false);
  readonly eventKinds = ['game', 'title', 'raid', 'redemption', 'follow', 'sub', 'gift', 'bits', 'note'];
  readonly rangeStart = signal(0);
  readonly rangeEnd = signal(0);
  readonly rangeError = signal(false);
  readonly search = signal('');
  readonly momentKinds = signal<string[]>([]);
  readonly showAllMoments = signal(false);
  readonly openRankings = signal<string[]>([]);
  /** Phones list fewer rows before "Show all" so the page stays short. */
  readonly compact = signal(typeof matchMedia === 'function' && matchMedia('(max-width: 639px)').matches);
  readonly comparison = signal<StreamTimeline | null>(null);
  readonly compareID = signal('');
  readonly detailLoading = signal(false);
  readonly detailError = signal(false);
  readonly people = signal<TimelinePeople | null>(null);
  readonly peopleLabel = signal('');
  readonly peopleKind = signal('');
  readonly peopleKey = signal('');
  readonly credits = signal<TimelineCredits | null>(null);
  readonly momentCursor = signal<string | null>(null);
  readonly momentsLoading = signal(false);
  readonly momentsError = signal(false);
  private scrubbing = false;
  private detailSequence = 0;
  private page = 1;
  private sequence = 0;
  private listSequence = 0;
  private markerKey = '';
  readonly backLink = computed(() => ['/', this.streamer(), 'modules', 'analytics']);
  readonly duration = computed(() => this.timeline()?.session.durationSeconds || 0);
  readonly zoomed = computed(() => this.rangeStart() > 0 || this.rangeEnd() < this.duration());
  readonly zoomLevel = computed(() => !this.zoomed() ? 0 : Math.round(this.rangeEnd() - this.rangeStart()));
  readonly cursor = computed(() => this.hoverOffset() ?? this.selectedOffset());
  readonly isOwner = computed(() => Boolean(this.timeline()?.canAnnotate));
  readonly trends = computed(() => Boolean(this.timeline()?.activity?.capabilities.trends));

  // ── Moments ────────────────────────────────────────────────────────────
  readonly rangeEvents = computed(() => this.timeline()?.events.filter(e => e.offsetSeconds >= this.rangeStart() && e.offsetSeconds <= this.rangeEnd()) || []);
  readonly kindCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const event of this.rangeEvents()) counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
    return this.eventKinds.filter(kind => counts.has(kind)).map(kind => ({ kind, count: counts.get(kind)!, icon: KIND_ICONS[kind] }));
  });
  readonly allVisibleEvents = computed(() => {
    const kinds = this.momentKinds(), query = this.search().trim().toLocaleLowerCase();
    return this.rangeEvents().filter(e => (!kinds.length || kinds.includes(e.kind)) && (!query || e.label.toLocaleLowerCase().includes(query)));
  });
  readonly events = computed(() => this.allVisibleEvents().slice(0, 200));
  readonly listedEvents = computed(() => this.showAllMoments() ? this.events() : this.events().slice(0, this.compact() ? 6 : 12));
  readonly hiddenEventCount = computed(() => this.events().length - this.listedEvents().length);
  readonly showSearch = computed(() => (this.timeline()?.events.length || 0) > 8 || this.search() !== '');

  // ── Inspection cursor ──────────────────────────────────────────────────
  readonly inspectionOffsets = computed(() => {
    const data = this.timeline();
    return data ? [...new Set([...data.points.map(p => p.offsetSeconds), ...data.chatters.filter(p => p.count !== null).map(p => p.offsetSeconds), ...data.events.map(e => e.offsetSeconds)])].filter(at => at >= this.rangeStart() && at <= this.rangeEnd()).sort((a, b) => a - b) : [];
  });
  readonly cursorPoint = computed(() => this.nearestPoint(this.cursor()));
  readonly cursorValues = computed(() => {
    const data = this.timeline(), at = this.cursor(), point = this.cursorPoint();
    if (!data) return [];
    const bucket = (rows: { offsetSeconds: number }[]) => rows.find(p => p.offsetSeconds <= at && p.offsetSeconds + BUCKET > at);
    const rows: { key: MetricKey; value: number | null }[] = [
      { key: 'viewers', value: point?.viewers ?? null },
      { key: 'messages', value: point?.messagesPerMinute ?? null },
      { key: 'chatters', value: (bucket(data.chatters) as { count: number | null } | undefined)?.count ?? null }
    ];
    if (this.trends()) {
      rows.push({ key: 'commands', value: point?.commandsPerMinute ?? null });
      rows.push({ key: 'emotes', value: (bucket(data.activity?.series || []) as { emotes?: number } | undefined)?.emotes ?? null });
    }
    return rows;
  });
  readonly cursorEvents = computed(() => this.timeline()?.events.filter(e => Math.abs(e.offsetSeconds - this.cursor()) < BUCKET / 2).slice(0, 4) || []);
  readonly cursorX = computed(() => this.pct(this.cursor()));
  readonly cursorDot = computed(() => {
    const chart = this.charts()[0];
    if (!chart || this.metric() === 'all') return null;
    const sample = this.sampleAt(chart.key, this.cursor());
    return sample === null ? null : 100 - sample / chart.max * 92;
  });

  // ── Recap: the answer to "how did this stream go?" ────────────────────
  readonly recap = computed(() => {
    const data = this.timeline(), points = data?.points || [];
    if (!data || !points.length) return null;
    const peak = points.reduce((best, p) => p.viewers > best.viewers ? p : best);
    const average = Math.round(points.reduce((sum, p) => sum + p.viewers, 0) / points.length);
    const chat = points.filter(p => p.messagesPerMinute !== null);
    const chatPeak = chat.length ? chat.reduce((best, p) => (p.messagesPerMinute ?? 0) > (best.messagesPerMinute ?? 0) ? p : best) : null;
    return { peak, average, chatPeak: chatPeak && (chatPeak.messagesPerMinute ?? 0) > 0 ? chatPeak : null, now: data.session.status === 'live' ? points[points.length - 1] : null };
  });
  readonly swings = computed<Swing[]>(() => {
    const data = this.timeline(), points = data?.points || [];
    if (!data || points.length < 3) return [];
    const threshold = Math.max(3, Math.max(...points.map(p => p.viewers)) * 0.1);
    let rise: Swing | null = null, drop: Swing | null = null;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length && points[j].offsetSeconds - points[i].offsetSeconds <= 900 && !points[j].gap; j++) {
        const delta = points[j].viewers - points[i].viewers;
        if (delta > 0 && (!rise || delta > rise.delta)) rise = { dir: 'up', from: points[i].offsetSeconds, to: points[j].offsetSeconds, delta, cause: null };
        if (delta < 0 && (!drop || delta < drop.delta)) drop = { dir: 'down', from: points[i].offsetSeconds, to: points[j].offsetSeconds, delta, cause: null };
      }
    }
    return [rise, drop].filter((s): s is Swing => !!s && Math.abs(s.delta) >= threshold).map(swing => {
      const nearby = data.events.filter(e => e.offsetSeconds >= swing.from - BUCKET && e.offsetSeconds <= swing.to);
      const order = swing.dir === 'up' ? RISE_CAUSES : DROP_CAUSES;
      const cause = order.map(kind => nearby.find(e => e.kind === kind)).find(Boolean) || null;
      return { ...swing, cause };
    });
  });
  /** Contiguous runs of the same game, used for the band above the chart and the per-game recap. */
  readonly gameRuns = computed(() => {
    const data = this.timeline(), runs: { game: string; start: number; end: number; sum: number; n: number }[] = [];
    for (const p of data?.points || []) {
      const last = runs.at(-1);
      if (last && last.game === p.game) { last.sum += p.viewers; last.n++; last.end = p.offsetSeconds; continue; }
      if (last) last.end = p.offsetSeconds;
      runs.push({ game: p.game, start: p.offsetSeconds, end: p.offsetSeconds, sum: p.viewers, n: 1 });
    }
    const last = runs.at(-1);
    if (last && data) last.end = Math.max(last.end, data.session.durationSeconds);
    return runs;
  });
  readonly games = computed(() => {
    const totals = new Map<string, { game: string; seconds: number; sum: number; n: number; tone: number }>();
    for (const run of this.gameRuns()) {
      const row = totals.get(run.game) || { game: run.game, seconds: 0, sum: 0, n: 0, tone: totals.size % 4 };
      row.seconds += run.end - run.start; row.sum += run.sum; row.n += run.n; totals.set(run.game, row);
    }
    return [...totals.values()].map(row => ({ ...row, average: Math.round(row.sum / row.n) })).sort((a, b) => b.seconds - a.seconds);
  });
  readonly gameBand = computed(() => {
    const tones = new Map(this.games().map(g => [g.game, g.tone]));
    if (tones.size < 2) return [];
    return this.gameRuns().filter(run => run.end > this.rangeStart() && run.start < this.rangeEnd()).map(run => {
      const left = this.pct(Math.max(run.start, this.rangeStart())), right = this.pct(Math.min(run.end, this.rangeEnd()));
      return { game: run.game || this.t('unknown'), left, width: Math.max(0.5, right - left), tone: tones.get(run.game) ?? 0 };
    });
  });
  readonly totals = computed(() => {
    const totals = this.timeline()?.activity?.totals;
    if (!totals) return [];
    return ([['follows', totals.follows], ['subs', totals.subs], ['bits', totals.bits], ['raids', totals.raids], ['redemptions', totals.redemptions]] as const)
      .filter(([, value]) => value > 0).map(([key, value]) => ({ key, value }));
  });

  // ── Charts ─────────────────────────────────────────────────────────────
  readonly metrics = computed(() => {
    const data = this.timeline();
    if (!data) return [];
    const keys: MetricKey[] = ['viewers', 'messages', 'chatters', 'commands', 'emotes'];
    return keys.map(key => {
      const locked = (key === 'commands' || key === 'emotes') && !this.trends();
      const values = locked ? [] : seriesOf(data, key).map(p => p.y).filter((y): y is number => y !== null);
      return { key, locked, peak: values.length ? Math.max(...values) : null };
    }).filter(m => !m.locked || this.isOwner());
  });
  readonly charts = computed(() => {
    const data = this.timeline();
    if (!data) return [];
    const selected = this.metric();
    const keys = this.metrics().filter(m => !m.locked && (selected === 'all' || m.key === selected)).map(m => m.key);
    const other = this.comparison();
    return keys.map(key => {
      const values = this.clip(seriesOf(data, key));
      const compared = other ? this.clip(seriesOf(other, key)) : [];
      const max = niceMax(Math.max(1, ...values.map(p => p.y ?? 0), ...compared.map(p => p.y ?? 0)));
      const line = this.paths(values, max), comparePath = this.paths(compared, max).line;
      return { key, max, path: line.line, area: line.area, comparePath, available: values.some(p => p.y !== null) };
    });
  });
  readonly axis = computed(() => [0, 0.25, 0.5, 0.75, 1].map(f => this.rangeStart() + f * (this.rangeEnd() - this.rangeStart())));
  readonly pins = computed(() => this.events().slice(0, 120).map(e => ({ id: e.id, kind: e.kind, x: this.pct(e.offsetSeconds) })));
  readonly comparisonPeak = computed(() => Math.max(0, ...this.comparison()?.points.map(p => p.viewers) || []));
  readonly comparisonOptions = computed(() => this.streams().filter(s => s.id !== this.selectedID()));
  readonly creditTotal = computed(() => Math.round((this.credits()?.items.reduce((sum, c) => sum + c.credits, 0) || 0) * 10) / 10);
  readonly markerValid = computed(() => {
    const minutes = Number(this.markerMinutes());
    return this.markerLabel().trim().length > 0 && this.markerLabel().trim().length <= 120 && this.markerMinutes().trim() !== '' && Number.isFinite(minutes) && minutes >= 0 && minutes * 60 <= this.duration();
  });
  readonly markerAt = computed(() => { const minutes = Number(this.markerMinutes()); return Number.isFinite(minutes) && minutes >= 0 ? this.time(minutes * 60) : '—'; });

  constructor() {
    this.destroyRef.onDestroy(() => { this.sequence++; this.listSequence++; });
    if (typeof matchMedia === 'function') {
      const query = matchMedia('(max-width: 639px)'), sync = () => this.compact.set(query.matches);
      query.addEventListener('change', sync); this.destroyRef.onDestroy(() => query.removeEventListener('change', sync));
    }
    this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer') || ''), distinctUntilChanged(),
      switchMap(streamer => {
        this.sequence++; this.listSequence++; this.streamer.set(streamer); this.timeline.set(null); this.streams.set([]); this.selectedID.set(''); this.loading.set(true);
        return this.auth.resolveChannelID(streamer);
      }), takeUntilDestroyed()).subscribe({ next: channel => {
        this.channelID.set(channel || '');
        if (channel) void this.loadStreams(); else { this.loading.set(false); this.error.set(true); }
      }, error: () => { this.loading.set(false); this.error.set(true); } });
  }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(`streamTimeline.${key}`, params); }
  icon(kind: string): LfIconName { return KIND_ICONS[kind] || 'pin'; }
  /** VOD-style elapsed time: 0:25:00, 1:05:30. */
  time(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 3600)}:${Math.floor(total / 60 % 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
  }
  length(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return '—';
    const minutes = Math.max(0, Math.round(seconds / 60)), hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m` : `${minutes}m`;
  }
  private locale(): string { return this.language.currentLanguage() === 'es' ? 'es-ES' : 'en-US'; }
  date(value: string): string { return new Intl.DateTimeFormat(this.locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  day(value: string): string { return new Intl.DateTimeFormat(this.locale(), { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value)); }
  clock(value: string): string { return new Intl.DateTimeFormat(this.locale(), { hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
  streamLength(stream: TimelineStream): number | null { return stream.endedAt ? (Date.parse(stream.endedAt) - Date.parse(stream.startedAt)) / 1000 : null; }
  number(value: number | null | undefined): string { return value === null || value === undefined ? '—' : new Intl.NumberFormat(this.locale(), { maximumFractionDigits: 1 }).format(value); }
  pct(seconds: number): number { return (seconds - this.rangeStart()) / Math.max(1, this.rangeEnd() - this.rangeStart()) * 100; }
  x(seconds: number): number { return this.pct(seconds) * 10; }
  viewersAt(seconds: number): number | null { return this.nearestPoint(seconds)?.viewers ?? null; }
  rankRows(kind: string, rows: TimelineRank[]): TimelineRank[] { return this.openRankings().includes(kind) ? rows : rows.slice(0, 5); }
  toggleRanking(kind: string): void { this.openRankings.update(open => open.includes(kind) ? open.filter(k => k !== kind) : [...open, kind]); }
  share(count: number, rows: TimelineRank[]): number { return Math.max(4, count / Math.max(1, ...rows.map(r => r.count)) * 100); }

  private nearestPoint(seconds: number) {
    const points = this.timeline()?.points || [];
    return points.reduce<(typeof points)[number] | null>((best, point) => !best || Math.abs(point.offsetSeconds - seconds) < Math.abs(best.offsetSeconds - seconds) ? point : best, null);
  }
  private sampleAt(key: MetricKey, seconds: number): number | null {
    const data = this.timeline();
    if (!data) return null;
    const values = seriesOf(data, key).filter(p => p.y !== null);
    if (key === 'chatters' || key === 'emotes') return values.find(p => p.x <= seconds && p.x + BUCKET > seconds)?.y ?? null;
    return values.reduce<Sample | null>((best, p) => !best || Math.abs(p.x - seconds) < Math.abs(best.x - seconds) ? p : best, null)?.y ?? null;
  }
  private clip(values: Sample[]): Sample[] { return values.filter(p => p.x >= this.rangeStart() && p.x <= this.rangeEnd()); }
  /** SVG line + area paths on a 1000×100 box; a null value or a recording gap breaks the line. */
  private paths(values: Sample[], max: number): { line: string; area: string } {
    let line = '', area = '', run: string[] = [], firstX = 0, lastX = 0;
    const close = () => { if (run.length) area += `M${firstX},100 L${run.join(' L')} L${lastX},100 Z `; run = []; };
    for (const p of values) {
      if (p.y === null) { close(); continue; }
      if (p.gap) close();
      const x = Math.round(this.x(p.x) * 10) / 10, y = Math.round((100 - p.y / max * 92) * 10) / 10;
      if (!run.length) firstX = x;
      line += `${run.length ? 'L' : 'M'}${x},${y} `;
      run.push(`${x},${y}`); lastX = x;
    }
    close();
    return { line, area };
  }
  private snap(offset: number): number {
    const offsets = this.inspectionOffsets();
    return offsets.reduce((best, at) => Math.abs(at - offset) < Math.abs(best - offset) ? at : best, offsets[0] ?? offset);
  }
  private offsetFromPointer(event: PointerEvent): number {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return this.snap(this.rangeStart() + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (this.rangeEnd() - this.rangeStart()));
  }

  // ── Chart interaction: drag/tap on touch, hover + click with a mouse, arrows on keyboard ──
  plotDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.scrubbing = true; (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.hoverOffset.set(null); this.selectedOffset.set(this.offsetFromPointer(event));
  }
  plotMove(event: PointerEvent): void {
    if (this.scrubbing) this.selectedOffset.set(this.offsetFromPointer(event));
    else if (event.pointerType === 'mouse') this.hoverOffset.set(this.offsetFromPointer(event));
  }
  plotUp(): void { this.scrubbing = false; }
  plotLeave(): void { if (!this.scrubbing) this.hoverOffset.set(null); }
  plotKey(event: KeyboardEvent): void {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -6, PageUp: 6 };
    const offsets = this.inspectionOffsets();
    if (!offsets.length) return;
    if (event.key === 'Home' || event.key === 'End') this.selectedOffset.set(event.key === 'Home' ? offsets[0] : offsets[offsets.length - 1]);
    else if (steps[event.key]) this.step(steps[event.key]);
    else return;
    event.preventDefault(); this.hoverOffset.set(null);
  }
  step(by: number): void {
    const offsets = this.inspectionOffsets();
    if (!offsets.length) return;
    const current = offsets.indexOf(this.snap(this.selectedOffset()));
    this.selectedOffset.set(offsets[Math.max(0, Math.min(offsets.length - 1, current + by))]);
  }
  /** Moves the cursor; on phones the chart is far above the list, so bring it into view. */
  inspect(seconds: number, reveal = false): void {
    this.hoverOffset.set(null);
    if (seconds < this.rangeStart() || seconds > this.rangeEnd()) this.applyRange('0', String(this.duration() / 60));
    this.selectedOffset.set(this.snap(seconds));
    if (reveal && typeof matchMedia === 'function' && matchMedia('(max-width: 959px)').matches) {
      this.chartCard()?.nativeElement.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  pickMetric(key: MetricKey | 'all', locked = false): void { if (locked) this.openUpgrade(); else this.metric.set(key); }
  openUpgrade(): void { void this.upgrade.promptUpgradeForAnyPlan('stream_timeline'); }

  selectStream(id: string): void { if (id !== this.selectedID() || this.error()) void this.loadTimeline(id); }
  async loadStreams(more = false): Promise<void> {
    const sequence = ++this.listSequence, page = more ? this.page + 1 : 1;
    this.listLoading.set(true); this.listError.set(false);
    try {
      const response = await firstValueFrom(this.api.getTimelineStreams(this.channelID(), page));
      if (sequence !== this.listSequence) return;
      if (response.error || !response.data) throw new Error('list');
      this.page = page; this.streams.set(more ? [...this.streams(), ...response.data.streams.filter(s => !this.streams().some(r => r.id === s.id))] : response.data.streams); this.hasMore.set(response.data.hasMore);
      if (!more) {
        const requested = this.route.snapshot.queryParamMap.get('stream');
        const id = requested && /^[a-f0-9]{24}$/i.test(requested) ? requested : this.streams()[0]?.id;
        if (id) await this.loadTimeline(id); else this.loading.set(false);
      }
    } catch { if (sequence === this.listSequence) { this.listError.set(true); this.loading.set(false); } }
    finally { if (sequence === this.listSequence) this.listLoading.set(false); }
  }
  async loadTimeline(id = this.selectedID()): Promise<void> {
    const sequence = ++this.sequence, sameStream = id === this.selectedID() && !!this.timeline();
    const keepRange = sameStream || !this.selectedID(), previousOffset = sameStream ? this.selectedOffset() : null;
    this.detailSequence++; this.comparison.set(null); this.compareID.set(''); this.people.set(null); this.credits.set(null);
    this.detailLoading.set(false); this.detailError.set(false);
    if (!sameStream) { this.momentKinds.set([]); this.search.set(''); this.showAllMoments.set(false); }
    this.selectedID.set(id); this.loading.set(true); this.error.set(false); this.timeline.set(null); this.hoverOffset.set(null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { stream: id, ...(keepRange ? {} : { from: null, to: null }) }, queryParamsHandling: 'merge', replaceUrl: true });
    this.revealSelectedStream();
    try {
      const response = await firstValueFrom(this.api.getStreamTimeline(this.channelID(), id));
      if (sequence !== this.sequence) return;
      if (response.error || !response.data) throw new Error('timeline');
      this.timeline.set(response.data);
      const query = this.route.snapshot.queryParamMap, total = response.data.session.durationSeconds;
      const start = keepRange ? Number(query.get('from') || 0) : 0, end = keepRange ? Number(query.get('to') || total) : total;
      this.rangeStart.set(Number.isFinite(start) && start >= 0 && start < total ? start : 0);
      this.rangeEnd.set(Number.isFinite(end) && end > this.rangeStart() ? Math.min(end, total) : total);
      this.momentCursor.set(response.data.markerPage?.cursor || null);
      this.selectedOffset.set(previousOffset ?? this.recap()?.peak.offsetSeconds ?? this.inspectionOffsets()[0] ?? 0);
      if (this.selectedOffset() < this.rangeStart() || this.selectedOffset() > this.rangeEnd()) this.selectedOffset.set(this.inspectionOffsets()[0] ?? this.rangeStart());
      if (!this.streams().some(s => s.id === id)) this.streams.update(rows => [response.data!.session, ...rows]);
    } catch { if (sequence === this.sequence) this.error.set(true); }
    finally { if (sequence === this.sequence) this.loading.set(false); }
  }
  /** Keeps the chosen stream chip visible inside the horizontal strip without scrolling the page. */
  private revealSelectedStream(): void {
    afterNextRender(() => {
      const strip = this.streamStrip()?.nativeElement, chip = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (strip && chip && (chip.offsetLeft < strip.scrollLeft || chip.offsetLeft + chip.offsetWidth > strip.scrollLeft + strip.clientWidth)) strip.scrollLeft = chip.offsetLeft - 16;
    }, { injector: this.injector });
  }
  applyRange(fromMinutes: string, toMinutes: string): void {
    const from = Math.round(Number(fromMinutes) * 60), to = Math.round(Number(toMinutes) * 60);
    this.rangeError.set(!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > this.duration());
    if (this.rangeError()) return;
    this.rangeStart.set(from); this.rangeEnd.set(to); this.showAllMoments.set(false);
    if (this.selectedOffset() < from || this.selectedOffset() > to) this.selectedOffset.set(this.inspectionOffsets()[0] ?? from);
    const full = from === 0 && to === this.duration();
    void this.router.navigate([], { relativeTo: this.route, queryParams: { from: full ? null : from, to: full ? null : to }, queryParamsHandling: 'merge', replaceUrl: true });
  }
  zoom(seconds: number): void {
    const duration = this.duration();
    if (!seconds || seconds >= duration) { this.applyRange('0', String(duration / 60)); return; }
    const start = Math.max(0, Math.min(this.selectedOffset() - seconds / 2, duration - seconds));
    this.applyRange(String(start / 60), String((start + seconds) / 60));
  }
  toggleMoment(kind: string): void {
    this.showAllMoments.set(false);
    this.momentKinds.update(kinds => kinds.includes(kind) ? kinds.filter(item => item !== kind) : [...kinds, kind]);
  }
  async loadMoments(reset = false): Promise<void> {
    if (this.momentsLoading()) return;
    const session = this.selectedID(), kinds = this.momentKinds();
    this.momentsLoading.set(true); this.momentsError.set(false);
    const kind = kinds.length === 1 && !['game', 'title'].includes(kinds[0]) ? kinds[0] : 'all';
    const params = new URLSearchParams({ from: String(this.rangeStart()), to: String(this.rangeEnd()), kind });
    if (!reset && this.momentCursor()) params.set('cursor', this.momentCursor()!);
    try {
      const response = await firstValueFrom(this.api.getTimelineMoments(this.channelID(), session, params));
      if (session !== this.selectedID()) return;
      if (response.error || !response.data) throw new Error('moments');
      this.momentCursor.set(response.data.cursor);
      const extra = response.data.events;
      this.timeline.update(data => data ? { ...data, events: [...new Map([...data.events, ...extra].map(event => [event.id, event])).values()].sort((a, b) => a.offsetSeconds - b.offsetSeconds).slice(-1000) } : data);
    } catch { if (session === this.selectedID()) this.momentsError.set(true); }
    finally { this.momentsLoading.set(false); }
  }
  async compare(id: string): Promise<void> {
    const seq = ++this.detailSequence;
    this.compareID.set(id); this.comparison.set(null); this.detailError.set(false);
    if (!id) { this.detailLoading.set(false); return; }
    this.detailLoading.set(true);
    try {
      const response = await firstValueFrom(this.api.getTimelineComparison(this.channelID(), this.selectedID(), id));
      if (seq !== this.detailSequence) return;
      if (response.error || !response.data) throw new Error('compare');
      this.comparison.set(response.data);
    } catch { if (seq === this.detailSequence) this.detailError.set(true); }
    finally { if (seq === this.detailSequence) this.detailLoading.set(false); }
  }
  comparisonDate(): string { const other = this.comparison(); return other ? this.date(other.session.startedAt) : ''; }
  isPeopleOpen(kind: string, row: TimelineRank): boolean { return this.peopleKind() === kind && this.peopleKey() === row.key && (!!this.people() || this.detailLoading()); }
  togglePeople(kind: string, row: TimelineRank): void {
    if (this.isPeopleOpen(kind, row) && this.people()) { this.people.set(null); this.peopleKey.set(''); return; }
    void this.loadPeople(kind, row);
  }
  async loadPeople(kind: string, row: TimelineRank, more = false): Promise<void> {
    const seq = ++this.detailSequence;
    this.peopleKind.set(kind); this.peopleKey.set(row.key); this.peopleLabel.set(row.label);
    if (!more) this.people.set(null);
    this.detailLoading.set(true); this.detailError.set(false);
    try {
      const response = await firstValueFrom(this.api.getTimelinePeople(this.channelID(), this.selectedID(), kind, row.key, more ? this.people()?.cursor || '' : ''));
      if (seq !== this.detailSequence) return;
      if (response.error || !response.data) throw new Error('people');
      this.people.set({ ...response.data, items: more ? [...(this.people()?.items || []), ...response.data.items].slice(-200) : response.data.items });
    } catch { if (seq === this.detailSequence) this.detailError.set(true); }
    finally { if (seq === this.detailSequence) this.detailLoading.set(false); }
  }
  onCreditsToggle(event: Event): void { if ((event.target as HTMLDetailsElement).open && !this.credits()) void this.loadCredits(); }
  async loadCredits(): Promise<void> {
    const seq = ++this.detailSequence;
    this.detailLoading.set(true); this.detailError.set(false);
    try {
      const response = await firstValueFrom(this.api.getTimelineCredits(this.channelID(), this.selectedID()));
      if (seq !== this.detailSequence) return;
      if (response.error || !response.data) throw new Error('credits');
      this.credits.set(response.data);
    } catch { if (seq === this.detailSequence) this.detailError.set(true); }
    finally { if (seq === this.detailSequence) this.detailLoading.set(false); }
  }
  openMarker(event: TimelineEvent | null = null, at = this.selectedOffset()): void {
    this.deleting.set(event); this.markerLabel.set(''); this.markerMinutes.set((Math.floor(at / 6) / 10).toFixed(1));
    this.markerKey = crypto.randomUUID(); this.submitted.set(false); this.markerError.set(false); this.dialog()?.nativeElement.showModal();
  }
  onMarkerCancel(event: Event): void { if (this.saving()) event.preventDefault(); }
  closeMarker(): void { if (!this.saving()) this.dialog()?.nativeElement.close(); }
  async saveMarker(): Promise<void> {
    this.submitted.set(true);
    if (this.saving() || (!this.deleting() && !this.markerValid())) return;
    this.saving.set(true); this.markerError.set(false);
    try {
      const channel = this.channelID(), session = this.selectedID(), deleting = this.deleting();
      const response = await firstValueFrom(deleting ? this.api.deleteTimelineMarker(channel, session, deleting.id) : this.api.saveTimelineMarker(channel, session, this.markerKey, { label: this.markerLabel().trim(), offsetSeconds: Number(this.markerMinutes()) * 60 }));
      if (response.error) throw new Error('marker');
      this.dialog()?.nativeElement.close(); await this.loadTimeline(session);
    } catch { this.markerError.set(true); }
    finally { this.saving.set(false); }
  }
}
