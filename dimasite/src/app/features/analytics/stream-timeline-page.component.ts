import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, distinctUntilChanged, map, switchMap } from 'rxjs';
import { AnalyticsApiService } from '../../services/analytics-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { StreamTimeline, TimelineEvent, TimelineStream, TimelinePeople, TimelineCredits, TimelineRank } from '../../models/stream-timeline.model';

@Component({
  selector: 'app-stream-timeline-page', imports: [RouterLink, LfIconComponent],
  templateUrl: './stream-timeline-page.component.html', styleUrl: './stream-timeline-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StreamTimelinePageComponent {
  private readonly api = inject(AnalyticsApiService);
  private readonly auth = inject(SessionAuthService);
  private readonly language = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('markerDialog');
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
  readonly filter = signal('all');
  readonly saving = signal(false);
  readonly markerError = signal(false);
  readonly markerLabel = signal('');
  readonly markerMinutes = signal('0');
  readonly deleting = signal<TimelineEvent | null>(null);
  readonly submitted = signal(false);
  readonly eventKinds = ['all', 'game', 'title', 'raid', 'redemption', 'follow', 'sub', 'gift', 'bits', 'note'];
  readonly rangeStart = signal(0);
  readonly rangeEnd = signal(0);
  readonly rangeError = signal(false);
  readonly search = signal('');
  readonly momentKinds = signal<string[]>([]);
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
  private detailSequence = 0;
  private page = 1;
  private sequence = 0;
  private listSequence = 0;
  private markerKey = '';
  readonly backLink = computed(() => ['/', this.streamer(), 'modules', 'analytics']);
  readonly allVisibleEvents = computed(() => this.timeline()?.events.filter(e =>
    e.offsetSeconds >= this.rangeStart() && e.offsetSeconds <= this.rangeEnd()
    && (this.filter() === 'all' || e.kind === this.filter())
    && (!this.momentKinds().length || this.momentKinds().includes(e.kind))
    && (!this.search().trim() || e.label.toLocaleLowerCase().includes(this.search().trim().toLocaleLowerCase()))) || []);
  readonly events = computed(() => this.allVisibleEvents().slice(-200));
  readonly visiblePoints = computed(() => this.timeline()?.points.filter(p => p.offsetSeconds >= this.rangeStart() && p.offsetSeconds <= this.rangeEnd()) || []);
  readonly comparisonPeak = computed(() => Math.max(0, ...this.comparison()?.points.map(p => p.viewers) || []));
  readonly inspectionOffsets = computed(() => {
    const data = this.timeline();
    return data ? [...new Set([...data.points.map(p => p.offsetSeconds), ...data.chatters.filter(p => p.count !== null).map(p => p.offsetSeconds), ...data.events.map(e => e.offsetSeconds)])].filter(at => at >= this.rangeStart() && at <= this.rangeEnd()).sort((a, b) => a - b) : [];
  });
  readonly selectedPoint = computed(() => {
    const points = this.timeline()?.points || [];
    return points.reduce<(typeof points)[number] | null>((best, point) => !best || Math.abs(point.offsetSeconds - this.selectedOffset()) < Math.abs(best.offsetSeconds - this.selectedOffset()) ? point : best, null);
  });
  readonly selectedChatters = computed(() => this.timeline()?.chatters.find(p => p.offsetSeconds <= this.selectedOffset() && p.offsetSeconds + 300 > this.selectedOffset())?.count ?? null);
  readonly charts = computed(() => {
    const data = this.timeline();
    if (!data) return [];
    const series = [
      { key: 'viewers', values: data.points.map(p => ({ x: p.offsetSeconds, y: p.viewers, gap: p.gap })) },
      { key: 'messages', values: data.points.map(p => ({ x: p.offsetSeconds, y: p.messagesPerMinute, gap: p.gap })) },
      { key: 'chatters', values: data.chatters.map(p => ({ x: p.offsetSeconds, y: p.count, gap: false })) }
    ];
    if (data.activity?.capabilities.trends) {
      series.push({ key: 'commands', values: data.points.map(p => ({ x: p.offsetSeconds, y: p.commandsPerMinute ?? null, gap: p.gap })) });
      series.push({ key: 'emotes', values: data.activity.series.map(p => ({ x: p.offsetSeconds, y: p.emotes ?? null, gap: false })) });
    }
    return series.map(s => {
      const values = s.values.filter(p => p.x >= this.rangeStart() && p.x <= this.rangeEnd());
      const other = this.comparison();
      const comparisonValues = !other ? [] : s.key === 'chatters' ? other.chatters.map(p => ({ x: p.offsetSeconds, y: p.count, gap: false }))
        : s.key === 'emotes' ? (other.activity?.series || []).map(p => ({ x: p.offsetSeconds, y: p.emotes ?? null, gap: false }))
        : other.points.map(p => ({ x: p.offsetSeconds, y: s.key === 'viewers' ? p.viewers : s.key === 'messages' ? p.messagesPerMinute : p.commandsPerMinute ?? null, gap: p.gap }));
      const compared = comparisonValues.filter(p => p.x >= this.rangeStart() && p.x <= this.rangeEnd());
      const max = Math.max(1, ...values.map(p => p.y ?? 0), ...compared.map(p => p.y ?? 0));
      let path = '', connected = false;
      const dots: { x: number; y: number }[] = [];
      for (const p of values) {
        if (p.y === null) { connected = false; continue; }
        const x = this.x(p.x), y = 115 - p.y / max * 100;
        path += `${connected && !p.gap ? 'L' : 'M'}${x},${y} `;
        dots.push({ x, y }); connected = true;
      }
      let comparePath = '', compareConnected = false;
      for (const p of compared) {
        if (p.y === null) { compareConnected = false; continue; }
        comparePath += `${compareConnected && !p.gap ? 'L' : 'M'}${this.x(p.x)},${115 - p.y / max * 100} `;
        compareConnected = true;
      }
      return { key: s.key, max, path, comparePath, dots, available: dots.length > 0 };
    });
  });
  readonly markerValid = computed(() => {
    const minutes = Number(this.markerMinutes());
    return this.markerLabel().trim().length > 0 && this.markerLabel().trim().length <= 120 && this.markerMinutes().trim() !== '' && Number.isFinite(minutes) && minutes >= 0 && minutes * 60 <= (this.timeline()?.session.durationSeconds || 0);
  });

  constructor() {
    this.destroyRef.onDestroy(() => { this.sequence++; this.listSequence++; });
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
  time(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 3600).toString().padStart(2, '0')}:${Math.floor(total / 60 % 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
  }
  date(value: string): string { return new Intl.DateTimeFormat(this.language.currentLanguage() === 'es' ? 'es-ES' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  x(seconds: number): number { return (seconds - this.rangeStart()) / Math.max(1, this.rangeEnd() - this.rangeStart()) * 1000; }
  chartSelect(event: MouseEvent): void {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const offset = this.rangeStart() + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (this.rangeEnd() - this.rangeStart());
    this.selectedOffset.set(this.inspectionOffsets().reduce((best, at) => Math.abs(at - offset) < Math.abs(best - offset) ? at : best, this.inspectionOffsets()[0] ?? offset));
  }
  selectStream(event: Event): void { void this.loadTimeline((event.target as HTMLSelectElement).value); }
  selectPoint(event: Event): void { this.selectedOffset.set(Number((event.target as HTMLSelectElement).value)); }
  async loadStreams(more = false): Promise<void> {
    const sequence = ++this.listSequence, page = more ? this.page + 1 : 1;
    this.listLoading.set(true); this.listError.set(false);
    try {
      const response = await firstValueFrom(this.api.getTimelineStreams(this.channelID(), page));
      if (sequence !== this.listSequence) return;
      if (response.error || !response.data) throw new Error('list');
      this.page = page; this.streams.set(more ? [...this.streams(), ...response.data.streams] : response.data.streams); this.hasMore.set(response.data.hasMore);
      if (!more) {
        const requested = this.route.snapshot.queryParamMap.get('stream');
        const id = requested && /^[a-f0-9]{24}$/i.test(requested) ? requested : this.streams()[0]?.id;
        if (id) await this.loadTimeline(id); else this.loading.set(false);
      }
    } catch { if (sequence === this.listSequence) { this.listError.set(true); this.loading.set(false); } }
    finally { if (sequence === this.listSequence) this.listLoading.set(false); }
  }
  async loadTimeline(id = this.selectedID()): Promise<void> {
    const sequence = ++this.sequence;
    this.detailSequence++; this.comparison.set(null); this.compareID.set(''); this.people.set(null); this.credits.set(null);
    this.detailLoading.set(false); this.detailError.set(false); this.momentKinds.set([]);
    this.selectedID.set(id); this.loading.set(true); this.error.set(false); this.timeline.set(null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { stream: id }, queryParamsHandling: 'merge', replaceUrl: true });
    try {
      const response = await firstValueFrom(this.api.getStreamTimeline(this.channelID(), id));
      if (sequence !== this.sequence) return;
      if (response.error || !response.data) throw new Error('timeline');
      this.timeline.set(response.data);
      const query = this.route.snapshot.queryParamMap;
      const start = Number(query.get('from') || 0), end = Number(query.get('to') || response.data.session.durationSeconds);
      this.rangeStart.set(Number.isFinite(start) && start >= 0 && start < response.data.session.durationSeconds ? start : 0);
      this.rangeEnd.set(Number.isFinite(end) && end > this.rangeStart() ? Math.min(end, response.data.session.durationSeconds) : response.data.session.durationSeconds);
      this.momentCursor.set(response.data.markerPage?.cursor || null);
      this.selectedOffset.set(this.inspectionOffsets()[0] || 0);
      if (!this.streams().some(s => s.id === id)) this.streams.update(rows => [response.data!.session, ...rows]);
    } catch { if (sequence === this.sequence) this.error.set(true); }
    finally { if (sequence === this.sequence) this.loading.set(false); }
  }
  applyRange(fromMinutes: string, toMinutes: string): void {
    const from = Number(fromMinutes) * 60, to = Number(toMinutes) * 60;
    this.rangeError.set(!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > (this.timeline()?.session.durationSeconds || 0));
    if (this.rangeError()) return;
    this.rangeStart.set(from); this.rangeEnd.set(to); this.selectedOffset.set(this.inspectionOffsets()[0] || from);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { from, to }, queryParamsHandling: 'merge', replaceUrl: true });
  }
  zoom(seconds: number): void {
    const duration = this.timeline()?.session.durationSeconds || 0;
    const start = seconds ? Math.max(0, Math.min(this.selectedOffset() - seconds / 2, duration - seconds)) : 0;
    this.applyRange(String(start / 60), String(Math.min(duration, seconds ? start + seconds : duration) / 60));
  }
  toggleMoment(kind: string): void {
    this.filter.set('all');
    this.momentKinds.update(kinds => kinds.includes(kind) ? kinds.filter(item => item !== kind) : [...kinds, kind]);
  }
  async loadMoments(reset = false): Promise<void> {
    if (this.momentsLoading()) return;
    const session = this.selectedID();
    this.momentsLoading.set(true); this.momentsError.set(false);
    const params = new URLSearchParams({ from: String(this.rangeStart()), to: String(this.rangeEnd()), kind: ['game', 'title'].includes(this.filter()) ? 'all' : this.filter() });
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
    if (!id) return;
    this.detailLoading.set(true);
    try {
      const response = await firstValueFrom(this.api.getTimelineComparison(this.channelID(), this.selectedID(), id));
      if (seq !== this.detailSequence) return;
      if (response.error || !response.data) throw new Error('compare');
      this.comparison.set(response.data);
    } catch { if (seq === this.detailSequence) this.detailError.set(true); }
    finally { if (seq === this.detailSequence) this.detailLoading.set(false); }
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
  openMarker(event: TimelineEvent | null = null): void {
    this.deleting.set(event); this.markerLabel.set(''); this.markerMinutes.set((Math.floor(this.selectedOffset() / 6) / 10).toFixed(1));
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
