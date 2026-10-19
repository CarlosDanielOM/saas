import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ModerationActionLogEntry } from '../../../models/moderation.model';
import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { AutomodWeek, SANCTION_ACTIONS, pctChange } from '../dashboard-week.util';

export type ModLoad = 'loading' | 'ready' | 'error';

/**
 * Bot-side moderation cards on the dashboard: this week's automod summary
 * and the latest sanctions. Data is loaded by the page; tokens come from it.
 */
@Component({
  selector: 'app-dashboard-moderation-card',
  imports: [RouterLink, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hc__head">
      <span class="hc__icon" [attr.data-kind]="kind()" aria-hidden="true">
        <app-lf-icon [name]="kind() === 'automod' ? 'shield' : 'alert'" [size]="16"></app-lf-icon>
      </span>
      <h3 class="hc__title" [id]="headingId()">{{ t('dashboard.brief.mod.' + kind() + '.title') }}</h3>
      <span class="hc__when">{{ t('dashboard.brief.mod.' + kind() + '.when') }}</span>
    </div>

    @if (state() === 'loading') {
      <p class="hc__line">{{ t('dashboard.loading') }}</p>
    } @else if (state() === 'error') {
      <p class="hc__line">{{ t('dashboard.brief.mod.error') }}</p>
      <a class="hc__lnk" [routerLink]="link()">{{ t('dashboard.brief.mod.open') }}</a>
    } @else if (kind() === 'automod') {
      @if (enabled() === false) {
        <p class="hc__say hc__say--warn">{{ t('dashboard.brief.mod.automod.off') }}</p>
        <p class="hc__line">{{ t('dashboard.brief.mod.automod.offSub') }}</p>
        <div class="hc__actions"><a class="hc__btn hc__btn--primary" [routerLink]="link()">{{ t('dashboard.brief.mod.automod.turnOn') }}</a></div>
      } @else if (!week().actions) {
        <p class="hc__say">{{ t('dashboard.brief.mod.automod.none') }}</p>
        <p class="hc__line">{{ t('dashboard.brief.mod.automod.noneSub') }}</p>
      } @else {
        <p class="hc__say">{{ t(week().actions === 1 ? 'dashboard.brief.mod.automod.sayOne' : 'dashboard.brief.mod.automod.say', { count: count() }) }}</p>
        @if (change() !== null) {
          <p class="hc__line">{{ t('dashboard.brief.mod.automod.change', { change: signed(change()!) }) }}</p>
        }
        <div class="hc__stack" role="img" [attr.aria-label]="ruleAria()">
          @for (r of week().byRule; track r.key) {
            <span [attr.data-rule]="r.key" [style.flex-grow]="r.hits"></span>
          }
        </div>
        <ul class="hc__legend">
          @for (r of week().byRule; track r.key) {
            <li><span class="hc__swatch" [attr.data-rule]="r.key" aria-hidden="true"></span>{{ t('moderation.types.' + r.key) }} <b>{{ r.hits }}</b></li>
          }
        </ul>
        <dl class="hc__facts">
          @for (a of actions; track a) {
            <div><dt>{{ t('dashboard.brief.mod.did.' + a) }}</dt><dd>{{ week().byAction[a] }}</dd></div>
          }
        </dl>
        @if (week().repeat[0]; as o) {
          <p class="hc__note">
            <app-lf-icon name="alert" [size]="14"></app-lf-icon>
            <span>{{ t('dashboard.brief.mod.automod.repeat', { user: o.user, count: o.count }) }} <a class="hc__lnk" [routerLink]="link()">{{ t('dashboard.brief.mod.open') }}</a></span>
          </p>
        }
      }
    } @else {
      @if (latest().length) {
        <ul class="hc__rows">
          @for (s of latest(); track s._id ?? $index) {
            <li class="hs">
              <span class="hs__avatar" aria-hidden="true">{{ (s.username || '?').charAt(0).toUpperCase() }}</span>
              <span class="hs__who">
                <strong>{{ s.username || s.userID }}</strong>
                <span>{{ t('moderation.types.' + s.ruleType) }} · {{ t('dashboard.brief.mod.sanctions.offense', { n: s.offenseNumber }) }} · {{ date(s.createdAt) }}</span>
              </span>
              <span class="hs__action" [attr.data-action]="s.action">{{ t('dashboard.brief.mod.one.' + s.action) }}</span>
            </li>
          }
        </ul>
      } @else {
        <p class="hc__line">{{ t('dashboard.brief.mod.sanctions.none') }}</p>
      }
      <a class="hc__lnk" [routerLink]="link()">{{ t('dashboard.brief.mod.sanctions.all') }}</a>
    }
  `,
  styles: `
    :host { display: grid; gap: 0.7rem; align-content: start; min-width: 0; }
    :host *, :host *::before, :host *::after { box-sizing: border-box; }
    .hc__head { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
    .hc__icon {
      display: grid; place-items: center; flex: none; width: 1.9rem; height: 1.9rem; border-radius: 0.65rem;
      color: var(--accent); background: var(--accent-soft);
    }
    .hc__icon[data-kind='sanctions'] { color: var(--warn); background: var(--warn-soft); }
    .hc__title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 0.95rem; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hc__when { flex: none; color: var(--muted); font-size: 0.72rem; font-weight: 700; }
    .hc__say { margin: 0; font-size: 1rem; font-weight: 750; line-height: 1.35; }
    .hc__say--warn { color: var(--warn); }
    .hc__line { margin: 0; color: var(--muted); font-size: 0.82rem; line-height: 1.45; }
    .hc__note {
      display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 0.45rem; margin: 0;
      padding: 0.55rem 0.7rem; border-radius: 0.8rem; background: var(--input-bg); font-size: 0.82rem; line-height: 1.45;
    }
    .hc__note app-lf-icon { margin-top: 0.15rem; color: var(--accent); }
    .hc__actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
    .hc__btn {
      display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 0.35rem 0.95rem;
      border: 1px solid var(--btn-border); border-radius: 999px; color: var(--fg); background: var(--btn);
      font-size: 0.82rem; font-weight: 700; text-decoration: none;
    }
    .hc__btn--primary { color: #fff; background: #7c3aed; border-color: #7c3aed; }
    .hc__lnk { justify-self: start; color: var(--accent); font-size: 0.82rem; font-weight: 700; text-decoration: none; }
    .hc__lnk:hover { text-decoration: underline; }
    .hc__btn:focus-visible, .hc__lnk:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .hc__stack { display: flex; gap: 2px; height: 0.75rem; overflow: hidden; border-radius: 999px; }
    .hc__stack span { flex: 1 1 0; min-width: 4px; }
    .hc__stack span, .hc__swatch { background: #7c3aed; }
    .hc__stack [data-rule='caps'], .hc__swatch[data-rule='caps'] { background: #db2777; }
    .hc__stack [data-rule='emote_spam'], .hc__swatch[data-rule='emote_spam'] { background: #0891b2; }
    .hc__stack [data-rule='blacklist'], .hc__swatch[data-rule='blacklist'] { background: #d97706; }
    .hc__legend { display: flex; flex-wrap: wrap; gap: 0.3rem 0.85rem; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 0.78rem; font-weight: 650; }
    .hc__legend li { display: inline-flex; align-items: center; gap: 0.35rem; }
    .hc__legend b { color: var(--fg); font-variant-numeric: tabular-nums; }
    .hc__swatch { width: 0.6rem; height: 0.6rem; border-radius: 3px; }
    .hc__facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.4rem; margin: 0; }
    .hc__facts div { display: grid; gap: 0.05rem; min-width: 0; padding: 0.45rem 0.5rem; border-radius: 0.7rem; background: var(--input-bg); }
    .hc__facts dt { color: var(--muted); font-size: 0.68rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hc__facts dd { margin: 0; font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; }

    .hc__rows { display: grid; gap: 0.3rem; margin: 0; padding: 0; list-style: none; }
    .hs { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.55rem; padding: 0.35rem 0; border-top: 1px solid var(--line); }
    .hc__rows > li:first-child { border-top: 0; }
    .hs__avatar {
      display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: 999px;
      color: #fff; background: linear-gradient(135deg, #475569, #64748b); font-size: 0.8rem; font-weight: 800;
    }
    .hs__who { display: grid; min-width: 0; line-height: 1.25; }
    .hs__who strong { font-size: 0.86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hs__who span { color: var(--muted); font-size: 0.73rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hs__action {
      padding: 0.15rem 0.55rem; border: 1px solid var(--line); border-radius: 999px;
      color: var(--muted); background: var(--input-bg); font-size: 0.72rem; font-weight: 800; white-space: nowrap;
    }
    .hs__action[data-action='timeout'] { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
    .hs__action[data-action='ban'] { color: var(--danger); background: var(--live-soft); border-color: transparent; }
  `
})
export class DashboardModerationCardComponent {
  private readonly language = inject(LanguageService);

  readonly kind = input.required<'automod' | 'sanctions'>();
  readonly state = input<ModLoad>('loading');
  readonly week = input.required<AutomodWeek>();
  readonly logs = input<ModerationActionLogEntry[]>([]);
  readonly enabled = input<boolean | null>(null);
  readonly link = input.required<string[]>();
  readonly headingId = input('');

  readonly actions = SANCTION_ACTIONS;
  readonly latest = computed(() => this.logs().slice(0, 6));
  readonly count = computed(() => `${this.week().actions}${this.week().capped ? '+' : ''}`);
  readonly change = computed(() => {
    const prev = this.week().prevActions;
    return prev === null || this.week().capped ? null : pctChange(this.week().actions, prev);
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  signed(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}%`;
  }

  date(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(this.language.currentLanguage() === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric' });
  }

  ruleAria(): string {
    return this.week().byRule.map((r) => `${this.t('moderation.types.' + r.key)}: ${r.hits}`).join(', ');
  }
}
