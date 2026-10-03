import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { MockTrendChartComponent, TrendPoint } from './mock-trend-chart.component';
import {
  MOCK_CHANNEL,
  MOCK_EVENTS,
  MOCK_GOALS,
  MOCK_STREAMS,
  creditsForecast,
  fmt,
  goalsProgress,
  hoursLabel,
  shortDate,
  streamsSummary
} from './dashboard-mock-data';

type CheckKey = 'bot' | 'alerts' | 'tts' | 'credits' | 'defense';

/** Viewer count every 6 minutes of the current (mock) stream. */
const LIVE_VIEWERS = [12, 19, 26, 31, 34, 33, 38, 41, 44, 47, 52, 49, 58];

/**
 * Dashboard proposal B: organised around the streamer's day instead of a grid
 * of numbers. Offline: "am I ready to go live?" + what happened last time +
 * what needs me. Live: one control room with the event feed and the switches.
 */
@Component({
  selector: 'app-dashboard-studio-mock',
  imports: [RouterLink, LfIconComponent, MockTrendChartComponent],
  templateUrl: './dashboard-studio-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './dashboard-studio-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardStudioMockComponent {
  private readonly language = inject(LanguageService);

  readonly channel = MOCK_CHANNEL;
  readonly live = signal(false);
  readonly botOn = signal(true);
  readonly ttsPaused = signal(false);
  readonly alertsPaused = signal(false);
  readonly ttsLinkCopied = signal(false);
  readonly handled = signal<ReadonlySet<number>>(new Set());

  readonly lang = computed(() => this.language.currentLanguage());
  readonly s = streamsSummary();
  readonly credits = creditsForecast();
  readonly goals = goalsProgress();
  readonly goalTargets = MOCK_GOALS;
  readonly last = MOCK_STREAMS[0];
  readonly events = MOCK_EVENTS;

  readonly checks = computed(() => {
    const items: Array<{ key: CheckKey; ok: boolean }> = [
      { key: 'bot', ok: this.botOn() },
      { key: 'alerts', ok: true },
      { key: 'tts', ok: this.ttsLinkCopied() },
      { key: 'credits', ok: this.credits.lastsUntilReset },
      { key: 'defense', ok: true }
    ];
    return items;
  });
  readonly readyCount = computed(() => this.checks().filter((c) => c.ok).length);

  readonly viewerTrend = computed<TrendPoint[]>(() =>
    MOCK_STREAMS.slice()
      .reverse()
      .map((x) => ({ label: shortDate(x.date, this.lang()), value: x.avgViewers }))
  );

  readonly liveTrend = computed<TrendPoint[]>(() =>
    LIVE_VIEWERS.map((v, i) => ({ label: this.t('devMocks.dashB.minIn', { min: i * 6 }), value: v }))
  );

  readonly liveNow = LIVE_VIEWERS[LIVE_VIEWERS.length - 1];
  readonly lastVsAvg = {
    viewers: this.pct(MOCK_STREAMS[0].avgViewers, this.s.avgViewers),
    follows: this.pct(MOCK_STREAMS[0].follows, this.s.followsPerStream),
    bits: this.pct(MOCK_STREAMS[0].bits, this.s.bitsPerStream)
  };

  readonly intFormat = (v: number) => fmt(v, this.lang());

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(value: number, digits = 0): string {
    return fmt(value, this.lang(), digits);
  }

  date(iso: string): string {
    return shortDate(iso, this.lang());
  }

  hours(h: number): string {
    return hoursLabel(h);
  }

  delta(value: number): string {
    return `${value > 0 ? '+' : ''}${value}%`;
  }

  handle(index: number): void {
    this.handled.update((set) => new Set(set).add(index));
  }

  isHandled(index: number): boolean {
    return this.handled().has(index);
  }

  eventAction(kind: string): string | null {
    if (kind === 'raid') return 'shoutout';
    if (kind === 'sub' || kind === 'bits') return 'thank';
    if (kind === 'redeem') return 'done';
    return null;
  }

  path(...parts: string[]): string[] {
    return ['/mocks/dev', ...parts];
  }

  private pct(now: number, avg: number): number {
    return Math.round(((now - avg) / avg) * 100);
  }
}
