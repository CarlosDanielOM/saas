import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockCreditsComponent, GrowthMockHeaderComponent } from './growth-mock-header.component';
import {
  DAILY_FOLLOWERS,
  GAME_LABELS,
  GROWTH_CHANNEL,
  GROWTH_STREAMS,
  GameKey,
  LAST_30,
  PREV_30,
  addDays,
  calendarWeeks,
  compact,
  consistencyStats,
  fmt,
  followerEta,
  gameStats,
  hoursLabel,
  insightStreams,
  lengthBuckets,
  pctChange,
  raidStats,
  shortDate,
  sum,
  weekdayName,
  weekdayStats
} from './growth-mock-data';

type Question = 'best' | 'drop' | 'worst';

/**
 * Dashboard proposal "Coach": answers "what makes my channel grow?" with
 * insights computed from the streamer's own history, each with a tiny chart,
 * the sample it's based on, and one thing to try next.
 */
@Component({
  selector: 'app-dashboard-coach-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, GrowthMockCreditsComponent],
  templateUrl: './dashboard-coach-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './dashboard-coach-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardCoachMockComponent {
  private readonly language = inject(LanguageService);

  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly asked = signal<Question | null>(null);
  readonly thinking = signal(false);
  readonly lang = computed(() => this.language.currentLanguage());
  readonly questions: Question[] = ['best', 'drop', 'worst'];

  readonly sample = insightStreams().length;
  readonly sinceDate = insightStreams()[0].date;

  // Scoreboard
  readonly follows30 = sum(DAILY_FOLLOWERS.slice(-30).map((d) => d.gained));
  readonly followsPrev30 = sum(DAILY_FOLLOWERS.slice(-60, -30).map((d) => d.gained));
  readonly score = [
    { key: 'viewers', value: LAST_30.avgViewers, delta: pctChange(LAST_30.avgViewers, PREV_30.avgViewers), series: GROWTH_STREAMS.slice(-20).map((s) => s.avgViewers) },
    { key: 'follows', value: this.follows30, delta: pctChange(this.follows30, this.followsPrev30), series: DAILY_FOLLOWERS.slice(-30).map((d) => d.total) },
    { key: 'subs', value: LAST_30.subs, delta: pctChange(LAST_30.subs, PREV_30.subs), series: GROWTH_STREAMS.slice(-20).map((s) => s.subs) },
    { key: 'bits', value: LAST_30.bits, delta: pctChange(LAST_30.bits, PREV_30.bits), series: GROWTH_STREAMS.slice(-20).map((s) => s.bits) }
  ].map((s) => ({ ...s, spark: this.spark(s.series) }));

  // 1. Days
  readonly days = weekdayStats();
  readonly daysMax = Math.max(...this.days.map((d) => d.followsPerStream));
  readonly bestDays = this.days.filter((d) => d.streams >= 3).sort((a, b) => b.followsPerStream - a.followsPerStream);
  readonly topDays = this.bestDays.slice(0, 2);
  readonly worstDay = this.bestDays[this.bestDays.length - 1];
  readonly dayRatio = (this.topDays[0].followsPerStream + this.topDays[1].followsPerStream) / 2 / this.worstDay.followsPerStream;

  // 2. Length
  readonly lengths = lengthBuckets();
  readonly lengthMax = Math.max(...this.lengths.map((b) => b.followsPerHour));
  readonly sweet = this.lengths.reduce((a, b) => (b.followsPerHour > a.followsPerHour ? b : a));
  readonly longest = this.lengths[this.lengths.length - 1];

  // 3. Consistency
  readonly weeks = calendarWeeks();
  readonly consistency = consistencyStats();
  readonly viewersMax = Math.max(...GROWTH_STREAMS.map((s) => s.avgViewers));

  // 4. Games
  readonly games = gameStats();
  readonly gamesMax = Math.max(...this.games.map((g) => g.followsPerHour));

  // 5. Raids
  readonly raids = raidStats();
  readonly bestRaid = this.raids.raids.reduce((a, b) => (b.follows > a.follows ? b : a));

  // 6. Forecast
  readonly eta4500 = followerEta(4500)!;
  readonly eta5000 = followerEta(5000)!;
  readonly forecast = this.buildForecast();

  readonly headline = computed(() => ({
    viewers: pctChange(LAST_30.avgViewers, PREV_30.avgViewers),
    follows: pctChange(this.follows30, this.followsPrev30)
  }));

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

  inDays(days: number): string {
    return shortDate(addDays(days), this.lang());
  }

  day(weekday: number, style: 'short' | 'long' = 'short'): string {
    return weekdayName(weekday, this.lang(), style);
  }

  gameName(g: GameKey): string {
    return GAME_LABELS[g];
  }

  hours(h: number): string {
    return hoursLabel(h);
  }

  pct(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
  }

  isTopDay(weekday: number): boolean {
    return this.topDays.some((d) => d.weekday === weekday);
  }

  cellLevel(viewers: number): number {
    return Math.min(4, Math.max(1, Math.ceil((viewers / this.viewersMax) * 4)));
  }

  ask(q: Question): void {
    this.asked.set(q);
    this.thinking.set(true);
    setTimeout(() => this.thinking.set(false), 900);
  }

  /** Answers to the sample questions, built from the same numbers. */
  answer = computed(() => {
    const q = this.asked();
    if (!q) return '';
    if (q === 'best') {
      const r = this.bestRaid;
      const s = GROWTH_STREAMS.find((x) => x.date === r.date)!;
      return this.t('devMocks.growth.coach.ai.bestA', { date: this.date(s.date), raider: r.from, viewers: r.viewers, follows: s.follows, peak: s.peakViewers });
    }
    if (q === 'drop') {
      const quiet = this.weeks.find((w) => w[0].date && w.filter((c) => c.stream).length === 1);
      return this.t('devMocks.growth.coach.ai.dropA', {
        date: quiet ? this.date(quiet[0].date) : '',
        quietAvg: this.n(this.consistency.quietAvg),
        busyAvg: this.n(this.consistency.busyAvg)
      });
    }
    return this.t('devMocks.growth.coach.ai.satA', { worst: this.day(this.worstDay.weekday, 'long'), game: this.gameName(this.games[0].game), rate: this.n(this.games[0].followsPerHour, 1) });
  });

  private spark(values: number[]): string {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(1)},${(22 - ((v - lo) / (hi - lo || 1)) * 20).toFixed(1)}`).join(' ');
  }

  /** Last 60 days of followers + a pace cone to the 5,000 ETA range. */
  private buildForecast() {
    const W = 320;
    const H = 120;
    const hist = DAILY_FOLLOWERS.slice(-60);
    const futureDays = this.eta5000.latest;
    const total = hist.length + futureDays;
    const lo = hist[0].total;
    const hi = 5000 + 80;
    const x = (i: number) => (i / (total - 1)) * W;
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    const line = hist.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.total).toFixed(1)}`).join(' ');
    const start = hist.length - 1;
    const now = GROWTH_CHANNEL.followers;
    const fast = x(start + this.eta5000.soonest);
    const mid = x(start + this.eta5000.days);
    const slow = x(start + this.eta5000.latest);
    const cone = `M${x(start).toFixed(1)},${y(now).toFixed(1)} L${fast.toFixed(1)},${y(5000).toFixed(1)} L${slow.toFixed(1)},${y(5000).toFixed(1)} Z`;
    const pace = `M${x(start).toFixed(1)},${y(now).toFixed(1)} L${mid.toFixed(1)},${y(5000).toFixed(1)}`;
    return { W, H, line, cone, pace, goalY: y(5000), nowX: x(start), midX: mid };
  }
}
