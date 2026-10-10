import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { MODULE_TIER_REQUIREMENTS, isModuleAccessible } from '../modules/module-tier.model';
import { DuelApi, DuelLeaderboard, DuelState } from './duel/duel-api.service';
import { DuelFighterComponent } from './duel/duel-fighter.component';
import { CHARACTERS, DuelCharacter } from './duel/duel-battle';
import { isDefaultDuelRules } from './duel/duel-rules';
import { WidgetStreakComponent } from './widget-streak.component';
import { WidgetsApi, WidgetState } from './widgets-api.service';

type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error' };

/** Widget hub: every game widget as a card that answers "is it on stream, and how is it doing?". */
@Component({ selector: 'app-widgets-hub', imports: [RouterLink, LfIconComponent, DuelFighterComponent, WidgetStreakComponent], templateUrl: './widgets-hub.component.html', styleUrl: './widgets-hub.component.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetsHubComponent {
  private readonly auth = inject(SessionAuthService);
  private readonly upgrade = inject(UpgradeService);
  private readonly duelApi = inject(DuelApi);
  private readonly widgetsApi = inject(WidgetsApi);
  readonly language = inject(LanguageService);
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly premium = computed(() => isModuleAccessible(MODULE_TIER_REQUIREMENTS.widgets, this.auth.getPlanTierForStreamer(this.streamer)));
  readonly duel = signal<Load<DuelState>>({ status: 'loading' });
  readonly board = signal<Load<DuelLeaderboard>>({ status: 'loading' });
  readonly dbd = signal<Load<WidgetState>>({ status: 'loading' });
  /** A different matchup on every visit, like the real arena. */
  readonly fighters = pickFighters();
  readonly roles = ['killer', 'survivor'] as const;
  private stopped = false;

  readonly duelState = computed(() => { const load = this.duel(); return load.status === 'ready' ? load.value : null; });
  readonly dbdState = computed(() => { const load = this.dbd(); return load.status === 'ready' ? load.value : null; });
  readonly topFighter = computed(() => { const load = this.board(); return load.status === 'ready' ? load.value.players[0] ?? null : null; });
  readonly duels = computed(() => { const load = this.board(); return load.status === 'ready' ? load.value.duels : null; });
  readonly customRules = computed(() => { const state = this.duelState(); return !!state && !isDefaultDuelRules(state.settings.rules); });
  /** 'obs' when the arena plays in OBS, 'chat' when fights fall back to chat text, 'off' when !duel is off. */
  readonly duelMode = computed(() => { const state = this.duelState(); return !state ? null : !state.settings.enabled ? 'off' : state.connected ? 'obs' : 'chat'; });
  readonly live = computed(() => (this.duelMode() === 'obs' ? 1 : 0) + (this.dbdState()?.visible ? 1 : 0));
  readonly loaded = computed(() => this.duel().status !== 'loading' && this.dbd().status !== 'loading');

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.stopped = true; });
    void this.load();
  }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('widgets.' + key, params); }
  d(key: string, params?: Record<string, string | number>): string { return this.language.translate('duelWidget.' + key, params); }
  promptUpgrade(): void { void this.upgrade.promptUpgradeForModule({ moduleId: 'widgets', source: 'widgets_hub' }); }
  kd(value: number): string { return new Intl.NumberFormat(this.language.currentLanguage(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }

  /** Each card loads on its own: one failing API never hides the other widget. */
  private async load(): Promise<void> {
    let channel = '';
    try { channel = (await firstValueFrom(this.auth.resolveChannelID(this.streamer))) ?? ''; } catch { /* handled below */ }
    if (this.stopped || channel && !this.premium()) return;
    if (!channel) { this.duel.set({ status: 'error' }); this.board.set({ status: 'error' }); this.dbd.set({ status: 'error' }); return; }
    const settle = <T>(target: (value: Load<T>) => void, request: Promise<T>) => request.then(value => { if (!this.stopped) target({ status: 'ready', value }); }, () => { if (!this.stopped) target({ status: 'error' }); });
    await Promise.all([
      settle(value => this.duel.set(value), this.duelApi.read(channel)),
      settle(value => this.board.set(value), this.duelApi.leaderboard(channel)),
      settle(value => this.dbd.set(value), this.widgetsApi.read(channel))
    ]);
  }
}

function pickFighters(): Record<'left' | 'right', DuelCharacter> {
  const left = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)], rest = CHARACTERS.filter(character => character !== left);
  return { left, right: rest[Math.floor(Math.random() * rest.length)] };
}
