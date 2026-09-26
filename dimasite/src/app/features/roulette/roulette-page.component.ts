import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { RouletteApi, RouletteItem, RouletteState, Roulette } from './roulette-api.service';
import { RouletteDisplayComponent } from './roulette-display.component';

@Component({
  selector: 'app-roulette-page',
  imports: [ReactiveFormsModule, RouterLink, RouletteDisplayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './roulette-page.component.html',
  styleUrl: './roulette-page.component.css',
})
export class RoulettePageComponent {
  private readonly api = inject(RouletteApi);
  private readonly auth = inject(SessionAuthService);
  private readonly language = inject(LanguageService);
  private readonly upgrade = inject(UpgradeService);
  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly destroy = inject(DestroyRef);
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
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly notice = signal('');
  readonly editItemId = signal('');
  readonly confirmDelete = signal(false);
  readonly confirmRotate = signal(false);
  readonly overlayUrl = signal('');
  readonly query = signal('');
  readonly page = signal(0);
  readonly matchingItems = computed(
    () =>
      this.selected()?.items.filter((i) =>
        i.label.toLowerCase().includes(this.query().toLowerCase()),
      ) ?? [],
  );
  readonly items = computed(() =>
    this.matchingItems().slice(this.page() * 10, this.page() * 10 + 10),
  );
  readonly spinning = computed(() => this.state()?.draw?.completedAt === null);
  readonly previewDraw = computed(() =>
    this.state()?.draw?.rouletteId === this.selectedId() ? this.state()!.draw : null,
  );
  readonly copies = computed(() => this.selected()?.order.length ?? 0);
  readonly capacity = computed(() =>
    this.selected()?.design === 'reel'
      ? 60
      : this.selected()?.design === 'cards'
        ? { large: 50, medium: 75, small: 100 }[this.selected()!.cardSize]
        : 10000,
  );
  readonly totalWeight = computed(
    () => this.selected()?.items.reduce((n, i) => n + i.weight * i.multiplier, 0) ?? 0,
  );
  readonly createForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    alias: ['', [Validators.required, Validators.pattern(/^[a-z][a-z0-9_-]{0,39}$/)]],
  });
  readonly itemForm = this.fb.group({
    label: ['', [Validators.required, Validators.maxLength(120)]],
    multiplier: [1, [Validators.required, Validators.min(1)]],
    weight: [1, [Validators.required, Validators.min(1)]],
  });
  readonly config = this.fb.group({
    name: ['', Validators.required],
    alias: ['', [Validators.required, Validators.pattern(/^[a-z][a-z0-9_-]{0,39}$/)]],
    design: this.fb.control<Roulette['design']>('reel'),
    cardSize: this.fb.control<Roulette['cardSize']>('large'),
    durationSeconds: [4, [Validators.required, Validators.min(1), Validators.max(120)]],
    colors: ['#7c3aed,#b45309,#0369a1', Validators.required],
    insertion: this.fb.control<'append' | 'random'>('append'),
    duplicate: this.fb.control<'separate' | 'increase'>('separate'),
    shuffleBeforeDraw: false,
    showOnStart: true,
    hideAfterSeconds: this.fb.control<number | null>(null, [
      Validators.min(1),
      Validators.max(3600),
    ]),
    winnerAction: this.fb.control<Roulette['settings']['winnerAction']>('keep'),
  });
  private channel = '';
  private disposed = false;
  private refreshTask: Promise<void> | null = null;
  constructor() {
    const timer = setInterval(() => {
      if (this.channel && !this.busy()) void this.refresh(false);
    }, 2000);
    this.destroy.onDestroy(() => {
      this.disposed = true;
      clearInterval(timer);
    });
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
      if (!state.roulettes.some((r) => r.id === this.selectedId()))
        this.select(state.activeId ?? state.roulettes[0]?.id ?? '');
      else if (!this.config.dirty) this.loadConfig();
      if (clear) this.error.set('');
    } catch (e) {
      this.handleError(e);
    }
  }
  select(id: string): void {
    this.selectedId.set(id);
    this.loadConfig();
    this.cancelItem();
    this.query.set('');
    this.page.set(0);
    this.confirmDelete.set(false);
  }
  private loadConfig(): void {
    const r = this.selected();
    if (!r) return;
    this.config.reset({
      name: r.name,
      alias: r.alias,
      design: r.design,
      cardSize: r.cardSize,
      durationSeconds: r.durationSeconds,
      colors: r.colors.join(','),
      ...r.settings,
    });
  }
  private handleError(e: unknown): void {
    const status = e instanceof HttpErrorResponse ? e.status : 0;
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
  async create(): Promise<void> {
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }
    const before = new Set(this.state()?.roulettes.map((r) => r.id));
    if (
      await this.mutate('POST', '/roulettes', { ...this.createForm.getRawValue(), design: 'reel' })
    ) {
      const created = this.state()?.roulettes.find((r) => !before.has(r.id));
      if (created) this.select(created.id);
      this.createForm.reset();
    }
  }
  async saveConfig(): Promise<void> {
    if (this.config.invalid || !this.selected()) return;
    const { name, alias, design, cardSize, durationSeconds, colors, ...settings } =
      this.config.getRawValue();
    if (
      await this.mutate('PATCH', `/roulettes/${this.selectedId()}`, {
        name,
        alias,
        design,
        cardSize,
        durationSeconds,
        colors: colors.split(',').map((c) => c.trim()),
        settings,
      })
    ) {
      this.config.markAsPristine();
      this.loadConfig();
      this.notice.set(this.t('saved'));
    }
  }
  edit(item: RouletteItem): void {
    this.editItemId.set(item.id);
    this.itemForm.reset({ label: item.label, multiplier: item.multiplier, weight: item.weight });
  }
  cancelItem(): void {
    this.editItemId.set('');
    this.itemForm.reset({ label: '', multiplier: 1, weight: 1 });
  }
  async saveItem(): Promise<void> {
    if (this.itemForm.invalid) return;
    const id = this.editItemId();
    if (
      await this.mutate(
        id ? 'PATCH' : 'POST',
        `/roulettes/${this.selectedId()}/items${id ? '/' + id : ''}`,
        this.itemForm.getRawValue(),
      )
    )
      this.cancelItem();
  }
  async removeItem(id: string): Promise<void> {
    if (await this.mutate('DELETE', `/roulettes/${this.selectedId()}/items/${id}`)) {
      if (this.editItemId() === id) this.cancelItem();
      this.page.set(0);
    }
  }
  async remove(): Promise<void> {
    if (await this.mutate('DELETE', `/roulettes/${this.selectedId()}`))
      this.confirmDelete.set(false);
  }
  async action(action: string): Promise<void> {
    await this.mutate(
      'POST',
      `/actions/${action}`,
      ['show', 'hide'].includes(action) ? {} : { roulette: this.selectedId() },
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
      this.confirmRotate.set(false);
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
  odds(item: RouletteItem): string {
    return `${(((item.weight * item.multiplier) / Math.max(1, this.totalWeight())) * 100).toFixed(1)}%`;
  }
  ast(name: string): string {
    return `$(roulette.${name}${['show', 'hide'].includes(name) ? '' : ' ' + JSON.stringify(this.selected()?.alias ?? '')}${name === 'add' ? ' "VIP" 3 1' : name === 'remove' ? ' item_id' : name === 'update' ? ' item_id 3 1' : ''})`;
  }
}
