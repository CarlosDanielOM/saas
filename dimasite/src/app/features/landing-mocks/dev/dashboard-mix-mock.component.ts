import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { LfIconComponent, LfIconName } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockHeaderComponent } from './growth-mock-header.component';
import { creditsFor, fmt, weekdayName, weekdayStats } from './growth-mock-data';
import {
  AUTOMOD_WEEK,
  BOT_STATUS,
  Habit,
  HabitKey,
  MODULES,
  MOST_USED,
  ModuleKey,
  SANCTIONS,
  TOP_COMMANDS,
  TOP_EMOTES,
  emoteUrl,
  habits,
  mostWatchedGames,
  raidSummary
} from './hq-mock-data';
import { CARD_ICONS, CardKind, HqCardComponent, HqHabitComponent, HqModulesComponent, PINNED_CARDS, stored } from './hq-mock-parts.component';

type TipKind = `tip:${HabitKey}`;
type Kind = CardKind | TipKind;
type Size = 's' | 'm';
type PaneKey = 'channel' | 'bot';
interface Widget {
  kind: Kind;
  size: Size;
}
type Layout = Record<PaneKey, Widget[]>;
type Preset = 'growth' | 'moderation' | 'everything';
type Item = { type: 'widget'; w: Widget; index: number } | { type: 'lock'; count: number };

const MAX_SHORTCUTS = 6;

const KINDS: Record<PaneKey, Kind[]> = {
  channel: ['tip:weakDay', 'tip:raidBack', 'tip:shortStreams', 'tip:quietWeeks', 'tip:sweetSpot', 'games', 'days', 'raids'],
  bot: ['bot', 'credits', 'automod', 'sanctions', 'commands', 'emotes']
};

const w = (kind: Kind, size: Size): Widget => ({ kind, size });

const DEFAULT_LAYOUT: Layout = {
  channel: [w('tip:weakDay', 'm'), w('tip:raidBack', 'm'), w('tip:shortStreams', 's'), w('tip:quietWeeks', 's'), w('days', 's'), w('raids', 's'), w('games', 'm'), w('tip:sweetSpot', 'm')],
  bot: [w('bot', 's'), w('credits', 's'), w('automod', 'm'), w('sanctions', 's'), w('emotes', 's'), w('commands', 'm')]
};

const PRESETS: Record<Preset, Layout> = {
  growth: {
    channel: [w('tip:weakDay', 'm'), w('tip:raidBack', 'm'), w('tip:shortStreams', 'm'), w('tip:quietWeeks', 'm'), w('games', 'm'), w('days', 'm'), w('raids', 'm'), w('tip:sweetSpot', 'm')],
    bot: [w('bot', 's'), w('credits', 's'), w('automod', 's'), w('commands', 's')]
  },
  moderation: {
    channel: [w('tip:weakDay', 's'), w('tip:raidBack', 's'), w('games', 's'), w('days', 's')],
    bot: [w('bot', 's'), w('credits', 's'), w('automod', 'm'), w('sanctions', 'm'), w('commands', 'm'), w('emotes', 'm')]
  },
  everything: {
    channel: KINDS.channel.map((k) => w(k, 'm')),
    bot: [w('bot', 's'), w('credits', 's'), w('automod', 'm'), w('sanctions', 'm'), w('commands', 'm'), w('emotes', 'm')]
  }
};

/**
 * Dashboard proposal "Split + Widgets": your channel on one side, your bot
 * on the other (phones: two tabs and an always-visible bot strip), and each
 * side is a widget grid you can customize: move, resize, remove, add,
 * presets, shortcuts. Bot status and AI credits can't be removed.
 */
@Component({
  selector: 'app-dashboard-mix-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, HqCardComponent, HqHabitComponent, HqModulesComponent],
  templateUrl: './dashboard-mix-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './hq-mock-page.css', './dashboard-mix-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardMixMockComponent {
  private readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly detail = viewChild<ElementRef<HTMLDialogElement>>('detail');
  private readonly catalog = viewChild<ElementRef<HTMLDialogElement>>('catalog');

  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly pane = signal<PaneKey>('channel');
  readonly editing = signal(false);
  readonly opened = signal<Kind | null>(null);
  readonly catalogPane = signal<PaneKey>('channel');
  readonly status = signal('');

  private readonly layoutStore = stored<Layout>('mock.hq.mix.layout', DEFAULT_LAYOUT);
  private readonly dockStore = stored<ModuleKey[]>('mock.hq.mix.dock', MOST_USED);
  readonly layout = this.layoutStore.value;
  readonly dock = this.dockStore.value;
  readonly panes: PaneKey[] = ['channel', 'bot'];
  readonly presets: Preset[] = ['growth', 'moderation', 'everything'];
  readonly modules = MODULES;
  readonly maxShortcuts = MAX_SHORTCUTS;

  readonly habits = habits();
  private readonly habitByKey = new Map(this.habits.map((h) => [h.key, h]));
  readonly credits = computed(() => creditsFor(this.plan()));
  readonly automod = AUTOMOD_WEEK;
  readonly bot = BOT_STATUS;
  readonly topGame = mostWatchedGames()[0];
  readonly bestDayNum = weekdayStats().filter((d) => d.streams >= 3).sort((a, b) => b.followsPerStream - a.followsPerStream)[0].weekday;
  private readonly games = mostWatchedGames();
  private readonly bestDay = weekdayStats().filter((d) => d.streams >= 3).sort((a, b) => b.followsPerStream - a.followsPerStream)[0];
  private readonly raids = raidSummary();

  readonly fixCount = this.habits.filter((h) => h.tone === 'fix').length;

  /** What each pane renders. Free keeps the first tip and turns the rest into one upsell. */
  readonly items = computed<Record<PaneKey, Item[]>>(() => {
    const free = this.plan() === 'free';
    const build = (pane: PaneKey): Item[] => {
      const out: Item[] = [];
      let tips = 0;
      let locked = 0;
      let lockAt = -1;
      this.layout()[pane].forEach((wd, index) => {
        if (free && this.isTip(wd.kind)) {
          tips++;
          if (tips > 1) {
            locked++;
            if (lockAt < 0) lockAt = out.length;
            return;
          }
        }
        out.push({ type: 'widget', w: wd, index });
      });
      if (locked) out.splice(lockAt, 0, { type: 'lock', count: locked });
      return out;
    };
    return { channel: build('channel'), bot: build('bot') };
  });

  readonly missing = computed<Record<PaneKey, Kind[]>>(() => ({
    channel: KINDS.channel.filter((k) => !this.layout().channel.some((x) => x.kind === k)),
    bot: KINDS.bot.filter((k) => !this.layout().bot.some((x) => x.kind === k))
  }));

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(v: number, digits = 0): string {
    return fmt(v, this.language.currentLanguage(), digits);
  }

  day(weekday: number): string {
    return weekdayName(weekday, this.language.currentLanguage(), 'long');
  }

  /** Weekday as a stand-alone word (capitalised in Spanish too). */
  dayWord(weekday: number): string {
    const d = this.day(weekday);
    return d.charAt(0).toUpperCase() + d.slice(1);
  }

  isTip(kind: Kind): kind is TipKind {
    return kind.startsWith('tip:');
  }

  habitOf(kind: Kind): Habit | undefined {
    return this.isTip(kind) ? this.habitByKey.get(kind.slice(4) as HabitKey) : undefined;
  }

  asCard(kind: Kind): CardKind {
    return kind as CardKind;
  }

  icon(kind: Kind): LfIconName {
    const h = this.habitOf(kind);
    if (h) return h.tone === 'good' ? 'star' : 'bulb';
    return CARD_ICONS[kind as CardKind];
  }

  name(kind: Kind): string {
    const h = this.habitOf(kind);
    return h ? this.t('devMocks.hq.habit.' + h.key + '.name') : this.t('devMocks.hq.card.' + kind + '.title');
  }

  hint(kind: Kind): string {
    const h = this.habitOf(kind);
    return h ? this.t('devMocks.hq.habit.tone.' + h.tone) : this.t('devMocks.hq.card.' + kind + '.hint');
  }

  isPinned(kind: Kind): boolean {
    return PINNED_CARDS.includes(kind as CardKind);
  }

  /** The one number a small widget shows. */
  glance(kind: Kind): { value: string; label: string; tone?: 'ok' | 'warn'; img?: string } {
    const h = this.habitOf(kind);
    if (h) {
      const v = h.vars;
      switch (h.key) {
        case 'shortStreams':
          return { value: `−${v['less']}%`, label: this.t('devMocks.hq.mix.glance.shortStreams'), tone: 'warn' };
        case 'weakDay':
          return { value: this.dayWord(v['worst'] as number), label: this.t('devMocks.hq.mix.glance.weakDay', { ratio: this.n(v['ratio'] as number, 1), best: this.day(v['best'] as number) }), tone: 'warn' };
        case 'raidBack':
          return { value: String(this.raids.owed.length), label: this.t('devMocks.hq.mix.glance.raidBack'), tone: 'warn' };
        case 'quietWeeks':
          return { value: `${v['quietAvg']} / ${v['busyAvg']}`, label: this.t('devMocks.hq.mix.glance.quietWeeks'), tone: 'warn' };
        case 'sweetSpot':
          return { value: this.t('devMocks.growth.coach.length.b.' + v['sweet']), label: this.t('devMocks.hq.mix.glance.sweetSpot', { rate: this.n(v['rate'] as number, 1) }), tone: 'ok' };
      }
    }
    switch (kind as CardKind) {
      case 'bot':
        return this.botOn()
          ? { value: this.t('devMocks.hq.glance.botOn'), label: this.t('devMocks.hq.mix.glance.bot', { on: this.bot.eventsOn, total: this.bot.eventsTotal }), tone: 'ok' }
          : { value: this.t('devMocks.hq.glance.botOff'), label: this.t('devMocks.hq.glance.botOffLabel'), tone: 'warn' };
      case 'credits': {
        const c = this.credits();
        return {
          value: `${c.pctLeft}%`,
          label: c.lastsUntilReset ? this.t('devMocks.hq.glance.creditsOk') : this.t('devMocks.hq.glance.creditsShort', { days: c.daysLeft }),
          tone: c.lastsUntilReset ? undefined : 'warn'
        };
      }
      case 'automod':
        return { value: this.n(AUTOMOD_WEEK.actions), label: this.t('devMocks.hq.glance.automod') };
      case 'sanctions':
        return { value: this.n(SANCTIONS.length), label: this.t('devMocks.hq.glance.sanctions') };
      case 'commands':
        return { value: TOP_COMMANDS[0].name, label: this.t('devMocks.hq.glance.commands', { uses: this.n(TOP_COMMANDS[0].uses) }) };
      case 'emotes':
        return { value: TOP_EMOTES[0].name, label: this.t('devMocks.hq.glance.emotes', { uses: this.n(TOP_EMOTES[0].uses) }), img: emoteUrl(TOP_EMOTES[0].id, this.theme.isDarkMode()) };
      case 'games':
        return { value: this.games[0].label, label: this.t('devMocks.hq.glance.games', { share: this.games[0].share }) };
      case 'days':
        return { value: this.dayWord(this.bestDay.weekday), label: this.t('devMocks.hq.glance.days') };
      case 'raids':
      default:
        return { value: '+' + this.raids.raidFollows, label: this.t('devMocks.hq.glance.raids', { count: this.raids.raids.length }) };
    }
  }

  // ------------------------------------------------------------ editing

  private save(pane: PaneKey, next: Widget[], message?: string): void {
    this.layoutStore.set({ ...this.layout(), [pane]: next });
    if (message) this.status.set(message);
  }

  move(pane: PaneKey, index: number, by: -1 | 1): void {
    const next = [...this.layout()[pane]];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    this.save(pane, next, this.t('devMocks.hq.widgets.moved', { name: this.name(next[to].kind), pos: to + 1, total: next.length }));
  }

  resize(pane: PaneKey, index: number, size: Size): void {
    this.save(pane, this.layout()[pane].map((x, i) => (i === index ? { ...x, size } : x)));
  }

  remove(pane: PaneKey, kind: Kind): void {
    if (this.isPinned(kind)) return;
    this.save(pane, this.layout()[pane].filter((x) => x.kind !== kind), this.t('devMocks.hq.widgets.removed', { name: this.name(kind) }));
  }

  add(kind: Kind): void {
    const pane = this.catalogPane();
    this.save(pane, [...this.layout()[pane], { kind, size: 'm' }], this.t('devMocks.hq.widgets.added', { name: this.name(kind) }));
    if (!this.missing()[pane].length) this.catalog()?.nativeElement.close();
  }

  applyPreset(p: Preset): void {
    this.layoutStore.set(PRESETS[p]);
    this.status.set(this.t('devMocks.hq.widgets.presetApplied', { name: this.t('devMocks.hq.widgets.preset.' + p) }));
  }

  reset(): void {
    this.layoutStore.set(DEFAULT_LAYOUT);
    this.dockStore.set(MOST_USED);
    this.status.set(this.t('devMocks.hq.widgets.resetDone'));
  }

  inDock(key: ModuleKey): boolean {
    return this.dock().includes(key);
  }

  toggleDock(key: ModuleKey): void {
    const now = this.dock();
    if (now.includes(key)) {
      if (now.length > 1) this.dockStore.set(now.filter((k) => k !== key));
    } else if (now.length < MAX_SHORTCUTS) {
      this.dockStore.set(MODULES.map((m) => m.key).filter((k) => k === key || now.includes(k)));
    }
  }

  // ------------------------------------------------------------ dialogs

  open(kind: Kind): void {
    if (this.editing()) return;
    this.opened.set(kind);
    this.detail()?.nativeElement.showModal();
  }

  closeDetail(): void {
    this.detail()?.nativeElement.close();
  }

  openCatalog(pane: PaneKey): void {
    this.catalogPane.set(pane);
    this.catalog()?.nativeElement.showModal();
  }

  closeCatalog(): void {
    this.catalog()?.nativeElement.close();
  }

  backdrop(event: MouseEvent, which: 'detail' | 'catalog'): void {
    const el = (which === 'detail' ? this.detail() : this.catalog())?.nativeElement;
    if (event.target === el) el?.close();
  }
}
