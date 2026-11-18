import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { OverlayLinkComponent } from '../../shared/overlay-link/overlay-link.component';
import { ThrottleClickDirective } from '../../shared/directives/throttle-click.directive';
import { PopPlayer } from '../../shared/chat-sound/pop-sound';
import { getRouteParam } from '../../shared/utils/route-param.util';

export interface ChatSoundSettings {
  enabled: boolean; volume: number; ignoreBots: boolean; ignoreSelf: boolean; ignoreCommands: boolean; ignoreSharedChat: boolean;
  cooldownSeconds: number; quietMinutes: number;
}
export interface ChatSoundStatus { sources: number; ready: number; obsPlaying: number; tabPlaying: number; obsSilent: number; tabSilent: number; outdated: number }
export interface ChatSoundState { revision: number; settings: ChatSoundSettings; linked: boolean; status: ChatSoundStatus }
/** What the streamer needs to know first: is it playing, and if not, why. */
export type ChatSoundHealth = 'off' | 'playing' | 'tab' | 'silent' | 'missing';
type Filter = 'ignoreBots' | 'ignoreSelf' | 'ignoreCommands' | 'ignoreSharedChat';

const COOLDOWNS = [0.25, 0.5, 1, 2, 3, 5, 10, 30];
const QUIET = [1, 2, 3, 5, 10, 15, 30, 60];
const DEFAULT_QUIET = 5;
const withValue = (list: number[], value: number) => list.includes(value) ? list : [...list, value].sort((a, b) => a - b);

@Component({
  selector: 'app-chat-sound-page',
  imports: [RouterLink, LfIconComponent, OverlayLinkComponent, ThrottleClickDirective],
  templateUrl: './chat-sound-page.component.html',
  styleUrls: ['../widgets/widgets-base.css', './chat-sound-page.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatSoundPageComponent {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(SessionAuthService);
  private readonly api = inject(LinksService).getApiUrl();
  readonly language = inject(LanguageService);
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  private readonly player = new PopPlayer();
  readonly filters: Filter[] = ['ignoreBots', 'ignoreSelf', 'ignoreCommands', 'ignoreSharedChat'];

  channel = '';
  readonly state = signal<ChatSoundState | null>(null);
  readonly draft = signal<ChatSoundSettings | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly testing = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly testNotice = signal('');
  private stopped = false;
  private refreshing = false;
  /** Quiet minutes picked earlier, so switching modes back and forth keeps them. */
  private quietChoice = DEFAULT_QUIET;
  /** The saved settings and revision the draft started from: a save sends that revision, and newer saves from
   * elsewhere are merged under the fields changed here instead of being overwritten. */
  private base: ChatSoundSettings | null = null;
  private baseRevision = 0;

  readonly dirty = computed(() => { const state = this.state(), draft = this.draft(); return !!state && !!draft && JSON.stringify(state.settings) !== JSON.stringify(draft); });
  readonly mode = computed(() => (this.draft()?.quietMinutes ?? 0) > 0 ? 'quiet' : 'every');
  readonly cooldowns = computed(() => withValue(COOLDOWNS, this.draft()?.cooldownSeconds ?? 1));
  readonly quietOptions = computed(() => withValue(QUIET, this.draft()?.quietMinutes || DEFAULT_QUIET));
  readonly health = computed<ChatSoundHealth>(() => {
    const state = this.state();
    if (!state) return 'missing';
    if (!state.settings.enabled) return 'off';
    // An OBS source that plays wins; a silent OBS source is the problem to show even when a tab plays.
    const { obsPlaying, obsSilent, tabPlaying, tabSilent } = state.status;
    if (obsPlaying > 0) return 'playing';
    if (obsSilent > 0) return 'silent';
    if (tabPlaying > 0) return 'tab';
    return tabSilent > 0 ? 'silent' : 'missing';
  });
  /** "Off: bots, your own messages" under the closed filters section. */
  readonly filterSummary = computed(() => {
    const draft = this.draft();
    if (!draft) return '';
    const skipped = this.filters.filter(key => draft[key]).map(key => this.t('filters.short.' + key));
    return skipped.length ? this.t('filters.skipping', { list: skipped.join(', ') }) : this.t('filters.none');
  });

  constructor() {
    const destroy = inject(DestroyRef);
    void this.load();
    // The OBS status follows within a few seconds (a source reports every 5 s).
    const poll = setInterval(() => { if (this.channel && !this.busy()) void this.refresh(); }, 4000);
    destroy.onDestroy(() => { this.stopped = true; clearInterval(poll); this.player.close(); });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('chatSound.' + key, params); }
  seconds(value: number): string { return this.t(value === 1 ? 'oneSecond' : 'seconds', { n: value.toLocaleString(this.language.currentLanguage() === 'es' ? 'es-MX' : 'en-US') }); }
  minutes(value: number): string { return this.t(value === 1 ? 'oneMinute' : 'minutes', { n: value }); }
  checked(event: Event): boolean { return (event.target as HTMLInputElement).checked; }
  numberOf(event: Event): number { return Number((event.target as HTMLInputElement | HTMLSelectElement).value); }

  /** Takes a server state; an unsaved draft is kept and moved on top of newer settings saved elsewhere. */
  private apply(state: ChatSoundState): boolean {
    if (this.stopped) return false;
    const draft = this.draft(), base = this.base;
    this.state.set(state);
    if (!draft || !base || JSON.stringify(draft) === JSON.stringify(base)) {
      this.draft.set({ ...state.settings }); this.base = { ...state.settings }; this.baseRevision = state.revision;
      if (state.settings.quietMinutes > 0) this.quietChoice = state.settings.quietMinutes;
      return false;
    }
    if (state.revision === this.baseRevision) return false;
    const mine = (Object.keys(draft) as (keyof ChatSoundSettings)[]).filter(key => draft[key] !== base[key]);
    this.draft.set({ ...state.settings, ...Object.fromEntries(mine.map(key => [key, draft[key]])) });
    this.base = { ...state.settings }; this.baseRevision = state.revision;
    return true;
  }
  private url(path = ''): string { return `${this.api}/chat-sound/${this.channel}${path}`; }
  private async load(): Promise<void> {
    try {
      this.channel = (await firstValueFrom(this.auth.resolveChannelID(this.streamer))) ?? '';
      if (!this.channel) { this.error.set(this.t('loadError')); return; }
      this.apply((await firstValueFrom(this.http.get<{ data: ChatSoundState }>(this.url()))).data);
      this.error.set('');
    } catch { this.error.set(this.t('loadError')); }
    finally { this.loading.set(false); }
  }
  async reload(): Promise<void> { this.loading.set(true); await this.load(); }
  async refresh(): Promise<void> {
    if (this.refreshing) return; this.refreshing = true;
    try { if (this.apply((await firstValueFrom(this.http.get<{ data: ChatSoundState }>(this.url()))).data)) this.notice.set(this.t('merged')); }
    catch { /* The last status stays; the next poll retries. */ }
    finally { this.refreshing = false; }
  }

  patch(change: Partial<ChatSoundSettings>): void {
    const draft = this.draft();
    if (!draft) return;
    this.notice.set('');
    if (change.quietMinutes) this.quietChoice = change.quietMinutes;
    this.draft.set({ ...draft, ...change });
  }
  toggle(key: Filter, event: Event): void { this.patch({ [key]: this.checked(event) }); }
  setMode(mode: 'every' | 'quiet'): void { this.patch({ quietMinutes: mode === 'quiet' ? this.quietChoice : 0 }); }
  discard(): void { const state = this.state(); if (state) { this.draft.set({ ...state.settings }); this.base = { ...state.settings }; this.baseRevision = state.revision; } this.notice.set(''); }

  async save(): Promise<void> {
    const state = this.state(), draft = this.draft();
    if (!state || !draft || this.busy() || !this.dirty()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const saved = (await firstValueFrom(this.http.put<{ data: ChatSoundState }>(this.url('/settings'), draft, { headers: { 'If-Match': String(this.baseRevision) } }))).data;
      this.base = null; // the saved settings become the new starting point
      this.apply(saved);
      this.notice.set(this.t('saved'));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 409) {
        // Someone else saved first: their settings come in under the fields changed here; review and save again.
        try { this.apply((await firstValueFrom(this.http.get<{ data: ChatSoundState }>(this.url()))).data); } catch { /* keep */ }
        this.error.set(this.t('conflict'));
      } else this.error.set(this.t('saveError'));
    } finally { this.busy.set(false); }
  }

  /** Plays the pop right here at the draft volume (the click lets the browser start audio). */
  async hear(): Promise<void> {
    const state = await this.player.unlock();
    if (state !== 'running' || !this.player.play(this.draft()?.volume ?? 70)) this.testNotice.set(this.t('hearBlocked'));
    else this.testNotice.set('');
  }
  /** One pop on every open OBS source, at the draft volume, so it can be tuned before saving. */
  async testObs(): Promise<void> {
    if (this.testing() || !this.channel) return;
    this.testing.set(true); this.testNotice.set('');
    try {
      const result = (await firstValueFrom(this.http.post<{ data: { sent: number; status: ChatSoundStatus } }>(this.url('/test'), { volume: this.draft()?.volume }))).data;
      const state = this.state();
      if (state) this.state.set({ ...state, status: result.status });
      this.testNotice.set(result.sent ? this.t(result.sent === 1 ? 'testSentOne' : 'testSent', { n: result.sent }) : this.t('testNone'));
    } catch { this.testNotice.set(this.t('testError')); }
    finally { this.testing.set(false); }
  }
}
