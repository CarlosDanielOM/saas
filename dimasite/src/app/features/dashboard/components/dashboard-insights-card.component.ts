import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../../../services/language.service';
import { LinksService } from '../../../services/links.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
interface Day { weekday: number; streams: number; hours: number; follows: number; followsPerStream: number | null; followsPerHour: number | null; averageViewers: number | null; coverage: number | null; eligible: boolean; }
interface Game { game: string; streams: number; hours: number; viewerHours: number; averageViewers: number; follows: number | null; followsPerHour: number | null; eligible: boolean; }
interface InsightSummary { days: number; timeZone: string; streams: number; excludedStreams: number; weekdays: Day[]; games: Game[]; gameCount: number; bestDay: number | null; bestGrowthGame: string | null; limited: boolean; sampledHours: number; hours: number; }
interface InsightResponse { summary: InsightSummary | null; pending: boolean; stale: boolean; updatedAt: string | null; }
@Component({
  selector: 'app-dashboard-insights-card', imports: [LfIconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-insights-card.component.html', styleUrl: './dashboard-insights-card.component.css'
})
export class DashboardInsightsCardComponent {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly language = inject(LanguageService);
  private readonly destroy = inject(DestroyRef);
  readonly channelID = input.required<string>();
  readonly kind = input.required<'days' | 'games'>();
  readonly days = signal(30);
  readonly excludeRaids = signal(true);
  readonly data = signal<InsightResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly maxDay = computed(() => Math.max(1, ...(this.data()?.summary?.weekdays.map(day => day.followsPerStream || 0) || [])));
  private sequence = 0;
  private poll?: ReturnType<typeof setTimeout>;
  constructor() {
    effect(() => { const channel = this.channelID(), days = this.days(), exclude = this.excludeRaids(); this.data.set(null); void this.load(channel, days, exclude); });
    this.destroy.onDestroy(() => { this.sequence++; clearTimeout(this.poll); });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(`dashboardInsights.${key}`, params); }
  number(value: number | null): string { return value === null ? '—' : new Intl.NumberFormat(this.language.currentLanguage(), { maximumFractionDigits: 1 }).format(value); }
  weekday(value: number, long = false): string { return new Intl.DateTimeFormat(this.language.currentLanguage(), { weekday: long ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + value))); }
  date(value: string): string { return new Intl.DateTimeFormat(this.language.currentLanguage(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)); }
  async load(channelID = this.channelID(), days = this.days(), exclude = this.excludeRaids()): Promise<void> {
    const sequence = ++this.sequence; clearTimeout(this.poll); this.loading.set(true); this.error.set(false);
    try {
      const response = await firstValueFrom(this.http.get<{ error: boolean; data: InsightResponse }>(`${this.links.getApiUrl()}/dashboard/${channelID}/insights?days=${days}&raids=${exclude ? 'exclude' : 'include'}`));
      if (sequence !== this.sequence) return;
      if (response.error || !response.data) throw new Error('insights');
      this.data.set(response.data);
      if (response.data.pending) this.poll = setTimeout(() => { void this.load(); }, 10000);
    } catch { if (sequence === this.sequence) this.error.set(true); }
    finally { if (sequence === this.sequence) this.loading.set(false); }
  }
}
