import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgOptimizedImage } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { WidgetDisplayComponent } from './widget-display.component';
import { WidgetsApi, WidgetAction, WidgetCatalog, WidgetConfig, WidgetEntry, WidgetPack, WidgetState } from './widgets-api.service';

@Component({ selector: 'app-widgets-page', imports: [ReactiveFormsModule, RouterLink, LfIconComponent, NgOptimizedImage, WidgetDisplayComponent], templateUrl: './widgets-page.component.html', styleUrl: './widgets-page.component.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetsPageComponent {
  private readonly api = inject(WidgetsApi);
  private readonly auth = inject(SessionAuthService);
  readonly language = inject(LanguageService);
  private readonly upgrade = inject(UpgradeService);
  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly destroy = inject(DestroyRef);
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly pro = computed(() => this.auth.getPlanTierForStreamer(this.streamer) === 'pro');
  readonly channel = this.auth.session()?.appUser.twitch_user_id ?? '';
  readonly catalog = signal<WidgetCatalog | null>(null);
  readonly state = signal<WidgetState | null>(null);
  readonly selectedId = signal('');
  readonly roleFilter = signal('all');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly stale = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly overlayUrl = signal('');
  readonly confirm = signal<'start' | 'retry-poll' | 'rotate' | null>(null);
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');
  readonly previewPanel = viewChild<ElementRef<HTMLElement>>('previewPanel');
  readonly query = signal('');
  readonly entryKind = signal<'character' | 'perk'>('character');
  readonly entryLimit = signal(30);
  readonly excludedIds = signal<string[]>([]);
  readonly exclusionsDirty = signal(false);
  readonly failedImages = signal<ReadonlySet<string>>(new Set());
  readonly form = this.fb.group({ language: this.fb.control<'en' | 'es'>('en'), characterDesign: this.fb.control<'cards' | 'reel' | 'wheel' | 'elimination'>('cards'), spinSeconds: [4, [Validators.required, Validators.min(1), Validators.max(15), Validators.pattern(/^\d+$/)]], pollSeconds: [30, [Validators.required, Validators.min(15), Validators.max(180), Validators.pattern(/^\d+$/)]], channelPointsVoting: false, channelPointsPerVote: [100, [Validators.required, Validators.min(1), Validators.max(1000000), Validators.pattern(/^\d+$/)]], includeUnavailable: false });
  readonly channelPointsVoting = toSignal(this.form.controls.channelPointsVoting.valueChanges, { initialValue: false });
  readonly selected = computed(() => this.catalog()?.packs.find(p => p.id === this.selectedId()) ?? null);
  readonly packs = computed(() => this.catalog()?.packs.filter(p => this.roleFilter() === 'all' || p.role === this.roleFilter()) ?? []);
  readonly active = computed(() => !['idle', 'complete', 'poll-error'].includes(this.state()?.phase ?? 'idle'));
  readonly isSelected = computed(() => this.selectedId() === this.state()?.packId);
  readonly preview = computed<WidgetState | null>(() => {
    const state = this.state(); if (!state || !this.selected()) return null;
    return this.isSelected() ? state : { ...state, packId: this.selectedId(), phase: 'idle', run: null };
  });
  readonly entries = computed(() => {
    const pack = this.selected(), query = this.query().toLowerCase().trim();
    return this.catalog()?.entries.filter(e => e.role === pack?.role && e.kind === this.entryKind() && (!query || e.english.toLowerCase().includes(query) || e.spanish.toLowerCase().includes(query))) ?? [];
  });
  readonly shownEntries = computed(() => this.entries().slice(0, this.entryLimit()));
  readonly poolCounts = computed(() => {
    const pack = this.selected(), config = this.state()?.config;
    const rows = this.catalog()?.entries.filter(e => e.role === pack?.role && (config?.includeUnavailable || e.available) && !config?.excludedIds.includes(e.id)) ?? [];
    return { characters: rows.filter(e => e.kind === 'character').length, perks: rows.filter(e => e.kind === 'perk').length };
  });
  onQuery(event: Event): void { this.query.set((event.target as HTMLInputElement).value); this.entryLimit.set(30); }
  readonly addThirty = (n: number) => n + 30;
  private refreshing = false;
  private stopped = false;
  private pending: { action: WidgetAction; body: unknown; revision: number; key: string } | null = null;
  constructor() {
    this.destroy.onDestroy(() => { this.stopped = true; });
    if (this.pro()) void this.load(); else this.loading.set(false);
    const timer = setInterval(() => { if (this.pro() && this.state() && !this.busy() && !this.pending) void this.refresh(); }, 1500);
    this.destroy.onDestroy(() => clearInterval(timer));
    try { this.overlayUrl.set(sessionStorage.getItem('widgets-overlay-' + this.channel) ?? ''); } catch { /* Link stays usable without storage. */ }
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('widgets.' + key, params); }
  packTitle(pack: WidgetPack): string { return this.t(`pack.${pack.role}.${pack.mode}.title`); }
  packDescription(pack: WidgetPack): string { return this.t(`pack.${pack.role}.${pack.mode}.description`); }
  label(entry: WidgetEntry): string { return this.language.currentLanguage() === 'es' ? entry.spanish : entry.english; }
  thumbnail(pack: WidgetPack): WidgetEntry | undefined { return this.catalog()?.entries.find(e => e.role === pack.role && e.kind === (pack.mode === 'perks' ? 'perk' : 'character')); }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
  choose(pack: WidgetPack): void { this.selectedId.set(pack.id); this.query.set(''); this.entryLimit.set(30); this.entryKind.set(pack.mode === 'perks' ? 'perk' : 'character');
    if (matchMedia('(max-width: 1023px)').matches) requestAnimationFrame(() => this.previewPanel()?.nativeElement.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  }
  promptUpgrade(): void { void this.upgrade.promptUpgradeForModule({ moduleId: 'widgets', source: 'widgets_page' }); }
  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const [catalog, state] = await Promise.all([this.api.catalog(this.channel), this.api.read(this.channel)]);
      if (this.stopped) return;
      this.catalog.set(catalog); this.accept(state); this.selectedId.set(state.packId); this.entryKind.set(catalog.packs.find(p => p.id === state.packId)?.mode === 'perks' ? 'perk' : 'character'); this.stale.set(false);
    } catch (e) { this.handleError(e); this.stale.set(true); }
    finally { this.loading.set(false); }
  }
  async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return; this.refreshing = true;
    try { const state = await this.api.read(this.channel); if (!this.stopped) { this.accept(state); this.stale.set(false); } }
    catch (e) { if (!this.stopped) { this.stale.set(true); this.handleError(e); } }
    finally { this.refreshing = false; }
  }
  private accept(state: WidgetState): void {
    if (this.state() && state.revision < this.state()!.revision) return;
    this.state.set(state);
    if (!this.form.dirty && !this.exclusionsDirty()) { this.form.patchValue(state.config); this.excludedIds.set([...state.config.excludedIds]); }
  }
  async act(action: WidgetAction, body: unknown = {}): Promise<void> {
    if (this.busy() || this.stale() || this.pending || !this.state()) return;
    this.pending = { action, body, revision: this.state()!.revision, key: crypto.randomUUID() };
    await this.sendPending();
  }
  async sendPending(): Promise<void> {
    const pending = this.pending; if (!pending || this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const state = await this.api.action(this.channel, pending.action, pending.body, pending.revision, pending.key);
      this.pending = null;
      if (pending.action === 'configure') { this.form.markAsPristine(); this.exclusionsDirty.set(false); }
      this.accept(state); this.stale.set(false); this.notice.set(this.t('saved'));
    } catch (e) {
      // A network/5xx response can hide an accepted draw. Retry exactly the same operation/key.
      if (e instanceof HttpErrorResponse && (e.status === 0 || e.status >= 500)) this.error.set(this.t('uncertain'));
      else { this.pending = null; this.handleError(e); await this.refresh(); }
    } finally { this.busy.set(false); }
  }
  hasPending(): boolean { return this.pending !== null; }
  useSelected(): void { if (this.selected()) void this.act('select', { packId: this.selectedId() }); }
  saveSettings(): void {
    this.form.markAllAsTouched();
    if (!this.form.controls.channelPointsVoting.value) this.form.controls.channelPointsPerVote.setValue(this.state()?.config.channelPointsPerVote ?? 100, { emitEvent: false });
    if (this.form.invalid) return;
    const config: WidgetConfig = { ...this.form.getRawValue(), excludedIds: this.excludedIds() };
    void this.act('configure', config);
  }
  toggleEntry(entry: WidgetEntry): void { this.excludedIds.update(ids => ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id]); this.exclusionsDirty.set(true); }
  setAll(enabled: boolean): void {
    const ids = new Set(this.entries().map(e => e.id));
    this.excludedIds.update(excluded => enabled ? excluded.filter(id => !ids.has(id)) : [...new Set([...excluded, ...ids])]); this.exclusionsDirty.set(true);
  }
  openConfirm(kind: 'start' | 'retry-poll' | 'rotate'): void { this.confirm.set(kind); this.dialog()?.nativeElement.showModal(); }
  closeConfirm(): void { this.dialog()?.nativeElement.close(); this.confirm.set(null); }
  confirmAction(): void { const action = this.confirm(); this.closeConfirm(); if (action === 'rotate') void this.makeLink(); else if (action) void this.act(action); }
  async makeLink(): Promise<void> {
    if (this.busy()) return; this.busy.set(true); this.error.set('');
    try {
      const token = await this.api.token(this.channel);
      const url = `${location.origin}/overlays/widgets/${this.channel}#${token}`;
      this.overlayUrl.set(url); try { sessionStorage.setItem('widgets-overlay-' + this.channel, url); } catch { /* Optional. */ }
      await this.refresh(); this.notice.set(this.t('linkReady'));
    } catch (e) { this.handleError(e); } finally { this.busy.set(false); }
  }
  async copyLink(): Promise<void> { try { await navigator.clipboard.writeText(this.overlayUrl()); this.notice.set(this.t('copied')); } catch { this.error.set(this.t('copyError')); } }
  private handleError(e: unknown): void {
    const code = e instanceof HttpErrorResponse ? e.error?.code : '';
    this.error.set(this.t(code === 'pro_required' ? 'proRequired' : code === 'revision_conflict' || code === 'busy' ? 'conflict' : code === 'empty_pool' ? 'emptyPool' : 'loadError'));
  }
}
