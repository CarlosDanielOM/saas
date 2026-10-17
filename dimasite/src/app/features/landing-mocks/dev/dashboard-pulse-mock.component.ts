import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockCreditsComponent, GrowthMockHeaderComponent } from './growth-mock-header.component';
import {
  DAILY_FOLLOWERS,
  LAST_30,
  PREV_30,
  GAME_LABELS,
  GROWTH_CHANNEL,
  GROWTH_STREAMS,
  GrowthStream,
  PeriodSummary,
  addDays,
  compact,
  fmt,
  followerEta,
  hoursLabel,
  monthGoal,
  pctChange,
  shortDate,
  streamsInWindow,
  summarize,
  weekdayName
} from './growth-mock-data';

type Metric = 'followers' | 'viewers' | 'subs' | 'bits' | 'hours';
type Range = 7 | 30 | 90;

interface Point {
  date: string;
  value: number;
  stream?: GrowthStream;
  x: number;
  y: number;
}

const W = 640;
const H = 220;

/**
 * Dashboard proposal "Pulse": one question, one big number. Pick what you care
 * about (followers, viewers, subs, bits, hours), drag across the chart to read
 * any day, tap a stream to see how it went. Built like a finance app on phones.
 */
@Component({
  selector: 'app-dashboard-pulse-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, GrowthMockCreditsComponent],
  templateUrl: './dashboard-pulse-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './dashboard-pulse-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardPulseMockComponent {
  private readonly language = inject(LanguageService);

  readonly W = W;
  readonly H = H;
  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly metric = signal<Metric>('followers');
  readonly range = signal<Range>(30);
  readonly scrub = signal<number | null>(null);
  readonly selectedDate = signal(GROWTH_STREAMS[GROWTH_STREAMS.length - 1].date);

  readonly metrics: Metric[] = ['followers', 'viewers', 'subs', 'bits', 'hours'];
  readonly ranges: Range[] = [7, 30, 90];
  readonly lang = computed(() => this.language.currentLanguage());

  readonly now = computed(() => summarize(streamsInWindow(this.range())));
  readonly before = computed(() => summarize(streamsInWindow(this.range() * 2, this.range())));
  readonly followersGained = computed(() => this.gained(this.range(), 0));
  readonly followersBefore = computed(() => this.gained(this.range() * 2, this.range()));

  /** Headline figures per metric for the current range, with an honest comparison. */
  readonly cards = computed(() =>
    this.metrics.map((m) => {
      // Followers show the total today and compare follows gained; the rest compare the range.
      const value = m === 'followers' ? GROWTH_CHANNEL.followers : this.headline(m, this.now());
      const delta =
        m === 'followers'
          ? pctChange(this.followersGained(), this.followersBefore())
          : pctChange(value, this.headline(m, this.before()));
      return { metric: m, value, delta, spark: this.sparkPath(m) };
    })
  );

  readonly card = computed(() => this.cards().find((c) => c.metric === this.metric())!);

  readonly points = computed<Point[]>(() => {
    const m = this.metric();
    const range = this.range();
    const raw =
      m === 'followers'
        ? DAILY_FOLLOWERS.slice(-range).map((d) => ({ date: d.date, value: d.total, stream: d.stream }))
        : streamsInWindow(range).map((s) => ({ date: s.date, value: this.streamValue(s, m), stream: s }));
    if (!raw.length) return [];
    const values = raw.map((p) => p.value);
    const lo = m === 'followers' ? Math.min(...values) : 0;
    const hi = Math.max(...values);
    const pad = m === 'followers' ? (hi - lo) * 0.12 || 1 : hi * 0.12;
    const n = Math.max(1, raw.length - 1);
    return raw.map((p, i) => ({
      ...p,
      x: raw.length === 1 ? W / 2 : (i / n) * W,
      y: H - ((p.value - lo) / (hi + pad - lo || 1)) * H
    }));
  });

  readonly linePath = computed(() => this.smooth(this.points()));
  readonly areaPath = computed(() => {
    const pts = this.points();
    return pts.length ? `${this.linePath()} L${pts[pts.length - 1].x},${H} L${pts[0].x},${H} Z` : '';
  });

  readonly streamDots = computed(() => this.points().filter((p) => p.stream));

  readonly active = computed(() => {
    const i = this.scrub();
    return i === null ? null : (this.points()[i] ?? null);
  });

  readonly ticks = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return [];
    const every = Math.max(1, Math.round(pts.length / 4));
    return pts.filter((_, i) => i % every === 0 && i < pts.length - every / 2);
  });

  readonly selected = computed(() => GROWTH_STREAMS.find((s) => s.date === this.selectedDate()) ?? GROWTH_STREAMS[GROWTH_STREAMS.length - 1]);
  readonly avg30 = computed(() => summarize(streamsInWindow(30)));
  readonly selectedVs = computed(() => {
    const s = this.selected();
    const a = this.avg30();
    const per = (v: number) => v / Math.max(1, a.streams);
    return {
      viewers: pctChange(s.avgViewers, a.avgViewers),
      follows: pctChange(s.follows, per(a.follows)),
      bits: pctChange(s.bits, per(a.bits))
    };
  });

  readonly top = computed(() => {
    const m = this.metric() === 'followers' ? 'follows' : this.metric();
    return streamsInWindow(this.range())
      .slice()
      .sort((a, b) => this.streamValue(b, m) - this.streamValue(a, m))
      .slice(0, 3)
      .map((s) => ({ stream: s, value: this.streamValue(s, m) }));
  });

  readonly history = computed(() => streamsInWindow(this.range()).slice().reverse());

  readonly goals = [
    { key: 'follows', ...monthGoal('follows', 240) },
    { key: 'subs', ...monthGoal('subs', 30) }
  ];
  readonly followersNow = GROWTH_CHANNEL.followers;
  readonly nextMilestone = 4250;
  readonly milestoneEta = followerEta(4250);
  readonly lastDate = GROWTH_STREAMS[GROWTH_STREAMS.length - 1].date;
  /** The header answer always speaks about the last 30 days. */
  readonly answer = {
    follows: DAILY_FOLLOWERS.slice(-30).reduce((a, d) => a + d.gained, 0),
    viewers: pctChange(LAST_30.avgViewers, PREV_30.avgViewers)
  };

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(v: number, digits = 0): string {
    return fmt(v, this.lang(), digits);
  }

  c(v: number): string {
    return compact(v, this.lang());
  }

  date(iso: string): string {
    return shortDate(iso, this.lang());
  }

  day(weekday: number): string {
    return weekdayName(weekday, this.lang());
  }

  game(s: GrowthStream): string {
    return GAME_LABELS[s.game];
  }

  hours(h: number): string {
    return hoursLabel(h);
  }

  pct(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
  }

  /** Value shown big for a metric (followers = total now, others = the range). */
  display(metric: Metric, value: number): string {
    return metric === 'hours' ? hoursLabel(value) : this.n(Math.round(value));
  }

  addDaysIso(days: number): string {
    return addDays(days);
  }

  pointValue(p: Point): string {
    const m = this.metric();
    if (m === 'hours') return hoursLabel(p.value);
    return this.n(p.value);
  }

  metricLabel(m: Metric): string {
    return this.t('devMocks.growth.pulse.metric.' + m);
  }

  sentence = computed(() => {
    const m = this.metric();
    const card = this.card();
    const range = this.range();
    const better = card.delta >= 0;
    const params = { range, pct: Math.abs(card.delta), gained: this.n(this.followersGained()), value: this.display(m, card.value) };
    return this.t(`devMocks.growth.pulse.say.${m}.${better ? 'up' : 'down'}`, params);
  });

  selectMetric(m: Metric): void {
    this.metric.set(m);
    this.scrub.set(null);
  }

  selectRange(r: Range): void {
    this.range.set(r);
    this.scrub.set(null);
  }

  onMove(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const n = this.points().length;
    if (!n || !rect.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    this.scrub.set(Math.round(ratio * (n - 1)));
  }

  onUp(): void {
    const p = this.active();
    if (p?.stream) this.selectedDate.set(p.stream.date);
  }

  onLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse') this.scrub.set(null);
  }

  onKey(event: KeyboardEvent): void {
    const n = this.points().length;
    const cur = this.scrub() ?? n - 1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (event.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else if (event.key === 'Escape') this.scrub.set(null);
    else if (event.key === 'Enter' || event.key === ' ') {
      this.onUp();
      event.preventDefault();
    }
    if (next !== null) {
      this.scrub.set(next);
      event.preventDefault();
    }
  }

  ariaValue = computed(() => {
    const p = this.active() ?? this.points()[this.points().length - 1];
    if (!p) return '';
    return `${this.date(p.date)}: ${this.pointValue(p)} ${this.metricLabel(this.metric())}${p.stream ? ' · ' + this.game(p.stream) : ''}`;
  });

  pick(s: GrowthStream): void {
    this.selectedDate.set(s.date);
  }

  isBest(s: GrowthStream): boolean {
    return this.top()[0]?.stream.date === s.date;
  }

  streamValue(s: GrowthStream, m: Metric | 'follows'): number {
    if (m === 'viewers') return s.avgViewers;
    if (m === 'subs') return s.subs;
    if (m === 'bits') return s.bits;
    if (m === 'hours') return s.hours;
    return s.follows;
  }

  private headline(m: Exclude<Metric, 'followers'>, s: PeriodSummary): number {
    if (m === 'viewers') return s.avgViewers;
    if (m === 'subs') return s.subs;
    if (m === 'bits') return s.bits;
    return s.hours;
  }

  private gained(fromDaysAgo: number, toDaysAgo: number): number {
    const len = DAILY_FOLLOWERS.length;
    return DAILY_FOLLOWERS.slice(Math.max(0, len - fromDaysAgo), len - toDaysAgo).reduce((a, d) => a + d.gained, 0);
  }

  private sparkPath(m: Metric): string {
    const vals =
      m === 'followers'
        ? DAILY_FOLLOWERS.slice(-this.range()).map((d) => d.total)
        : streamsInWindow(this.range()).map((s) => this.streamValue(s, m));
    if (vals.length < 2) return '';
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return vals
      .map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * 100).toFixed(1)},${(28 - ((v - lo) / (hi - lo || 1)) * 26).toFixed(1)}`)
      .join(' ');
  }

  /** Monotone-ish smoothing: cubic segments with horizontal tangents. */
  private smooth(pts: Point[]): string {
    if (!pts.length) return '';
    return pts
      .map((p, i) => {
        if (!i) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        const prev = pts[i - 1];
        const mx = (prev.x + p.x) / 2;
        return `C${mx.toFixed(1)},${prev.y.toFixed(1)} ${mx.toFixed(1)},${p.y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(' ');
  }
}
