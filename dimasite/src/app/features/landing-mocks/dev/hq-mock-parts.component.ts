import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { LfIconComponent, LfIconName } from '../../../shared/lf-icon/lf-icon.component';
import { creditsFor, fmt, shortDate, weekdayName } from './growth-mock-data';
import {
  AUTOMOD_WEEK,
  ActionKey,
  BOT_STATUS,
  Habit,
  MODULES,
  MOST_USED,
  ModuleKey,
  SANCTIONS,
  TOP_COMMANDS,
  TOP_EMOTES,
  UNUSED_COMMANDS,
  UsageRow,
  change,
  emoteUrl,
  mostWatchedGames,
  raidSummary,
  repeatOffenders
} from './hq-mock-data';
import { weekdayStats } from './growth-mock-data';

export type CardKind = 'bot' | 'credits' | 'automod' | 'sanctions' | 'commands' | 'emotes' | 'games' | 'days' | 'raids';
export type CardSize = 's' | 'm';

/** Cards that are about the bot (always-there info) vs the channel. */
export const BOT_CARDS: CardKind[] = ['bot', 'credits', 'automod', 'sanctions', 'commands', 'emotes'];
export const CHANNEL_CARDS: CardKind[] = ['games', 'days', 'raids'];
/** The streamer's brief: these can't be hidden. */
export const PINNED_CARDS: CardKind[] = ['bot', 'credits'];

export const CARD_ICONS: Record<CardKind, LfIconName> = {
  bot: 'check',
  credits: 'zap',
  automod: 'shield',
  sanctions: 'alert',
  commands: 'terminal',
  emotes: 'smile',
  games: 'gamepad',
  days: 'calendar',
  raids: 'users'
};

/** Shared text helpers for the proposal parts. */
abstract class HqText {
  protected readonly language = inject(LanguageService);
  readonly lang = computed(() => this.language.currentLanguage());

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(v: number, digits = 0): string {
    return fmt(v, this.lang(), digits);
  }

  date(iso: string): string {
    return shortDate(iso, this.lang());
  }

  day(weekday: number, style: 'short' | 'long' = 'short'): string {
    return weekdayName(weekday, this.lang(), style);
  }

  signedPct(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
  }
}

/**
 * One card body for the channel + bot dashboards. The page decides the
 * wrapper (tile, widget, row) and which size to show.
 */
@Component({
  selector: 'app-hq-card',
  imports: [RouterLink, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./hq-mock-card.css'],
  template: `
    <div class="hc__head">
      <span class="hc__icon" [attr.data-kind]="kind()" aria-hidden="true"><app-lf-icon [name]="icon()" [size]="16"></app-lf-icon></span>
      <h3 class="hc__title" [id]="headingId()">{{ t('devMocks.hq.card.' + kind() + '.title') }}</h3>
      <span class="hc__when">{{ t('devMocks.hq.card.' + kind() + '.when') }}</span>
    </div>

    @switch (kind()) {
      @case ('bot') {
        <p class="hc__say" [class.hc__say--warn]="!botOn()">{{ botOn() ? t('devMocks.hq.card.bot.ok') : t('devMocks.hq.card.bot.off') }}</p>
        <ul class="hc__checks">
          <li [class.bad]="!botOn()">
            <app-lf-icon [name]="botOn() ? 'check' : 'alert'" [size]="14"></app-lf-icon>{{ botOn() ? t('devMocks.hq.card.bot.inChat') : t('devMocks.hq.card.bot.outChat') }}
          </li>
          <li><app-lf-icon name="check" [size]="14"></app-lf-icon>{{ t('devMocks.hq.card.bot.events', { on: bot.eventsOn, total: bot.eventsTotal }) }}</li>
          @if (size() === 'm') {
            <li><app-lf-icon name="check" [size]="14"></app-lf-icon>{{ t('devMocks.hq.card.bot.replies', { count: n(bot.repliesWeek) }) }}</li>
            <li><app-lf-icon name="check" [size]="14"></app-lf-icon>{{ t('devMocks.hq.card.bot.uptime', { days: bot.uptimeDays }) }}</li>
          }
        </ul>
      }

      @case ('credits') {
        <p class="hc__big">{{ n(credits().left) }} <small>{{ t('devMocks.hq.card.credits.left', { pct: credits().pctLeft }) }}</small></p>
        <div class="hc__meter" [class.hc__meter--warn]="!credits().lastsUntilReset" aria-hidden="true"><span [style.width.%]="credits().pctLeft"></span></div>
        <p class="hc__line" [class.hc__line--warn]="!credits().lastsUntilReset">
          @if (credits().lastsUntilReset) {
            {{ t('devMocks.growth.credits.fine', { days: credits().daysToReset }) }}
          } @else {
            {{ t(credits().daysToReset - credits().daysLeft === 1 ? 'devMocks.growth.credits.shortOne' : 'devMocks.growth.credits.short', { days: credits().daysLeft, gap: credits().daysToReset - credits().daysLeft }) }}
          }
        </p>
        <div class="hc__actions">
          <a class="hc__btn" [class.hc__btn--primary]="!credits().lastsUntilReset" routerLink="/mocks/dev/prod-settings">{{ t('devMocks.growth.credits.buy') }}</a>
          @if (size() === 'm') {
            <a class="hc__lnk" routerLink="/mocks/dev/prod-settings">{{ t('devMocks.growth.credits.usage') }}</a>
          }
        </div>
      }

      @case ('automod') {
        <p class="hc__say">{{ t('devMocks.hq.card.automod.say', { count: automod.actions }) }}</p>
        <p class="hc__line">{{ t('devMocks.hq.card.automod.sub', { change: automodChange, checked: n(automod.checked) }) }}</p>
        <div class="hc__stack" role="img" [attr.aria-label]="automodAria()">
          @for (r of automod.rules; track r.key) {
            <span [attr.data-rule]="r.key" [style.flex-grow]="r.hits"></span>
          }
        </div>
        <ul class="hc__legend">
          @for (r of automod.rules; track r.key) {
            <li><span class="hc__swatch" [attr.data-rule]="r.key" aria-hidden="true"></span>{{ t('moderation.types.' + r.key) }} <b>{{ r.hits }}</b></li>
          }
        </ul>
        @if (size() === 'm') {
          <dl class="hc__facts">
            @for (a of actionKeys; track a) {
              <div><dt>{{ t('devMocks.hq.card.automod.a.' + a) }}</dt><dd>{{ automod.byAction[a] }}</dd></div>
            }
          </dl>
          @if (offenders[0]; as o) {
            <p class="hc__note">
              <app-lf-icon name="alert" [size]="14"></app-lf-icon>
              <span>{{ t('devMocks.hq.card.automod.repeat', { user: o.user, count: o.count }) }} <a class="hc__lnk" routerLink="/mocks/dev/prod-modules">{{ t('devMocks.hq.card.automod.open') }}</a></span>
            </p>
          }
        }
      }

      @case ('sanctions') {
        <ul class="hc__rows">
          @for (s of sanctions(); track $index) {
            <li class="hs">
              <span class="hs__avatar" aria-hidden="true">{{ s.user.charAt(0).toUpperCase() }}</span>
              <span class="hs__who">
                <strong>{{ s.user }}</strong>
                <span>{{ t('moderation.types.' + s.rule) }} · {{ t('devMocks.hq.card.sanctions.offense', { n: s.offense }) }} · {{ date(s.date) }}</span>
              </span>
              <span class="hs__action" [attr.data-action]="s.action">{{ t('devMocks.hq.card.automod.one.' + s.action) }}</span>
            </li>
          }
        </ul>
        <a class="hc__lnk" routerLink="/mocks/dev/prod-modules">{{ t('devMocks.hq.card.sanctions.all') }}</a>
      }

      @case ('commands') {
        <ol class="hc__rows">
          @for (r of commands(); track r.name; let i = $index) {
            <li class="ht">
              <span class="ht__rank">{{ i + 1 }}</span>
              <code class="ht__name">{{ r.name }}</code>
              <span class="ht__bar" aria-hidden="true"><span [style.width.%]="(r.uses / commandMax) * 100"></span></span>
              <span class="ht__uses">{{ n(r.uses) }}</span>
              <span class="ht__chg" [class.up]="change(r) > 0" [class.down]="change(r) < 0">{{ signedPct(change(r)) }}</span>
            </li>
          }
        </ol>
        @if (size() === 'm') {
          <p class="hc__note">
            <app-lf-icon name="bulb" [size]="14"></app-lf-icon>
            <span>{{ t('devMocks.hq.card.commands.unused', { count: unused.length, list: unused.join(', ') }) }} <a class="hc__lnk" routerLink="/mocks/dev/prod-commands">{{ t('devMocks.hq.card.commands.tidy') }}</a></span>
          </p>
        }
      }

      @case ('emotes') {
        @if (size() === 's') {
          <ul class="he">
            @for (e of emotes(); track e.id) {
              <li class="he__item">
                <img class="he__img" [src]="emote(e.id)" [alt]="e.name" width="40" height="40" loading="lazy" />
                <span class="he__uses">{{ n(e.uses) }}</span>
              </li>
            }
          </ul>
        } @else {
          <ol class="hc__rows">
            @for (e of emotes(); track e.id; let i = $index) {
              <li class="ht ht--emote">
                <span class="ht__rank">{{ i + 1 }}</span>
                <img class="ht__img" [src]="emote(e.id)" alt="" width="28" height="28" loading="lazy" />
                <span class="ht__name">{{ e.name }}</span>
                <span class="ht__bar" aria-hidden="true"><span [style.width.%]="(e.uses / emoteMax) * 100"></span></span>
                <span class="ht__uses">{{ n(e.uses) }}</span>
                <span class="ht__chg" [class.up]="change(e) > 0" [class.down]="change(e) < 0">{{ signedPct(change(e)) }}</span>
              </li>
            }
          </ol>
        }
      }

      @case ('games') {
        <p class="hc__say">{{ t('devMocks.hq.card.games.say', { game: games[0].label, share: games[0].share }) }}</p>
        <ul class="hc__rows">
          @for (g of gamesShown(); track g.game; let first = $first) {
            <li class="hg" [class.hg--top]="first">
              <span class="hg__name">{{ g.label }}</span>
              <span class="hg__share">{{ g.share }}%</span>
              <span class="hg__bar" aria-hidden="true"><span [style.width.%]="(g.watched / games[0].watched) * 100"></span></span>
              @if (size() === 'm') {
                <span class="hg__nums">{{ t('devMocks.hq.card.games.nums', { hours: n(g.watched), avg: g.avgViewers, rate: n(g.followsPerHour, 1) }) }}</span>
              }
            </li>
          }
        </ul>
        @if (size() === 'm') {
          <p class="hc__basis">{{ t('devMocks.hq.card.games.basis') }}</p>
        }
      }

      @case ('days') {
        <p class="hc__say">{{ t('devMocks.hq.card.days.say', { day1: day(topDays[0].weekday, 'long'), day2: day(topDays[1].weekday, 'long') }) }}</p>
        <ul class="hd" [class.hd--s]="size() === 's'" [attr.aria-label]="t('devMocks.growth.coach.days.chart')">
          @for (d of days; track d.weekday) {
            <li class="hd__day" [class.hd__day--top]="isTop(d.weekday)" [class.hd__day--none]="!d.streams">
              <span class="hd__val">{{ d.streams ? n(d.followsPerStream) : '–' }}</span>
              <span class="hd__col"><span [style.height.%]="d.streams ? (d.followsPerStream / daysMax) * 100 : 0"></span></span>
              <span class="hd__name">{{ day(d.weekday) }}</span>
            </li>
          }
        </ul>
        @if (size() === 'm') {
          <p class="hc__basis">{{ t('devMocks.hq.card.days.basis') }}</p>
        }
      }

      @case ('raids') {
        <p class="hc__say">{{ t('devMocks.hq.card.raids.say', { count: raids.raids.length, follows: raids.raidFollows, share: raids.share }) }}</p>
        @if (size() === 'm') {
          <ul class="hc__rows">
            @for (r of raids.raids; track r.date) {
              <li class="hr">
                <span class="hs__avatar hs__avatar--raid" aria-hidden="true">{{ r.from.charAt(0).toUpperCase() }}</span>
                <span class="hs__who"><strong>{{ r.from }}</strong><span>{{ date(r.date) }} · {{ t('devMocks.growth.coach.raids.viewers', { count: r.viewers }) }}</span></span>
                <span class="hr__gain">+{{ r.follows }}</span>
                <span class="hr__back" [class.hr__back--owed]="isOwed(r.from)">{{ isOwed(r.from) ? t('devMocks.hq.card.raids.owed') : t('devMocks.hq.card.raids.back') }}</span>
              </li>
            }
          </ul>
        }
        <p class="hc__note">
          <app-lf-icon name="bulb" [size]="14"></app-lf-icon>
          <span>{{ t('devMocks.hq.card.raids.out', { sent: raids.out.length, streams: raids.streams, who: raids.owed[0].from }) }}</span>
        </p>
      }
    }
  `
})
export class HqCardComponent extends HqText {
  private readonly theme = inject(ThemeService);
  readonly kind = input.required<CardKind>();
  readonly size = input<CardSize>('m');
  readonly botOn = input(true);
  readonly plan = input<'free' | 'pro'>('pro');
  readonly headingId = input<string>('');

  readonly icon = computed(() => CARD_ICONS[this.kind()]);
  readonly bot = BOT_STATUS;
  readonly credits = computed(() => creditsFor(this.plan()));

  readonly automod = AUTOMOD_WEEK;
  readonly automodChange = this.signedPct(Math.round(((AUTOMOD_WEEK.actions - AUTOMOD_WEEK.prevActions) / AUTOMOD_WEEK.prevActions) * 100));
  readonly actionKeys: ActionKey[] = ['delete', 'warn', 'timeout', 'ban'];
  readonly offenders = repeatOffenders();
  readonly sanctions = computed(() => SANCTIONS.slice(0, this.size() === 's' ? 3 : 6));

  readonly commandMax = TOP_COMMANDS[0].uses;
  readonly commands = computed(() => TOP_COMMANDS.slice(0, this.size() === 's' ? 3 : 6));
  readonly unused = UNUSED_COMMANDS;
  readonly emoteMax = TOP_EMOTES[0].uses;
  readonly emotes = computed(() => TOP_EMOTES.slice(0, this.size() === 's' ? 4 : 6));

  readonly games = mostWatchedGames();
  readonly gamesShown = computed(() => (this.size() === 's' ? this.games.slice(0, 2) : this.games));

  readonly days = weekdayStats();
  readonly daysMax = Math.max(...this.days.map((d) => d.followsPerStream));
  readonly topDays = [...this.days].filter((d) => d.streams >= 3).sort((a, b) => b.followsPerStream - a.followsPerStream).slice(0, 2);

  readonly raids = raidSummary();

  change(row: UsageRow): number {
    return change(row);
  }

  emote(id: string): string {
    return emoteUrl(id, this.theme.isDarkMode());
  }

  isTop(weekday: number): boolean {
    return this.topDays.some((d) => d.weekday === weekday);
  }

  isOwed(from: string): boolean {
    return this.raids.owed.some((o) => o.from === from);
  }

  automodAria(): string {
    return this.automod.rules.map((r) => `${this.t('moderation.types.' + r.key)}: ${r.hits}`).join(', ');
  }
}

/** A habit with evidence bars and one thing to try. */
@Component({
  selector: 'app-hq-habit',
  imports: [LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./hq-mock-habit.css'],
  template: `
    <p class="hh__tag" [attr.data-tone]="habit().tone">
      <app-lf-icon [name]="habit().tone === 'good' ? 'star' : 'bulb'" [size]="14"></app-lf-icon>
      {{ t('devMocks.hq.habit.tone.' + habit().tone) }}
    </p>
    <h3 class="hh__say">{{ t('devMocks.hq.habit.' + habit().key + '.say', vars()) }}</h3>
    @if (!compact()) {
      <ul class="hh__bars" [attr.aria-label]="t('devMocks.hq.habit.' + habit().key + '.chart')">
        @for (b of habit().bars; track b.label) {
          <li class="hh__bar" [attr.data-mark]="b.mark || null">
            <span class="hh__label">{{ barLabel(b.label) }}</span>
            <span class="hh__track"><span [style.width.%]="(b.value / max()) * 100"></span></span>
            <span class="hh__val">
              @if (b.value) {
                {{ n(b.value, habit().unit === 'perHour' ? 1 : 0) }}<small>{{ t('devMocks.hq.habit.unit.' + habit().unit) }}</small>
              } @else {
                –
              }
            </span>
          </li>
        }
      </ul>
    }
    <p class="hh__try"><b>{{ t('devMocks.growth.coach.try') }}</b> {{ t('devMocks.hq.habit.' + habit().key + '.try', vars()) }}</p>
    @if (hideable()) {
      <button type="button" class="hh__hide" (click)="hide.emit()" [attr.aria-label]="t('devMocks.hq.habit.hideAria', { tip: t('devMocks.hq.habit.' + habit().key + '.name') })">
        <app-lf-icon name="eye-off" [size]="14"></app-lf-icon>{{ t('devMocks.hq.habit.hide') }}
      </button>
    }
  `
})
export class HqHabitComponent extends HqText {
  readonly habit = input.required<Habit>();
  readonly compact = input(false);
  readonly hideable = input(false);
  readonly hide = output<void>();

  readonly max = computed(() => Math.max(...this.habit().bars.map((b) => b.value)));

  /** Sentence values with weekday numbers and length keys turned into words. */
  readonly vars = computed(() => {
    const v = { ...this.habit().vars };
    for (const k of ['worst', 'best']) if (typeof v[k] === 'number') v[k] = this.day(v[k] as number, 'long');
    if (typeof v['sweet'] === 'string') v['sweet'] = this.t('devMocks.growth.coach.length.b.' + v['sweet']);
    for (const k of ['rate']) if (typeof v[k] === 'number') v[k] = this.n(v[k] as number, 1);
    return v;
  });

  barLabel(label: string): string {
    if (/^d\d$/.test(label)) {
      const d = this.day(Number(label.slice(1)));
      return d.charAt(0).toUpperCase() + d.slice(1);
    }
    if (['short', 'mid', 'sweet', 'long'].includes(label)) return this.t('devMocks.growth.coach.length.b.' + label);
    if (label === 'busy' || label === 'quiet') return this.t('devMocks.hq.habit.quietWeeks.' + label);
    return label;
  }
}

/** Quick buttons to the modules you open most, with this week's number. */
@Component({
  selector: 'app-hq-modules',
  imports: [RouterLink, LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./hq-mock-modules.css'],
  template: `
    <nav class="hm" [attr.data-variant]="variant()" [attr.aria-label]="t('devMocks.hq.modules.label')">
      @for (m of items(); track m.key) {
        <a class="hm__btn" routerLink="/mocks/dev/prod-modules" [attr.data-module]="m.key">
          <span class="hm__icon" aria-hidden="true"><app-lf-icon [name]="m.icon" [size]="variant() === 'dock' ? 22 : 20"></app-lf-icon></span>
          <span class="hm__name">{{ t('devMocks.hq.modules.' + m.key + '.name') }}</span>
          @if (variant() !== 'dock') {
            <span class="hm__stat">{{ t('devMocks.hq.modules.' + m.key + '.stat', { n: n(m.stat) }) }}</span>
          }
        </a>
      }
    </nav>
  `
})
export class HqModulesComponent extends HqText {
  readonly keys = input<ModuleKey[]>(MOST_USED);
  readonly variant = input<'grid' | 'fluid' | 'row' | 'dock'>('grid');
  readonly items = computed(() => this.keys().map((k) => MODULES.find((m) => m.key === k)!));
}

/** Small persisted-signal helper for the proposals' "what you see" choices. */
export function stored<T>(key: string, fallback: T) {
  let initial = fallback;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw) initial = JSON.parse(raw) as T;
  } catch {
    /* ignore broken saved state */
  }
  const s = signal<T>(initial);
  return {
    value: s.asReadonly(),
    set(v: T) {
      s.set(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage may be blocked */
      }
    }
  };
}
