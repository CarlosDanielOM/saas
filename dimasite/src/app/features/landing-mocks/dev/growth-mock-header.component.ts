import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GAME_LABELS, GROWTH_CHANNEL, GROWTH_STREAMS, LIVE_SESSION, creditsFor, fmt, hoursLabel, shortDate } from './growth-mock-data';

/**
 * Shared top of the growth dashboard proposals: mock state switcher, compact
 * channel header with the one bot control, and the live strip while streaming.
 * The page's plain-language answer is projected in with [answer].
 */
@Component({
  selector: 'app-growth-mock-header',
  imports: [RouterLink, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./dashboard-mock.shared.css'],
  template: `
    <div class="devbar" role="group" [attr.aria-label]="t('devMocks.growth.devbar')">
      <span>{{ t('devMocks.growth.devbar') }}</span>
      <div class="seg">
        <button type="button" [attr.aria-pressed]="!live()" (click)="live.set(false)">{{ t('devMocks.growth.offline') }}</button>
        <button type="button" [attr.aria-pressed]="live()" (click)="live.set(true)">{{ t('devMocks.growth.live') }}</button>
      </div>
      <div class="seg">
        <button type="button" [attr.aria-pressed]="plan() === 'free'" (click)="plan.set('free')">Free</button>
        <button type="button" [attr.aria-pressed]="plan() === 'pro'" (click)="plan.set('pro')">Pro</button>
      </div>
      <ng-content select="[devbar]"></ng-content>
    </div>

    <header class="gh">
      <span class="gh__avatar" [class.gh__avatar--live]="live()" aria-hidden="true">N</span>
      <div class="gh__copy">
        <h1 class="gh__title">{{ channel.name }}</h1>
        <div class="chips">
          @if (live()) {
            <span class="chip chip--live"><span class="dot dot--pulse" aria-hidden="true"></span>{{ t('devMocks.growth.liveFor', { time: liveTime }) }}</span>
          } @else {
            <span class="chip">{{ t('devMocks.growth.lastStream', { date: lastDate() }) }}</span>
          }
          <span class="chip" [class.chip--ok]="botOn()" [class.chip--warn]="!botOn()">
            <span class="dot" aria-hidden="true"></span>{{ botOn() ? t('devMocks.growth.botIn') : t('devMocks.growth.botOut') }}
          </span>
          <span class="chip" [class.chip--gold]="plan() === 'pro'">{{ plan() === 'pro' ? 'Pro' : 'Free' }}</span>
        </div>
      </div>
      <button type="button" class="btn btn--sm gh__bot" [class.btn--primary]="!botOn()" (click)="botOn.set(!botOn())">
        {{ botOn() ? t('dashboard.quickActions.leaveChat') : t('dashboard.quickActions.joinBot') }}
      </button>
      <div class="gh__answer">
        @if (!botOn()) {
          <p class="gh__warn" role="status"><app-lf-icon name="alert" [size]="16"></app-lf-icon>{{ t('devMocks.growth.botOffWarn') }}</p>
        }
        <ng-content select="[answer]"></ng-content>
      </div>
    </header>

    @if (live()) {
      <section class="gl" [attr.aria-label]="t('devMocks.growth.liveLabel')">
        <div class="gl__head">
          <span class="gl__badge"><span class="dot dot--pulse" aria-hidden="true"></span>{{ t('devMocks.growth.live') }}</span>
          <span class="gl__title">{{ live$.title }}</span>
          <span class="gl__game">{{ gameName }}</span>
        </div>
        <dl class="gl__facts">
          <div><dt>{{ t('devMocks.growth.f.watching') }}</dt><dd>{{ live$.viewers }}</dd></div>
          <div><dt>{{ t('devMocks.growth.f.peak') }}</dt><dd>{{ live$.peak }}</dd></div>
          <div><dt>{{ t('devMocks.growth.f.follows') }}</dt><dd>+{{ live$.follows }}</dd></div>
          <div><dt>{{ t('devMocks.growth.f.subs') }}</dt><dd>+{{ live$.subs }}</dd></div>
          <div><dt>{{ t('devMocks.growth.f.bits') }}</dt><dd>{{ n(live$.bits) }}</dd></div>
        </dl>
        <a class="lnk gl__link" [routerLink]="['/mocks/dev/prod-modules']">{{ t('devMocks.growth.openTimeline') }} →</a>
      </section>
    }
  `,
  styles: `
    :host { display: grid; gap: 1rem; }
    .gh { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.55rem 0.85rem; }
    .gh__avatar {
      display: grid; place-items: center; width: 3.1rem; height: 3.1rem; border-radius: 999px;
      color: #fff; background: linear-gradient(135deg, #7c3aed, #db2777); font-size: 1.3rem; font-weight: 800;
    }
    .gh__avatar--live { box-shadow: 0 0 0 3px var(--bg), 0 0 0 5px #ef4444; }
    .gh__copy { display: grid; gap: 0.3rem; min-width: 0; }
    .gh__title { margin: 0; font-size: clamp(1.4rem, 5vw, 1.9rem); font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; }
    .gh__bot { grid-column: 1 / -1; justify-self: start; }
    .gh__answer { grid-column: 1 / -1; display: grid; gap: 0.5rem; }
    .gh__warn {
      display: flex; align-items: flex-start; gap: 0.45rem; margin: 0; padding: 0.6rem 0.8rem;
      border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); border-radius: 0.9rem;
      color: var(--warn); background: var(--warn-soft); font-size: 0.86rem; font-weight: 650; line-height: 1.45;
    }
    .gh__warn app-lf-icon { flex: none; margin-top: 0.1rem; }

    .gl {
      display: grid; gap: 0.65rem; padding: 0.9rem 1rem;
      border: 1px solid rgba(239, 68, 68, 0.35); border-radius: var(--radius);
      background: linear-gradient(120deg, var(--live-soft), transparent 70%), var(--tile);
    }
    .gl__head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; min-width: 0; }
    .gl__badge {
      display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.6rem; border-radius: 999px;
      color: #fff; background: #dc2626; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
    }
    .gl__badge .dot { color: #fff; }
    .gl__title { min-width: 0; font-weight: 750; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 12rem; }
    .gl__game { color: var(--muted); font-size: 0.8rem; font-weight: 650; }
    .gl__facts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.4rem; margin: 0; }
    .gl__facts div { display: grid; gap: 0.05rem; min-width: 0; }
    .gl__facts dt { color: var(--muted); font-size: 0.68rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gl__facts dd { margin: 0; font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .gl__link { justify-self: start; }

    @media (min-width: 640px) {
      .gh { grid-template-columns: auto minmax(0, 1fr) auto; }
      .gh__bot { grid-column: 3; grid-row: 1; justify-self: end; }
      .gh__answer { grid-column: 2 / -1; }
      .gl { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
      .gl__head { grid-column: 1 / -1; }
      .gl__facts { gap: 1rem; }
      .gl__facts dd { font-size: 1.25rem; }
    }
  `
})
export class GrowthMockHeaderComponent {
  private readonly language = inject(LanguageService);
  readonly live = model(false);
  readonly plan = model<'free' | 'pro'>('pro');
  readonly botOn = model(true);

  readonly channel = GROWTH_CHANNEL;
  readonly live$ = LIVE_SESSION;
  readonly liveTime = hoursLabel(LIVE_SESSION.minutes / 60);
  readonly gameName = GAME_LABELS[LIVE_SESSION.game];
  readonly lastDate = computed(() => shortDate(GROWTH_STREAMS[GROWTH_STREAMS.length - 1].date, this.language.currentLanguage()));

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(value: number): string {
    return fmt(value, this.language.currentLanguage());
  }
}

/** One-line AI credits forecast with the top-up action beside it. */
@Component({
  selector: 'app-growth-mock-credits',
  imports: [RouterLink, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./dashboard-mock.shared.css'],
  template: `
    <section class="lf-tile gc" [class.gc--warn]="!c().lastsUntilReset" [attr.aria-label]="t('devMocks.growth.credits.title')">
      <span class="gc__icon" aria-hidden="true"><app-lf-icon name="zap" [size]="18"></app-lf-icon></span>
      <div class="gc__copy">
        <p class="gc__title">{{ t('devMocks.growth.credits.title') }} <span class="gc__left">{{ t('devMocks.growth.credits.left', { left: n(c().left) }) }}</span></p>
        <p class="gc__line">
          @if (c().lastsUntilReset) {
            {{ t('devMocks.growth.credits.fine', { days: c().daysToReset }) }}
          } @else {
            {{ t(c().daysToReset - c().daysLeft === 1 ? 'devMocks.growth.credits.shortOne' : 'devMocks.growth.credits.short', { days: c().daysLeft, gap: c().daysToReset - c().daysLeft }) }}
          }
        </p>
        <div class="bar" [class.bar--warn]="!c().lastsUntilReset" aria-hidden="true"><span [style.width.%]="c().pctLeft"></span></div>
      </div>
      <div class="gc__actions">
        <a class="btn btn--sm btn--ghost" [routerLink]="['/mocks/dev/prod-settings']">{{ t('devMocks.growth.credits.usage') }}</a>
        <a class="btn btn--sm" [class.btn--primary]="!c().lastsUntilReset" [routerLink]="['/mocks/dev/prod-settings']">{{ t('devMocks.growth.credits.buy') }}</a>
      </div>
    </section>
  `,
  styles: `
    :host { display: block; container-type: inline-size; }
    .gc { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.6rem 0.8rem; align-items: center; padding: 0.85rem 1rem; }
    .gc__icon { display: grid; place-items: center; width: 2.4rem; height: 2.4rem; border-radius: 0.8rem; color: var(--accent); background: var(--accent-soft); }
    .gc--warn .gc__icon { color: var(--warn); background: var(--warn-soft); }
    .gc__copy { display: grid; gap: 0.3rem; min-width: 0; }
    .gc__title { margin: 0; font-weight: 800; font-size: 0.92rem; }
    .gc__left { color: var(--muted); font-weight: 650; }
    .gc__line { margin: 0; color: var(--muted); font-size: 0.84rem; line-height: 1.45; }
    .gc--warn .gc__line { color: var(--warn); font-weight: 650; }
    .gc .bar { height: 0.35rem; }
    .gc__actions { grid-column: 1 / -1; display: flex; gap: 0.4rem; justify-content: flex-end; }
    @container (min-width: 600px) {
      .gc { grid-template-columns: auto minmax(0, 1fr) auto; }
      .gc__actions { grid-column: 3; }
    }
  `
})
export class GrowthMockCreditsComponent {
  private readonly language = inject(LanguageService);
  readonly plan = input<'free' | 'pro'>('pro');
  readonly c = computed(() => creditsFor(this.plan()));

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(value: number): string {
    return fmt(value, this.language.currentLanguage());
  }
}
