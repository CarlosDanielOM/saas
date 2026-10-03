import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { MockTrendChartComponent, TrendPoint } from './mock-trend-chart.component';
import {
  MOCK_CHANNEL,
  MOCK_STREAMS,
  MockStream,
  creditsForecast,
  fmt,
  goalsProgress,
  hoursLabel,
  shortDate,
  streamsSummary,
  weekday,
  MOCK_GOALS
} from './dashboard-mock-data';

type Metric = 'viewers' | 'follows' | 'bits' | 'hours';
type Range = 7 | 15 | 30;

/**
 * Dashboard proposal A: the current bento, tightened. One bot control, plain
 * answers ("last stream was 12% above your average"), no "coming soon" tiles,
 * one metric per chart, and goals/credits that say what happens next.
 */
@Component({
  selector: 'app-dashboard-refresh-mock',
  imports: [RouterLink, LfIconComponent, MockTrendChartComponent],
  templateUrl: './dashboard-refresh-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './dashboard-refresh-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardRefreshMockComponent {
  private readonly language = inject(LanguageService);

  readonly channel = MOCK_CHANNEL;
  readonly live = signal(false);
  readonly botOn = signal(true);
  readonly metric = signal<Metric>('viewers');
  readonly range = signal<Range>(30);
  readonly metrics: Metric[] = ['viewers', 'follows', 'bits', 'hours'];
  readonly ranges: Range[] = [7, 15, 30];

  readonly lang = computed(() => this.language.currentLanguage());
  readonly s = streamsSummary();
  readonly credits = creditsForecast();
  readonly goals = goalsProgress();
  readonly goalTargets = MOCK_GOALS;
  readonly last = MOCK_STREAMS[0];
  readonly liveViewers = 58;
  readonly liveVsAvg = Math.round(((this.liveViewers - this.s.avgViewers) / this.s.avgViewers) * 100);
  readonly followsToGo = MOCK_GOALS.followersGoal - goalsProgress().follows;
  readonly streamsToGoal = Math.ceil(this.followsToGo / this.s.followsPerStream);
  readonly lastVsAvg = Math.round(((MOCK_STREAMS[0].avgViewers - this.s.avgViewers) / this.s.avgViewers) * 100);

  readonly shownStreams = computed(() => {
    const days = this.range();
    const cutoff = new Date('2026-10-03T12:00:00Z').getTime() - days * 86400000;
    return MOCK_STREAMS.filter((x) => new Date(x.date + 'T12:00:00Z').getTime() >= cutoff);
  });

  readonly chartData = computed<TrendPoint[]>(() =>
    this.shownStreams()
      .slice()
      .reverse()
      .map((x) => ({ label: shortDate(x.date, this.lang()), value: this.metricValue(x, this.metric()) }))
  );

  readonly chartFormat = computed(() => {
    const m = this.metric();
    const lang = this.lang();
    return (v: number) => (m === 'hours' ? fmt(v, lang, 1) : fmt(v, lang));
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(value: number, digits = 0): string {
    return fmt(value, this.lang(), digits);
  }

  date(iso: string): string {
    return shortDate(iso, this.lang());
  }

  day(iso: string): string {
    return weekday(iso, this.lang());
  }

  hours(h: number): string {
    return hoursLabel(h);
  }

  delta(value: number): string {
    return `${value > 0 ? '+' : ''}${value}%`;
  }

  metricValue(x: MockStream, m: Metric): number {
    if (m === 'viewers') return x.avgViewers;
    if (m === 'follows') return x.follows;
    if (m === 'bits') return x.bits;
    return x.hours;
  }

  isBest(x: MockStream): boolean {
    return x.date === this.s.best.date;
  }

  path(...parts: string[]): string[] {
    return ['/mocks/dev', ...parts];
  }
}
