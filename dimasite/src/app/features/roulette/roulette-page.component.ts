import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import {
  ROULETTE_DESIGNS,
  Roulette,
  RouletteDesign,
  RouletteItem,
  RouletteState,
  capacityFor,
} from './roulette-api.service';
import { RouletteApi } from './roulette-api.service';
import { RouletteDisplayComponent } from './roulette-display.component';

type CardSize = Roulette['cardSize'];
type WinnerAction = Roulette['settings']['winnerAction'];
type ConfigValue = ReturnType<RoulettePageComponent['config']['getRawValue']>;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}$/;
const PAGE = 20;
export const PALETTES: Record<string, string[]> = {
  pastel: ['#cbbaff', '#f4c968', '#ec9baf', '#a5d5c2'],
  neon: ['#a855f7', '#22d3ee', '#f472b6', '#facc15'],
  gold: ['#f6c453', '#b45309', '#fde68a', '#78350f'],
  violet: ['#7c3aed', '#c4b5fd', '#4c1d95', '#a78bfa'],
  sunset: ['#f97316', '#ef4444', '#ec4899', '#facc15'],
  mint: ['#34d399', '#0f766e', '#a7f3d0', '#059669'],
};
const COMMANDS = ['start', 'add', 'update', 'remove', 'shuffle', 'show', 'hide', 'switch', 'result'];

@Component({
  selector: 'app-roulette-page',
  imports: [ReactiveFormsModule, RouterLink, RouletteDisplayComponent, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './roulette-page.component.html',
  styleUrl: './roulette-page.component.css',
  host: { '(document:keydown.escape)': 'closeTop()' },
})
export class RoulettePageComponent {
  private readonly api = inject(RouletteApi);
  private readonly auth = inject(SessionAuthService);
  private readonly language = inject(LanguageService);
  private readonly upgrade = inject(UpgradeService);
  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly destroy = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly Math = Math;
  readonly designs = ROULETTE_DESIGNS;
  readonly cardSizes: CardSize[] = ['large', 'medium', 'small'];
  readonly winnerActions: WinnerAction[] = ['keep', 'remove-copy', 'remove-item'];
  readonly palettes = Object.entries(PALETTES).map(([id, colors]) => ({ id, colors }));
  readonly commands = COMMANDS;
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly pro = computed(() => this.auth.getPlanTierForStreamer(this.streamer) === 'pro');
  readonly owner = computed(
    () => this.auth.session()?.twitchUser.login.toLowerCase() === this.streamer.toLowerCase(),
  );
  readonly state = signal<RouletteState | null>(null);
  readonly selectedId = signal('');
  readonly selected = computed(
    () => this.state()?.roulettes.find((r) => r.id === this.selectedId()) ?? null,
  );
  readonly active = computed(
    () => this.state()?.roulettes.find((r) => r.id === this.state()?.activeId) ?? null,
  );
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly notice = signal('');
  readonly overlayUrl = signal('');
  readonly query = signal('');
  readonly limit = signal(PAGE);

  // Dialogs (only one of each at a time; Escape closes the topmost).
  readonly prizeDialog = signal<{ item: RouletteItem | null } | null>(null);
  readonly createOpen = signal(false);
  readonly deleteOpen = signal(false);
  readonly rotateOpen = signal(false);
  readonly removing = signal<RouletteItem | null>(null);
  readonly prizeSubmitted = signal(false);
  readonly createSubmitted = signal(false);
  private aliasEdited = false;

  readonly items = computed(() => this.selected()?.items ?? []);
  readonly matchingItems = computed(() => {
    const q = this.query().trim().toLowerCase();
    return q ? this.items().filter((i) => i.label.toLowerCase().includes(q)) : this.items();
  });
  readonly shownItems = computed(() => this.matchingItems().slice(0, this.limit()));
  readonly spinning = computed(() => this.state()?.draw?.completedAt === null);
  readonly copies = computed(() => this.selected()?.order.length ?? 0);
  readonly totalWeight = computed(() =>
    this.items().reduce((n, i) => n + i.weight * i.multiplier, 0),
  );
  readonly hasActions = computed(() => this.items().some((i) => !!i.action?.trim()));
  readonly isActive = computed(() => this.state()?.activeId === this.selectedId());
  readonly onStream = computed(() => !!this.state()?.visible && !!this.state()?.activeId);
  readonly history = computed(() => {
    const s = this.state();
    if (!s) return [];
    return s.history.slice(0, 8).map((d) => ({
      id: d.id,
      label: d.winner.label,
      roulette:
        d.rouletteId === this.selectedId()
          ? ''
          : (s.roulettes.find((r) => r.id === d.rouletteId)?.name ?? this.t('deleted')),
      ago: this.ago(d.endsAt),
      action: this.actionStatus(d.id),
    }));
  });

  readonly createForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    alias: ['', [Validators.required, Validators.pattern(ALIAS)]],
    design: this.fb.control<RouletteDesign>('wheel'),
  });
  readonly targetUser = this.fb.control('', [Validators.pattern(/^@?[a-zA-Z0-9_]{1,25}$/)]);
  readonly itemForm = this.fb.group({
    action: ['', Validators.maxLength(8000)],
    label: ['', [Validators.required, Validators.maxLength(120)]],
    multiplier: [1, [Validators.required, Validators.min(1), Validators.max(10000)]],
    weight: [1, [Validators.required, Validators.min(1)]],
  });
  readonly config = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    alias: ['', [Validators.required, Validators.pattern(ALIAS)]],
    design: this.fb.control<RouletteDesign>('wheel'),
    cardSize: this.fb.control<CardSize>('large'),
    durationSeconds: [4, [Validators.required, Validators.min(1), Validators.max(120)]],
    colors: this.fb.control<string[]>([...PALETTES['pastel']]),
    insertion: this.fb.control<'append' | 'random'>('append'),
    duplicate: this.fb.control<'separate' | 'increase'>('separate'),
    shuffleBeforeDraw: false,
    showOnStart: true,
    hideAfterSeconds: this.fb.control<number | null>(null, [
      Validators.min(1),
      Validators.max(3600),
    ]),
    winnerAction: this.fb.control<WinnerAction>('keep'),
  });
  readonly draft = signal(this.config.getRawValue());
  readonly dirty = signal(false);
  readonly itemDraft = signal(this.itemForm.getRawValue());

  /** Unsaved look changes are previewed on the stage before saving. */
  readonly previewRoulette = computed(() => {
    const r = this.selected();
    if (!r || !this.dirty()) return r;
    const d = this.draft();
    return { ...r, name: d.name || r.name, design: d.design, cardSize: d.cardSize, colors: d.colors };
  });
  readonly previewDraw = computed(() => {
    const draw = this.state()?.draw;
    if (!draw || draw.rouletteId !== this.selectedId()) return null;
    return this.dirty() && draw.completedAt !== null ? null : draw;
  });
  readonly draftCapacity = computed(() =>
    capacityFor(this.draft().design, this.draft().cardSize),
  );
  readonly overCapacity = computed(() => this.copies() > this.draftCapacity());
  readonly capacity = computed(() => {
    const r = this.selected();
    return r ? capacityFor(r.design, r.cardSize) : 0;
  });
  readonly capacityPct = computed(() =>
    Math.min(100, Math.round((this.copies() / Math.max(1, this.capacity())) * 100)),
  );
  readonly stageHint = computed(() => {
    const s = this.state();
    if (!s || !this.selected()) return '';
    if (!this.copies()) return this.t('stage.hintEmpty');
    if (!this.isActive()) return this.t('stage.hintNotActive');
    if (s.visible) return this.t('stage.hintVisible');
    return this.selected()!.settings.showOnStart
      ? this.t('stage.hintAutoShow')
      : this.t('stage.hintHidden');
  });
  /** Live odds for the prize being edited, as if it were already saved. */
  readonly prizePreview = computed(() => {
    const d = this.itemDraft();
    const editing = this.prizeDialog()?.item ?? null;
    const m = Math.max(0, Math.floor(Number(d.multiplier) || 0));
    const w = Math.max(0, Math.floor(Number(d.weight) || 0));
    const others = this.totalWeight() - (editing ? editing.weight * editing.multiplier : 0);
    const slots = this.copies() - (editing?.multiplier ?? 0) + m;
    return {
      chance: this.pct((w * m) / Math.max(1, others + w * m)),
      slots,
      over: slots > this.capacity(),
    };
  });

  private channel = '';
  private disposed = false;
  private refreshTask: Promise<void> | null = null;
  private drawEndTimer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    const timer = setInterval(() => {
      if (this.channel && !this.busy()) void this.refresh(false);
    }, 2000);
    this.destroy.onDestroy(() => {
      this.disposed = true;
      clearInterval(timer);
      clearTimeout(this.drawEndTimer);
    });
    this.config.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.draft.set(this.config.getRawValue());
      this.dirty.set(this.config.dirty);
    });
    this.itemForm.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.itemDraft.set(this.itemForm.getRawValue()));
    void this.init();
  }
  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(`roulette.${key}`, params);
  }
  async init(): Promise<void> {
    this.loading.set(true);
    if (!this.pro() || !this.owner()) {
      this.loading.set(false);
      return;
    }
    try {
      this.channel = (await firstValueFrom(this.auth.resolveChannelID(this.streamer))) ?? '';
      if (!this.channel) throw new Error('channel');
      try {
        this.overlayUrl.set(localStorage.getItem(`roulette.overlay.${this.channel}`) ?? '');
      } catch {
        /* browser storage may be unavailable */
      }
      await this.refresh(true);
    } catch {
      this.error.set(this.t('loadError'));
    } finally {
      this.loading.set(false);
    }
  }
  refresh(clear: boolean): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.loadState(clear).finally(() => {
      this.refreshTask = null;
    });
    return this.refreshTask;
  }
  private async loadState(clear: boolean): Promise<void> {
    if (this.disposed || !this.channel) return;
    try {
      const state = await this.api.read(this.channel);
      if (this.disposed) return;
      this.state.set(state);
      this.refreshAtDrawEnd(state);
      if (!state.roulettes.some((r) => r.id === this.selectedId()))
        this.select(state.activeId ?? state.roulettes[0]?.id ?? '');
      else if (!this.config.dirty) this.loadConfig();
      if (clear) this.error.set('');
    } catch (e) {
      this.handleError(e);
    }
  }
  /** Controls unlock as soon as the server settles the draw, not on the next 2 s poll. */
  private refreshAtDrawEnd(state: RouletteState): void {
    clearTimeout(this.drawEndTimer);
    const draw = state.draw;
    if (!draw || draw.completedAt !== null) return;
    this.drawEndTimer = setTimeout(
      () => void this.refresh(false),
      Math.max(0, draw.endsAt - state.serverTime) + 150,
    );
  }
  select(id: string): void {
    this.selectedId.set(id);
    this.loadConfig();
    this.query.set('');
    this.limit.set(PAGE);
  }
  loadConfig(): void {
    const r = this.selected();
    if (!r) return;
    this.config.reset(
      {
        name: r.name,
        alias: r.alias,
        design: r.design,
        cardSize: r.cardSize,
        durationSeconds: r.durationSeconds,
        colors: [...r.colors],
        ...r.settings,
      },
      { emitEvent: false },
    );
    this.draft.set(this.config.getRawValue());
    this.dirty.set(false);
  }
  /** Edits from custom controls (choice cards, swatches, sliders) mark the draft dirty. */
  setConfig<K extends keyof ConfigValue>(key: K, value: ConfigValue[K]): void {
    const control = this.config.controls[key];
    control.setValue(value as never);
    control.markAsDirty();
    this.config.updateValueAndValidity();
  }
  private handleError(e: unknown): void {
    const status = e instanceof HttpErrorResponse ? e.status : 0;
    const code = e instanceof HttpErrorResponse ? e.error?.code : '';
    if (code === 'invalid_action' || code === 'invalid_user' || code === 'capacity' || code === 'alias_conflict') {
      this.error.set(
        this.t(
          {
            invalid_action: 'actionSyntaxError',
            invalid_user: 'targetError',
            capacity: 'capacityError',
            alias_conflict: 'aliasError',
          }[code as string]!,
        ),
      );
      return;
    }
    this.error.set(
      this.t(
        status === 403
          ? 'accessError'
          : status === 409
            ? 'conflictError'
            : status === 400
              ? 'invalidError'
              : 'saveError',
      ),
    );
    if (status === 403) this.state.set(null);
  }
  private async mutate(
    method: string,
    path: string,
    body: unknown = {},
    revision = this.state()?.revision,
  ): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.refreshTask;
      await this.api.write(this.channel, method, path, body, revision);
      await this.refresh(false);
      return true;
    } catch (e) {
      this.handleError(e);
      await this.refresh(false);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  // Create
  openCreate(): void {
    this.aliasEdited = false;
    this.createSubmitted.set(false);
    this.createForm.reset({ name: '', alias: '', design: 'wheel' });
    this.createOpen.set(true);
    this.focusSoon('#rl-create-name');
  }
  onCreateName(): void {
    if (this.aliasEdited) return;
    this.createForm.controls.alias.setValue(this.slug(this.createForm.controls.name.value));
  }
  onCreateAlias(): void {
    this.aliasEdited = true;
  }
  private slug(name: string): string {
    let base = name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34);
    if (!base) return '';
    if (!/^[a-z]/.test(base)) base = `r-${base}`;
    const taken = new Set(this.state()?.roulettes.map((r) => r.alias));
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
    return alias;
  }
  async create(): Promise<void> {
    this.createSubmitted.set(true);
    if (this.createForm.invalid) return;
    const before = new Set(this.state()?.roulettes.map((r) => r.id));
    if (await this.mutate('POST', '/roulettes', this.createForm.getRawValue())) {
      const created = this.state()?.roulettes.find((r) => !before.has(r.id));
      if (created) this.select(created.id);
      this.createOpen.set(false);
    }
  }

  // Look & behaviour draft
  async saveConfig(): Promise<void> {
    if (this.config.invalid || !this.selected() || this.overCapacity()) return;
    const { name, alias, design, cardSize, durationSeconds, colors, ...settings } =
      this.config.getRawValue();
    if (
      await this.mutate('PATCH', `/roulettes/${this.selectedId()}`, {
        name,
        alias,
        design,
        cardSize,
        durationSeconds,
        colors,
        settings,
      })
    ) {
      this.loadConfig();
      this.notice.set(this.t('saved'));
    }
  }
  setDuration(value: string): void {
    const n = Math.floor(Number(value));
    if (Number.isFinite(n)) this.setConfig('durationSeconds', Math.min(120, Math.max(1, n)));
  }
  setColor(index: number, value: string): void {
    const colors = [...this.draft().colors];
    colors[index] = value;
    this.setConfig('colors', colors);
  }
  addColor(): void {
    const colors = this.draft().colors;
    if (colors.length >= 12) return;
    this.setConfig('colors', [...colors, colors[colors.length % Math.max(1, colors.length)] ?? '#7c3aed']);
  }
  removeColor(index: number): void {
    const colors = this.draft().colors;
    if (colors.length <= 1) return;
    this.setConfig(
      'colors',
      colors.filter((_, i) => i !== index),
    );
  }
  paletteAt(i: number): string {
    const colors = this.draft().colors;
    return colors[i % colors.length];
  }
  samePalette(colors: string[]): boolean {
    const current = this.draft().colors;
    return current.length === colors.length && current.every((c, i) => c.toLowerCase() === colors[i]);
  }
  setAutoHide(on: boolean): void {
    this.setConfig('hideAfterSeconds', on ? (this.lastHide ?? 10) : null);
  }
  private lastHide: number | null = null;
  setHideSeconds(value: string): void {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return;
    this.lastHide = Math.min(3600, Math.max(1, n));
    this.setConfig('hideAfterSeconds', this.lastHide);
  }
  designCapacity(design: RouletteDesign): number {
    return design === 'cards' ? 100 : capacityFor(design, 'large');
  }
  sizeBlocked(size: CardSize): boolean {
    return this.copies() > capacityFor('cards', size);
  }
  designBlocked(design: RouletteDesign): boolean {
    return this.copies() > this.designCapacity(design);
  }

  // Prizes
  openPrize(item: RouletteItem | null): void {
    this.prizeSubmitted.set(false);
    this.itemForm.reset(
      item
        ? { label: item.label, multiplier: item.multiplier, weight: item.weight, action: item.action ?? '' }
        : { label: '', multiplier: 1, weight: 1, action: '' },
    );
    this.prizeDialog.set({ item });
    this.focusSoon('#rl-prize-label');
  }
  step(field: 'multiplier' | 'weight', delta: number): void {
    const control = this.itemForm.controls[field];
    control.setValue(Math.max(1, Math.floor(Number(control.value) || 0) + delta));
  }
  async saveItem(): Promise<void> {
    this.prizeSubmitted.set(true);
    if (this.itemForm.invalid || this.prizePreview().over) return;
    const id = this.prizeDialog()?.item?.id;
    const value = this.itemForm.getRawValue();
    if (
      await this.mutate(
        id ? 'PATCH' : 'POST',
        `/roulettes/${this.selectedId()}/items${id ? '/' + id : ''}`,
        { ...value, label: value.label.trim(), action: value.action.trim() },
      )
    )
      this.prizeDialog.set(null);
  }
  async confirmRemoveItem(): Promise<void> {
    const item = this.removing();
    if (!item) return;
    if (await this.mutate('DELETE', `/roulettes/${this.selectedId()}/items/${item.id}`))
      this.removing.set(null);
  }

  // Roulette
  async remove(): Promise<void> {
    if (await this.mutate('DELETE', `/roulettes/${this.selectedId()}`)) this.deleteOpen.set(false);
  }
  async action(action: string): Promise<void> {
    if (action === 'start' && this.targetUser.invalid) return;
    await this.mutate(
      'POST',
      `/actions/${action}`,
      ['show', 'hide'].includes(action)
        ? {}
        : {
            roulette: this.selectedId(),
            ...(action === 'start' && this.targetUser.value.trim()
              ? { user: this.targetUser.value.trim() }
              : {}),
          },
    );
  }
  async token(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const { token } = await this.api.write<{ token: string }>(
        this.channel,
        'POST',
        '/overlay-token',
        {},
      );
      const url = `${location.origin}/overlays/roulette/${this.channel}#${token}`;
      this.overlayUrl.set(url);
      this.rotateOpen.set(false);
      try {
        localStorage.setItem(`roulette.overlay.${this.channel}`, url);
      } catch {
        /* copy remains available */
      }
      await this.refresh(false);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.busy.set(false);
    }
  }
  async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notice.set(this.t('copied'));
    } catch {
      this.error.set(this.t('copyError'));
    }
  }
  upgradePlan(): void {
    void this.upgrade.promptUpgradeForModule({ moduleId: 'roulette', source: 'roulette_alpha' });
  }
  closeTop(): void {
    if (this.removing()) this.removing.set(null);
    else if (this.rotateOpen()) this.rotateOpen.set(false);
    else if (this.deleteOpen()) this.deleteOpen.set(false);
    else if (this.prizeDialog()) this.prizeDialog.set(null);
    else if (this.createOpen()) this.createOpen.set(false);
  }
  private focusSoon(selector: string): void {
    setTimeout(() => this.host.nativeElement.querySelector(selector)?.focus(), 0);
  }

  // Display helpers
  actionStatus(drawId: string): string {
    const run = this.state()?.actionRuns?.find((a) => a.drawId === drawId);
    return run ? this.t('actionStatus.' + run.status) : '';
  }
  private pct(ratio: number): string {
    const value = ratio * 100;
    return `${value >= 10 || value === 0 ? value.toFixed(0) : value.toFixed(1)}%`;
  }
  odds(item: RouletteItem): string {
    return this.pct((item.weight * item.multiplier) / Math.max(1, this.totalWeight()));
  }
  oddsWidth(item: RouletteItem): number {
    return Math.max(2, ((item.weight * item.multiplier) / Math.max(1, this.totalWeight())) * 100);
  }
  itemColor(item: RouletteItem): string {
    const r = this.previewRoulette();
    if (!r) return '#7c3aed';
    const index = r.order.indexOf(item.copies[0] ?? '');
    return r.colors[Math.max(0, index) % r.colors.length];
  }
  ago(ts: number): string {
    const seconds = Math.max(0, ((this.state()?.serverTime ?? ts) - ts) / 1000);
    if (seconds < 60) return this.t('ago.now');
    if (seconds < 3600) return this.t('ago.minutes', { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return this.t('ago.hours', { count: Math.floor(seconds / 3600) });
    return this.t('ago.days', { count: Math.floor(seconds / 86400) });
  }
  ast(name: string): string {
    return `$(roulette.${name}${['show', 'hide'].includes(name) ? '' : ' ' + JSON.stringify(this.selected()?.alias ?? '')}${name === 'add' ? ' "VIP" 3 1' : name === 'remove' ? ' item_id' : name === 'update' ? ' item_id 3 1' : ''})`;
  }
}
