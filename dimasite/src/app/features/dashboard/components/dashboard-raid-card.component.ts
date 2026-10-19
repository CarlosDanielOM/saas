import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import { LanguageService } from '../../../services/language.service';
import { LinksService } from '../../../services/links.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';

type Direction = 'incoming' | 'outgoing';
interface RaidRow { peerID: string; peerName: string; peerLogin: string; viewers: number; occurredAt: string; followsAfter: number | null; lastOutgoingAt?: string | null; }
interface RaidTotal { _id: Direction; raids: number; viewers: number; biggest: number; followsAfter: number; evaluatedRaids: number; }
interface RaidPartner { _id: string; name: string; login: string; count: number; viewers: number; lastAt: string; lastOutgoingAt?: string | null; }
interface RaidSummary { days: number; from: string; to: string; totals: RaidTotal[]; incoming: RaidRow[]; outgoing: RaidRow[]; topIncoming: RaidPartner[]; topOutgoing: RaidPartner[]; }
interface RaidDashboard { summary: RaidSummary | null; tracking: Record<Direction, boolean>; updatedAt: string | null; pending: boolean; stale: boolean; }

@Component({
  selector: 'app-dashboard-raid-card', imports: [RouterLink, LfIconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-raid-card.component.html', styleUrl: './dashboard-raid-card.component.css'
})
export class DashboardRaidCardComponent {
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly language = inject(LanguageService);
  private readonly destroyRef = inject(DestroyRef);
  readonly channelID = input.required<string>();
  readonly streamer = input.required<string>();
  readonly days = signal(7);
  readonly direction = signal<Direction>('incoming');
  readonly data = signal<RaidDashboard | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly total = computed(() => this.data()?.summary?.totals.find(row => row._id === this.direction()));
  readonly recent = computed(() => this.data()?.summary?.[this.direction()] || []);
  readonly partners = computed(() => this.direction() === 'incoming' ? this.data()?.summary?.topIncoming || [] : this.data()?.summary?.topOutgoing || []);
  readonly outgoingTotal = computed(() => this.data()?.summary?.totals.find(row => row._id === 'outgoing')?.raids || 0);
  readonly headline = computed(() => {
    const stats = this.total();
    if (!stats) return '';
    if (this.direction() === 'outgoing') return this.t('outgoingSummary', { raids: this.number(stats.raids), viewers: this.number(stats.viewers) });
    return this.t(stats.evaluatedRaids ? 'incomingSummary' : 'incomingUncounted', {
      raids: this.number(stats.raids), follows: this.number(stats.followsAfter)
    });
  });
  readonly suggestion = computed(() => {
    if (!this.data()?.tracking.outgoing) return null;
    return this.data()?.summary?.incoming.filter(raid => !this.hasRaidedSince(raid) && (raid.followsAfter ?? 0) > 0)
      .reduce<RaidRow | null>((best, raid) => !best || raid.followsAfter! > best.followsAfter! ? raid : best, null) || null;
  });
  readonly avatars = signal<Record<string, string | null>>({});
  readonly settingsLink = computed(() => ['/', this.streamer(), 'modules', 'chat-events']);
  private sequence = 0;
  private poll?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  constructor() {
    effect(() => { const channel = this.channelID(), days = this.days(); this.data.set(null); void this.load(channel, days); });
    this.destroyRef.onDestroy(() => { this.destroyed = true; this.sequence++; clearTimeout(this.poll); });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate(`raidAnalytics.${key}`, params); }
  number(value: number): string { return new Intl.NumberFormat(this.language.currentLanguage()).format(value); }
  date(value: string): string { return new Intl.DateTimeFormat(this.language.currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  shortDate(value: string): string { return new Intl.DateTimeFormat(this.language.currentLanguage(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value)); }
  initial(raid: RaidRow): string { return Array.from(raid.peerName || raid.peerLogin || '?')[0].toUpperCase(); }
  hasRaidedSince(raid: RaidRow): boolean { return Boolean(raid.lastOutgoingAt && Date.parse(raid.lastOutgoingAt) >= Date.parse(raid.occurredAt)); }
  avatarFailed(login: string): void { this.avatars.update(cache => ({ ...cache, [login]: null })); }
  private loadAvatars(view: RaidDashboard): void {
    // Only the bounded recent lists need photos. Cache public profiles for this card's lifetime.
    const logins = new Set([...(view.summary?.incoming || []), ...(view.summary?.outgoing || [])].map(raid => raid.peerLogin));
    for (const login of logins) {
      if (!/^[a-zA-Z0-9_]{1,25}$/.test(login) || Object.hasOwn(this.avatars(), login)) continue;
      this.avatars.update(cache => Object.fromEntries([...Object.entries(cache).slice(-63), [login, null]]));
      void firstValueFrom(this.http.get<{ error: boolean; data?: { profile_image_url?: string } }>(
        `${this.links.getApiUrl()}/users?username=${encodeURIComponent(login)}`
      ).pipe(timeout(3000))).then(response => {
        const url = response.data?.profile_image_url;
        if (!this.destroyed && !response.error && url?.startsWith('https://')) this.avatars.update(cache => ({ ...cache, [login]: url }));
      }).catch(() => { /* The initial remains visible when a public profile is unavailable. */ });
    }
  }
  async load(channelID = this.channelID(), days = this.days()): Promise<void> {
    const sequence = ++this.sequence;
    clearTimeout(this.poll); this.loading.set(true); this.error.set(false);
    try {
      const response = await firstValueFrom(this.http.get<{ error: boolean; data: RaidDashboard }>(`${this.links.getApiUrl()}/dashboard/${channelID}/raids?days=${days}`));
      if (sequence !== this.sequence) return;
      if (response.error || !response.data) throw new Error('raids');
      this.data.set(response.data);
      this.loadAvatars(response.data);
      // A cold summary is prepared by the worker; the dashboard never waits for aggregation.
      if (response.data.pending && !this.destroyed) this.poll = setTimeout(() => { void this.load(); }, 10000);
    } catch { if (sequence === this.sequence) this.error.set(true); }
    finally { if (sequence === this.sequence) this.loading.set(false); }
  }
}
