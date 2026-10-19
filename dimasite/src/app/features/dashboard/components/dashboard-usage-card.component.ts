import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../../../services/language.service';
import { LinksService } from '../../../services/links.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';

interface UsageItem { key: string; label: string; count: number; }
interface UsageSummary { days: number; commands: UsageItem[]; emotes: UsageItem[]; commandRuns: number; emoteUses: number; coverageStartedAt: string | null; pending: boolean; }
interface UsageResponse { summary: UsageSummary | null; updatedAt: string | null; pending: boolean; stale: boolean; }

@Component({
  selector: 'app-dashboard-usage-card', imports: [LfIconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-usage-card.component.html', styleUrl: './dashboard-usage-card.component.css'
})
export class DashboardUsageCardComponent {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly language = inject(LanguageService);
  private readonly destroyRef = inject(DestroyRef);
  readonly channelID = input.required<string>();
  readonly kind = input.required<'commands' | 'emotes'>();
  readonly days = signal(7);
  readonly data = signal<UsageResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly items = computed(() => this.data()?.summary?.[this.kind()] || []);
  readonly total = computed(() => this.kind() === 'commands' ? this.data()?.summary?.commandRuns || 0 : this.data()?.summary?.emoteUses || 0);
  readonly pending = computed(() => this.data()?.pending || this.data()?.summary?.pending || false);
  readonly failedImages = signal(new Set<string>());
  private sequence = 0;
  private poll?: ReturnType<typeof setTimeout>;
  constructor() {
    effect(() => { const channel = this.channelID(), days = this.days(); this.data.set(null); void this.load(channel, days); });
    this.destroyRef.onDestroy(() => { this.sequence++; clearTimeout(this.poll); });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(`dashboardUsage.${key}`, params); }
  number(value: number): string { return new Intl.NumberFormat(this.language.currentLanguage()).format(value); }
  date(value: string): string { return new Intl.DateTimeFormat(this.language.currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  image(item: UsageItem): string | null {
    const match = /^twitch:([a-zA-Z0-9_-]{1,64})$/.exec(item.key);
    return match && !this.failedImages().has(item.key) ? `https://static-cdn.jtvnw.net/emoticons/v2/${match[1]}/default/dark/2.0` : null;
  }
  imageFailed(key: string): void { this.failedImages.update(previous => new Set([...previous, key])); }
  async load(channelID = this.channelID(), days = this.days()): Promise<void> {
    const sequence = ++this.sequence;
    clearTimeout(this.poll); this.loading.set(true); this.error.set(false);
    try {
      const response = await firstValueFrom(this.http.get<{ error: boolean; data: UsageResponse }>(`${this.links.getApiUrl()}/dashboard/${channelID}/activity?days=${days}`));
      if (sequence !== this.sequence) return;
      if (response.error || !response.data) throw new Error('activity');
      this.data.set(response.data);
      if (response.data.pending || response.data.summary?.pending) this.poll = setTimeout(() => { void this.load(); }, 10000);
    } catch { if (sequence === this.sequence) this.error.set(true); }
    finally { if (sequence === this.sequence) this.loading.set(false); }
  }
}
