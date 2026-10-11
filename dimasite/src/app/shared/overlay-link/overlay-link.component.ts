import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { LfIconComponent } from '../lf-icon/lf-icon.component';

type Kind = 'widgets' | 'duel' | 'roulette';
interface LinkState { token: string | null; exists: boolean; version: string | null }

/** Channel-owned OBS links, shared by every authorized account. */
@Component({
  selector: 'app-overlay-link', imports: [ReactiveFormsModule, LfIconComponent],
  templateUrl: './overlay-link.component.html', styleUrl: './overlay-link.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush, host: { class: 'ph-no-capture' },
})
export class OverlayLinkComponent {
  readonly channel = input.required<string>();
  readonly kind = input.required<Kind>();
  readonly streamer = input.required<string>();
  readonly disabled = input(false);
  readonly urlChanged = output<string>();
  readonly changed = output<void>();
  private readonly http = inject(HttpClient);
  private readonly api = inject(LinksService).getApiUrl();
  private readonly language = inject(LanguageService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('replacement');
  private stopped = false;
  private requestId = 0;
  readonly state = signal<LinkState | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly existingLink = new FormControl('', { nonNullable: true });
  readonly url = computed(() => this.state()?.token ? `${location.origin}/overlays/${this.kind()}/${this.channel()}#${this.state()!.token}` : '');
  readonly boardUrl = computed(() => this.url().replace('#', '/leaderboard#'));
  readonly fieldId = computed(() => `overlay-link-${this.kind()}-${this.channel()}`);
  private readonly endpoint = computed(() => this.api + (this.kind() === 'roulette' ? `/roulettes/${this.channel()}` : `/widgets/${this.channel()}${this.kind() === 'duel' ? '/duel' : ''}`) + '/overlay-token');

  constructor() {
    effect(() => { this.channel(); this.kind(); void this.load(); });
    const timer = setInterval(() => { if (!this.loading() && !this.busy() && !this.dialog()?.nativeElement.open) void this.load(false); }, 15000);
    inject(DestroyRef).onDestroy(() => { this.stopped = true; this.requestId++; clearInterval(timer); });
  }
  t(key: string): string { return this.language.translate('overlayLinks.' + key, { streamer: this.streamer() }); }
  private accept(state: LinkState): void { this.state.set(state); this.urlChanged.emit(this.url()); }
  private parseToken(value: string): string | null {
    try {
      const url = new URL(value.trim());
      const path = `/overlays/${this.kind()}/${this.channel()}`;
      return /^https?:$/.test(url.protocol) && (url.pathname === path || this.kind() === 'duel' && url.pathname === path + '/leaderboard') && /^[\w-]{43}$/.test(url.hash.slice(1)) ? url.hash.slice(1) : null;
    } catch { return null; }
  }
  private cachedLink(): string {
    try { return this.kind() === 'roulette' ? localStorage.getItem(`roulette.overlay.${this.channel()}`) ?? '' : sessionStorage.getItem(`${this.kind() === 'duel' ? 'duel' : 'widgets'}-overlay-${this.channel()}`) ?? ''; } catch { return ''; }
  }
  async load(showLoading = true): Promise<void> {
    const id = ++this.requestId, endpoint = this.endpoint();
    if (showLoading) { this.loading.set(true); this.error.set(''); }
    try {
      let state = (await firstValueFrom(this.http.get<{ data: LinkState }>(endpoint))).data;
      const cached = state.exists && !state.token ? this.parseToken(this.cachedLink()) : null;
      if (cached) {
        try { state = (await firstValueFrom(this.http.post<{ data: LinkState }>(endpoint, { token: cached }))).data; }
        catch (error) { if (!(error instanceof HttpErrorResponse && error.status === 409)) throw error; }
      }
      if (!this.stopped && id === this.requestId) { this.accept(state); this.error.set(''); }
    } catch { if (!this.stopped && id === this.requestId) this.error.set(this.t('loadError')); }
    finally { if (!this.stopped && id === this.requestId) this.loading.set(false); }
  }
  async create(): Promise<void> { await this.write({}); }
  openReplacement(): void { if (!this.blocked() && this.state()?.exists) this.dialog()?.nativeElement.showModal(); }
  closeReplacement(): void { this.dialog()?.nativeElement.close(); }
  async replace(): Promise<void> { await this.write({ rotate: true, version: this.state()?.version }); }
  async recover(): Promise<void> {
    const token = this.parseToken(this.existingLink.value);
    if (!token) { this.error.set(this.t('invalidLink')); return; }
    await this.write({ token });
  }
  blocked(): boolean { return this.loading() || this.busy() || this.disabled() || !this.state(); }
  private async write(body: Record<string, unknown>): Promise<void> {
    if (this.blocked()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    // Discard any earlier GET that could overwrite the result of this mutation.
    const id = ++this.requestId;
    try {
      const state = (await firstValueFrom(this.http.post<{ data: LinkState }>(this.endpoint(), body))).data;
      if (this.stopped || id !== this.requestId) return;
      this.accept(state); this.closeReplacement(); this.existingLink.reset(); this.notice.set(this.t('saved')); this.changed.emit();
    } catch (error) {
      if (this.stopped || id !== this.requestId) return;
      this.closeReplacement();
      const code = error instanceof HttpErrorResponse ? error.error?.code : '';
      if (code === 'overlay_link_conflict') { this.closeReplacement(); await this.load(); this.error.set(this.t('conflict')); }
      else this.error.set(this.t(code === 'overlay_link_invalid' ? 'inactiveLink' : 'saveError'));
    } finally { if (!this.stopped) this.busy.set(false); }
  }
  async copy(board = false): Promise<void> {
    try { await navigator.clipboard.writeText(board ? this.boardUrl() : this.url()); this.notice.set(this.t('copied')); }
    catch { this.error.set(this.t('copyError')); }
  }
}
