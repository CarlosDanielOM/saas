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
import { WidgetsApi, WidgetAction, WidgetCatalog, WidgetConfig, WidgetEntry, WidgetState, WidgetRole, WidgetMode, WidgetLayout, widgetDefaultLayout } from './widgets-api.service';

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
  readonly roles: WidgetRole[] = ['killer', 'survivor'];
  readonly role = computed<WidgetRole>(() => this.state()?.packId.includes('-survivor-') ? 'survivor' : 'killer');
  readonly gameplayPreview = signal(false);
  private startMode: WidgetMode = 'challenge';
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
  private sequenceForm() { return this.fb.group({character: true, fixedCharacterId: '', poll: true, perks: true, perkCount: [4, [Validators.required, Validators.min(0), Validators.max(4), Validators.pattern(/^\d+$/)]]}); }
  readonly sequenceForms = {killer: this.sequenceForm(), survivor: this.sequenceForm()};
  readonly form = this.fb.group({ language: this.fb.control<'en' | 'es'>('en'), characterDesign: this.fb.control<'cards' | 'reel' | 'wheel' | 'elimination'>('cards'), spinSeconds: [4, [Validators.required, Validators.min(1), Validators.max(15), Validators.pattern(/^\d+$/)]], pollSeconds: [30, [Validators.required, Validators.min(15), Validators.max(180), Validators.pattern(/^\d+$/)]], channelPointsVoting: false, channelPointsPerVote: [100, [Validators.required, Validators.min(1), Validators.max(1000000), Validators.pattern(/^\d+$/)]], includeUnavailable: false, sequences: this.fb.group(this.sequenceForms), targets: this.fb.group({killer: [3, [Validators.required, Validators.min(1), Validators.max(20), Validators.pattern(/^\d+$/)]], survivor: [4, [Validators.required, Validators.min(1), Validators.max(20), Validators.pattern(/^\d+$/)]]}) });
  readonly layoutForm = this.fb.group({...widgetDefaultLayout(), cameraWidth: [512,[Validators.required,Validators.min(320),Validators.max(800),Validators.pattern(/^\d+$/)]], cameraHeight: [288,[Validators.required,Validators.min(180),Validators.max(640),Validators.pattern(/^\d+$/)]]});
  readonly formValue = toSignal(this.form.valueChanges, {initialValue: this.form.getRawValue()});
  readonly layoutValue = toSignal(this.layoutForm.valueChanges, {initialValue: this.layoutForm.getRawValue()});
  readonly channelPointsVoting = computed(() => this.formValue().channelPointsVoting === true);
  readonly active = computed(() => !['idle', 'complete', 'poll-error'].includes(this.state()?.phase ?? 'idle'));
  readonly locked = computed(() => this.active() || this.state()?.phase === 'poll-error' || this.busy() || this.stale());
  readonly preview = computed<WidgetState | null>(() => {
    const state = this.state(); this.layoutValue();
    return state ? {...state, config: {...state.config, layout: this.layoutForm.valid ? this.layoutForm.getRawValue() : state.config.layout}} : null;
  });
  readonly canStart = computed(() => { this.formValue(); return !this.locked() && !this.form.dirty && !this.exclusionsDirty(); });
  readonly sequenceSteps = computed(() => {
    const sequence = this.state()?.config.sequences[this.role()];
    if (!sequence) return [];
    return [this.t(sequence.character ? 'flow.character' : 'fixedCharacter'), this.t(sequence.poll ? 'flow.vote' : 'fixedPerkCount', {n: sequence.perkCount}), ...(sequence.poll ? [this.t('flow.reveal')] : []), ...(sequence.perks ? [this.t('flow.perks')] : [])];
  });
  readonly entries = computed(() => {
    const role = this.role(), query = this.query().toLowerCase().trim();
    return this.catalog()?.entries.filter(e => e.role === role && e.kind === this.entryKind() && (!query || e.english.toLowerCase().includes(query) || e.spanish.toLowerCase().includes(query))) ?? [];
  });
  readonly shownEntries = computed(() => this.entries().slice(0, this.entryLimit()));
  readonly poolCounts = computed(() => {
    const role = this.role(), config = this.state()?.config;
    const rows = this.catalog()?.entries.filter(e => e.role === role && (config?.includeUnavailable || e.available) && !config?.excludedIds.includes(e.id)) ?? [];
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
  label(entry: WidgetEntry): string { return this.language.currentLanguage() === 'es' ? entry.spanish : entry.english; }
  imageFailed(entry: WidgetEntry): void { this.failedImages.update(ids => new Set([...ids, entry.id])); }
  characters(role: WidgetRole): WidgetEntry[] { return this.catalog()?.entries.filter(e => e.role === role && e.kind === 'character') ?? []; }
  chooseRole(role: WidgetRole): void { if (role !== this.role()) { this.query.set(''); this.entryLimit.set(30); void this.act('role', {role}); } }
  sequenceValue(role: WidgetRole) { this.formValue(); return this.sequenceForms[role].getRawValue(); }
  onResize(layout: WidgetLayout): void { this.layoutForm.patchValue(layout); this.layoutForm.markAsDirty(); }
  saveLayout(): void { this.layoutForm.markAllAsTouched(); if (this.layoutForm.valid) void this.act('layout', this.layoutForm.getRawValue()); }
  start(mode: WidgetMode): void {
    this.startMode = mode;
    if (mode === 'poll' || mode === 'challenge' && this.state()?.config.sequences[this.role()].poll) this.openConfirm('start');
    else void this.act('start', {mode});
  }
  promptUpgrade(): void { void this.upgrade.promptUpgradeForModule({ moduleId: 'widgets', source: 'widgets_page' }); }
  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const [catalog, state] = await Promise.all([this.api.catalog(this.channel), this.api.read(this.channel)]);
      if (this.stopped) return;
      this.catalog.set(catalog); this.accept(state); this.stale.set(false);
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
    if (!this.layoutForm.dirty) this.layoutForm.patchValue(state.config.layout);
    if (!this.form.dirty && !this.exclusionsDirty()) { this.form.patchValue({...state.config, sequences: {killer: {...state.config.sequences.killer, fixedCharacterId: state.config.sequences.killer.fixedCharacterId ?? ''}, survivor: {...state.config.sequences.survivor, fixedCharacterId: state.config.sequences.survivor.fixedCharacterId ?? ''}}}); this.excludedIds.set([...state.config.excludedIds]); }
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
      if (pending.action === 'layout') this.layoutForm.markAsPristine();
      this.accept(state); this.stale.set(false); this.notice.set(this.t('saved'));
    } catch (e) {
      // A network/5xx response can hide an accepted draw. Retry exactly the same operation/key.
      if (e instanceof HttpErrorResponse && (e.status === 0 || e.status >= 500)) this.error.set(this.t('uncertain'));
      else { this.pending = null; this.handleError(e); await this.refresh(); }
    } finally { this.busy.set(false); }
  }
  hasPending(): boolean { return this.pending !== null; }
  saveSettings(): void {
    this.form.markAllAsTouched();
    if (!this.form.controls.channelPointsVoting.value) this.form.controls.channelPointsPerVote.setValue(this.state()?.config.channelPointsPerVote ?? 100);
    if (this.form.invalid) { this.error.set(this.t('settingsInvalid')); return; }
    const value = this.form.getRawValue();
    for (const role of this.roles) if (!value.sequences[role].character && !value.sequences[role].fixedCharacterId) { this.error.set(this.t('fixedCharacterRequired')); return; }
    const config: WidgetConfig = {...value, sequences: {killer: {...value.sequences.killer, fixedCharacterId: value.sequences.killer.fixedCharacterId || null}, survivor: {...value.sequences.survivor, fixedCharacterId: value.sequences.survivor.fixedCharacterId || null}}, excludedIds: this.excludedIds(), layout: this.state()!.config.layout};
    void this.act('configure', config);
  }
  toggleEntry(entry: WidgetEntry): void { this.excludedIds.update(ids => ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id]); this.exclusionsDirty.set(true); }
  setAll(enabled: boolean): void {
    const ids = new Set(this.entries().map(e => e.id));
    this.excludedIds.update(excluded => enabled ? excluded.filter(id => !ids.has(id)) : [...new Set([...excluded, ...ids])]); this.exclusionsDirty.set(true);
  }
  openConfirm(kind: 'start' | 'retry-poll' | 'rotate'): void { this.confirm.set(kind); this.dialog()?.nativeElement.showModal(); }
  closeConfirm(): void { this.dialog()?.nativeElement.close(); this.confirm.set(null); }
  confirmAction(): void { const action = this.confirm(); this.closeConfirm(); if (action === 'rotate') void this.makeLink(); else if (action) void this.act(action, action === 'start' ? {mode: this.startMode} : {}); }
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
