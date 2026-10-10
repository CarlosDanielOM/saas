import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LanguageService } from '../../services/language.service';
import { MODULE_TIER_REQUIREMENTS, isModuleAccessible } from '../modules/module-tier.model';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { WidgetDisplayComponent } from './widget-display.component';
import { WidgetStreakComponent } from './widget-streak.component';
import { WidgetBitsComponent } from './widget-bits.component';
import { WidgetPoolComponent, WidgetPool } from './widget-pool.component';
import { challengeSteps } from './widget-steps';
import { WidgetsApi, WidgetAction, WidgetCatalog, WidgetConfig, WidgetEntry, WidgetEventSettings, WidgetState, WidgetRole, WidgetMode, WidgetLayout, widgetDefaultLayout } from './widgets-api.service';

@Component({ selector: 'app-widgets-page', imports: [ReactiveFormsModule, RouterLink, LfIconComponent, WidgetDisplayComponent, WidgetStreakComponent, WidgetBitsComponent, WidgetPoolComponent], templateUrl: './widgets-page.component.html', styleUrls: ['./widgets-base.css', './widgets-page.component.css'], changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetsPageComponent {
  private readonly api = inject(WidgetsApi);
  private readonly auth = inject(SessionAuthService);
  readonly language = inject(LanguageService);
  private readonly upgrade = inject(UpgradeService);
  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly destroy = inject(DestroyRef);
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly premium = computed(() => isModuleAccessible(MODULE_TIER_REQUIREMENTS.widgets, this.auth.getPlanTierForStreamer(this.streamer)));
  readonly channel = this.auth.session()?.appUser.twitch_user_id ?? '';
  readonly catalog = signal<WidgetCatalog | null>(null);
  readonly state = signal<WidgetState | null>(null);
  readonly roles: WidgetRole[] = ['killer', 'survivor'];
  readonly corners: WidgetLayout['cameraCorner'][] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  readonly role = computed<WidgetRole>(() => this.state()?.packId.includes('-survivor-') ? 'survivor' : 'killer');
  readonly gameplayPreview = signal(false);
  readonly celebrate = signal<{role: WidgetRole; tick: number} | null>(null);
  readonly now = signal(Date.now());
  private serverOffset = 0;
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
  readonly eventSettings = signal<WidgetEventSettings | null>(null);
  readonly poolEditor = viewChild(WidgetPoolComponent);
  readonly poolDirty = computed(() => this.poolEditor()?.dirty() ?? false);
  private sequenceForm() { return this.fb.group({character: true, fixedCharacterId: '', poll: true, perks: true, perkCount: [4, [Validators.required, Validators.min(0), Validators.max(4), Validators.pattern(/^\d+$/)]]}); }
  readonly sequenceForms = {killer: this.sequenceForm(), survivor: this.sequenceForm()};
  readonly form = this.fb.group({ language: this.fb.control<'en' | 'es'>('en'), characterDesign: this.fb.control<'cards' | 'reel' | 'wheel' | 'elimination'>('cards'), spinSeconds: [4, [Validators.required, Validators.min(1), Validators.max(15), Validators.pattern(/^\d+$/)]], pollSeconds: [30, [Validators.required, Validators.min(15), Validators.max(180), Validators.pattern(/^\d+$/)]], channelPointsVoting: false, channelPointsPerVote: [100, [Validators.required, Validators.min(1), Validators.max(1000000), Validators.pattern(/^\d+$/)]], jokerChance: [0, [Validators.required, Validators.min(0), Validators.max(100), Validators.pattern(/^\d+$/)]], jokerPointsPerVote: [100, [Validators.required, Validators.min(1), Validators.max(1000000), Validators.pattern(/^\d+$/)]], sequences: this.fb.group(this.sequenceForms), targets: this.fb.group({killer: [3, [Validators.required, Validators.min(1), Validators.max(20), Validators.pattern(/^\d+$/)]], survivor: [4, [Validators.required, Validators.min(1), Validators.max(20), Validators.pattern(/^\d+$/)]]}) });
  readonly layoutForm = this.fb.group({...widgetDefaultLayout(), cameraWidth: [512,[Validators.required,Validators.min(320),Validators.max(800),Validators.pattern(/^\d+$/)]], cameraHeight: [288,[Validators.required,Validators.min(180),Validators.max(640),Validators.pattern(/^\d+$/)]]});
  readonly formValue = toSignal(this.form.valueChanges, {initialValue: this.form.getRawValue()});
  readonly layoutValue = toSignal(this.layoutForm.valueChanges, {initialValue: this.layoutForm.getRawValue()});
  readonly channelPointsVoting = computed(() => this.formValue().channelPointsVoting === true);
  readonly jokerOn = computed(() => Number(this.formValue().jokerChance) > 0);
  readonly active = computed(() => !['idle', 'complete', 'poll-error'].includes(this.state()?.phase ?? 'idle'));
  readonly locked = computed(() => this.active() || this.state()?.phase === 'poll-error' || this.busy() || this.stale());
  readonly preview = computed<WidgetState | null>(() => {
    const state = this.state(); this.layoutValue();
    return state ? {...state, config: {...state.config, layout: this.layoutForm.valid ? this.layoutForm.getRawValue() : state.config.layout}} : null;
  });
  readonly canStart = computed(() => { this.formValue(); return !this.locked() && !this.form.dirty && !this.poolDirty(); });
  readonly entriesById = computed(() => new Map((this.catalog()?.entries ?? []).map(e => [e.id, e])));
  /** Where the round is, with a short detail under each step. */
  readonly steps = computed(() => {
    const state = this.state(); if (!state) return [];
    const sequence = state.run?.sequence ?? state.config.sequences[this.role()], fixed = this.entriesById().get(sequence.fixedCharacterId ?? '');
    const details: Record<string, string> = {
      character: this.t('stepDetail.character'),
      vote: this.t('stepDetail.vote'),
      perks: sequence.poll ? this.t('stepDetail.perksVoted') : this.t('fixedPerkCount', {n: sequence.perkCount}),
      play: this.t('stepDetail.play'),
    };
    const steps = challengeSteps(state, this.role()).map(step => ({...step, label: this.t('flow.' + step.key), detail: details[step.key]}));
    return !sequence.character && fixed && steps.length ? [{key: 'fixed', status: steps.some(step => step.status !== 'todo') ? 'done' : 'todo', label: this.label(fixed), detail: this.t('fixedCharacter')}, ...steps] : steps;
  });
  readonly countdown = computed(() => Math.max(0, Math.ceil(((this.state()?.run?.pollEndsAt ?? 0) - this.now() - this.serverOffset) / 1000)));
  /** One plain-language answer to "what is happening and what do I do next?" */
  readonly status = computed(() => {
    const state = this.state(); if (!state) return null;
    const run = state.run, role = this.t('role.' + this.role()).toLowerCase(), mode = run?.operation ?? 'challenge';
    const name = (id: string | null | undefined) => { const entry = this.entriesById().get(id ?? ''); return entry ? this.label(entry) : ''; };
    const perkTotal = run?.perkCount ?? (run?.sequence?.poll === false ? run.sequence.perkCount : 4), perkIndex = (run?.perkIds.length ?? 0) + 1;
    const line = (key: string, tone: 'idle' | 'live' | 'ok' | 'error', params: Record<string, string | number> = {}) => ({tone, title: this.t('status.' + key + '.title', params), detail: this.t('status.' + key + '.detail', params)});
    switch (state.phase) {
      case 'idle': return line('idle', 'idle', {role});
      case 'character-spin': return line('characterSpin', 'live', {role});
      case 'character-result': return line('characterResult', 'live', {name: name(run?.characterId)});
      case 'poll-starting': return line('pollStarting', 'live');
      case 'polling': return line('polling', 'live', {seconds: this.countdown(), n: run?.votes.reduce((a, b) => a + b, 0) ?? 0});
      case 'poll-error': return line('pollError', 'error');
      case 'reveal': return line('reveal', 'live', {card: (run?.winningCard ?? 0) + 1, n: run?.perkCount ?? 0});
      case 'perk-spin': return line('perkSpin', 'live', {i: perkIndex, n: perkTotal});
      case 'perk-result': return line('perkResult', 'live', {i: perkIndex - 1, n: perkTotal, name: name(run?.perkIds.at(-1))});
      default:
        if (mode === 'characters') return line('pickedCharacter', 'ok', {name: name(run?.characterId)});
        if (mode === 'perks') return line('pickedPerk', 'ok', {name: name(run?.perkIds.at(-1))});
        if (mode === 'poll') return line('pickedCount', 'ok', {n: run?.perkCount ?? 0});
        return line('complete', 'ok', {role});
    }
  });
  readonly poolCounts = computed(() => {
    const role = this.role(), config = this.state()?.config;
    const rows = this.catalog()?.entries.filter(e => e.role === role && (config?.includeUnavailable || e.available) && !config?.excludedIds.includes(e.id)) ?? [];
    return { characters: rows.filter(e => e.kind === 'character').length, perks: rows.filter(e => e.kind === 'perk').length };
  });
  private refreshing = false;
  private stopped = false;
  private pending: { action: WidgetAction; body: unknown; revision: number; key: string } | null = null;
  constructor() {
    this.destroy.onDestroy(() => { this.stopped = true; });
    if (this.premium()) void this.load(); else this.loading.set(false);
    const timer = setInterval(() => { if (this.premium() && this.state() && !this.busy() && !this.pending) void this.refresh(); }, 1500);
    const clock = setInterval(() => this.now.set(Date.now()), 1000);
    this.destroy.onDestroy(() => { clearInterval(timer); clearInterval(clock); });
    try { this.overlayUrl.set(sessionStorage.getItem('widgets-overlay-' + this.channel) ?? ''); } catch { /* Link stays usable without storage. */ }
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('widgets.' + key, params); }
  label(entry: WidgetEntry): string { return this.language.currentLanguage() === 'es' ? entry.spanish : entry.english; }
  characters(role: WidgetRole): WidgetEntry[] { return this.catalog()?.entries.filter(e => e.role === role && e.kind === 'character') ?? []; }
  chooseRole(role: WidgetRole): void { if (role !== this.role()) void this.act('role', {role}); }
  sequenceValue(role: WidgetRole) { this.formValue(); return this.sequenceForms[role].getRawValue(); }
  /** Plays the next win's animation in this page only; nothing is recorded or sent to OBS. */
  previewWin(role: WidgetRole): void { this.celebrate.update(c => ({role, tick: (c?.tick ?? 0) + 1})); }
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
      const [catalog, state, events] = await Promise.all([this.api.catalog(this.channel), this.api.read(this.channel), this.api.events(this.channel)]);
      if (this.stopped) return;
      this.catalog.set(catalog); this.accept(state); this.eventSettings.set(events.settings); this.stale.set(false);
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
    this.serverOffset = state.serverTime - Date.now();
    this.state.set(state);
    if (!this.layoutForm.dirty) this.layoutForm.patchValue(state.config.layout);
    if (!this.form.dirty) { this.form.patchValue({...state.config, sequences: {killer: {...state.config.sequences.killer, fixedCharacterId: state.config.sequences.killer.fixedCharacterId ?? ''}, survivor: {...state.config.sequences.survivor, fixedCharacterId: state.config.sequences.survivor.fixedCharacterId ?? ''}}}); }
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
      this.accept(state);
      // Pool and settings save separately so neither overwrites the other (or a Bits change to the wheel).
      if (pending.action === 'configure' && 'excludedIds' in (pending.body as object)) this.poolEditor()?.markSaved();
      else if (pending.action === 'configure') this.form.markAsPristine();
      if (pending.action === 'layout') this.layoutForm.markAsPristine();
      if (pending.action === 'events') this.eventSettings.set((await this.api.events(this.channel)).settings);
      this.stale.set(false); this.notice.set(this.t('saved'));
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
    if (!this.jokerOn() && this.form.controls.jokerChance.valid) this.form.controls.jokerPointsPerVote.setValue(this.state()?.config.jokerPointsPerVote ?? 100);
    if (this.form.invalid) { this.error.set(this.t('settingsInvalid')); return; }
    const value = this.form.getRawValue();
    for (const role of this.roles) if (!value.sequences[role].character && !value.sequences[role].fixedCharacterId) { this.error.set(this.t('fixedCharacterRequired')); return; }
    // The server merges missing fields, so the roulette pool saved elsewhere stays untouched.
    const config: Omit<WidgetConfig, 'includeUnavailable' | 'excludedIds' | 'perkTuning'> = {...value, sequences: {killer: {...value.sequences.killer, fixedCharacterId: value.sequences.killer.fixedCharacterId || null}, survivor: {...value.sequences.survivor, fixedCharacterId: value.sequences.survivor.fixedCharacterId || null}}, layout: this.state()!.config.layout};
    void this.act('configure', config);
  }
  savePool(pool: WidgetPool): void { void this.act('configure', pool); }
  saveEvents(settings: Omit<WidgetEventSettings, 'activeSince'>): void { void this.act('events', settings); }
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
    this.error.set(this.t(code === 'premium_required' ? 'premiumRequired' : code === 'revision_conflict' || code === 'busy' ? 'conflict' : code === 'empty_pool' ? 'emptyPool' : 'loadError'));
  }
}
