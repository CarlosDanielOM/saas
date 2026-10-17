import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';

import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockHeaderComponent } from './growth-mock-header.component';
import { creditsFor, fmt, weekdayName, weekdayStats } from './growth-mock-data';
import { AUTOMOD_WEEK, MODULES, MOST_USED, ModuleKey, SANCTIONS, TOP_COMMANDS, TOP_EMOTES, emoteUrl, habits, mostWatchedGames, raidSummary } from './hq-mock-data';
import { CARD_ICONS, CardKind, HqCardComponent, HqHabitComponent, HqModulesComponent, PINNED_CARDS, stored } from './hq-mock-parts.component';

type WidgetKind = CardKind | 'tip';
type Size = 's' | 'm';
interface Widget {
  kind: WidgetKind;
  size: Size;
}
type Preset = 'growth' | 'moderation' | 'everything';

const ALL_KINDS: WidgetKind[] = ['bot', 'credits', 'tip', 'games', 'days', 'raids', 'automod', 'sanctions', 'commands', 'emotes'];

const DEFAULT_LAYOUT: Widget[] = [
  { kind: 'bot', size: 's' },
  { kind: 'credits', size: 's' },
  { kind: 'automod', size: 's' },
  { kind: 'emotes', size: 's' },
  { kind: 'tip', size: 'm' },
  { kind: 'games', size: 'm' },
  { kind: 'commands', size: 'm' },
  { kind: 'days', size: 'm' }
];

const PRESETS: Record<Preset, Widget[]> = {
  growth: [
    { kind: 'bot', size: 's' },
    { kind: 'credits', size: 's' },
    { kind: 'days', size: 's' },
    { kind: 'raids', size: 's' },
    { kind: 'tip', size: 'm' },
    { kind: 'games', size: 'm' }
  ],
  moderation: [
    { kind: 'bot', size: 's' },
    { kind: 'credits', size: 's' },
    { kind: 'sanctions', size: 's' },
    { kind: 'emotes', size: 's' },
    { kind: 'automod', size: 'm' },
    { kind: 'commands', size: 'm' }
  ],
  everything: ALL_KINDS.map((kind) => ({ kind, size: ['bot', 'credits', 'sanctions', 'raids'].includes(kind) ? 's' : 'm' }) as Widget)
};

/**
 * Dashboard proposal "Widgets": a home screen you build. Small widgets show
 * one number (tap to open the full card), large ones show the card. Edit mode
 * moves, resizes, removes and adds widgets, with presets; bot status and AI
 * credits can be moved but never removed. Shortcuts sit in a dock.
 */
@Component({
  selector: 'app-dashboard-widgets-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, HqCardComponent, HqHabitComponent, HqModulesComponent],
  templateUrl: './dashboard-widgets-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './hq-mock-page.css', './dashboard-widgets-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardWidgetsMockComponent {
  private readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly detail = viewChild<ElementRef<HTMLDialogElement>>('detail');
  private readonly catalog = viewChild<ElementRef<HTMLDialogElement>>('catalog');

  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly editing = signal(false);
  readonly opened = signal<WidgetKind | null>(null);
  readonly tipIndex = signal(0);
  readonly status = signal('');

  private readonly layoutStore = stored<Widget[]>('mock.hq.widgets.layout', DEFAULT_LAYOUT);
  private readonly dockStore = stored<ModuleKey[]>('mock.hq.widgets.dock', MOST_USED);
  readonly layout = this.layoutStore.value;
  readonly dock = this.dockStore.value;
  readonly presets: Preset[] = ['growth', 'moderation', 'everything'];
  readonly modules = MODULES;

  readonly missing = computed(() => ALL_KINDS.filter((k) => !this.layout().some((w) => w.kind === k)));
  readonly habits = habits();
  readonly fixHabits = this.habits.filter((h) => h.tone === 'fix');
  readonly tip = computed(() => this.habits[this.tipIndex() % this.habits.length]);

  readonly credits = computed(() => creditsFor(this.plan()));
  private readonly games = mostWatchedGames();
  private readonly bestDay = weekdayStats().filter((d) => d.streams >= 3).sort((a, b) => b.followsPerStream - a.followsPerStream)[0];
  private readonly raids = raidSummary();

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(v: number): string {
    return fmt(v, this.language.currentLanguage());
  }

  icon(kind: WidgetKind) {
    return kind === 'tip' ? 'bulb' : CARD_ICONS[kind];
  }

  name(kind: WidgetKind): string {
    return kind === 'tip' ? this.t('devMocks.hq.widgets.tip.title') : this.t('devMocks.hq.card.' + kind + '.title');
  }

  hint(kind: WidgetKind): string {
    return kind === 'tip' ? this.t('devMocks.hq.widgets.tip.hint') : this.t('devMocks.hq.card.' + kind + '.hint');
  }

  isPinned(kind: WidgetKind): boolean {
    return PINNED_CARDS.includes(kind as CardKind);
  }

  /** The one number a small widget shows. */
  glance(kind: WidgetKind): { value: string; label: string; tone?: 'ok' | 'warn'; img?: string } {
    const lang = this.language.currentLanguage();
    switch (kind) {
      case 'bot':
        return this.botOn()
          ? { value: this.t('devMocks.hq.glance.botOn'), label: this.t('devMocks.hq.glance.botOnLabel'), tone: 'ok' }
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
        return { value: this.n(SANCTIONS.length), label: this.t('devMocks.hq.glance.sanctions', { bans: SANCTIONS.filter((s) => s.action === 'ban').length }) };
      case 'commands':
        return { value: TOP_COMMANDS[0].name, label: this.t('devMocks.hq.glance.commands', { uses: this.n(TOP_COMMANDS[0].uses) }) };
      case 'emotes':
        return { value: TOP_EMOTES[0].name, label: this.t('devMocks.hq.glance.emotes', { uses: this.n(TOP_EMOTES[0].uses) }), img: emoteUrl(TOP_EMOTES[0].id, this.theme.isDarkMode()) };
      case 'games':
        return { value: this.games[0].label, label: this.t('devMocks.hq.glance.games', { share: this.games[0].share }) };
      case 'days':
        return { value: weekdayName(this.bestDay.weekday, lang, 'long'), label: this.t('devMocks.hq.glance.days') };
      case 'raids':
        return { value: '+' + this.raids.raidFollows, label: this.t('devMocks.hq.glance.raids', { count: this.raids.raids.length }) };
      case 'tip':
        return { value: String(this.fixHabits.length), label: this.t('devMocks.hq.glance.tips'), tone: 'warn' };
    }
  }

  // ------------------------------------------------------------ editing

  private save(next: Widget[], message?: string): void {
    this.layoutStore.set(next);
    if (message) this.status.set(message);
  }

  move(index: number, by: -1 | 1): void {
    const next = [...this.layout()];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    this.save(next, this.t('devMocks.hq.widgets.moved', { name: this.name(next[to].kind), pos: to + 1, total: next.length }));
  }

  resize(index: number, size: Size): void {
    this.save(this.layout().map((w, i) => (i === index ? { ...w, size } : w)));
  }

  remove(index: number): void {
    const w = this.layout()[index];
    if (this.isPinned(w.kind)) return;
    this.save(this.layout().filter((_, i) => i !== index), this.t('devMocks.hq.widgets.removed', { name: this.name(w.kind) }));
  }

  add(kind: WidgetKind): void {
    this.save([...this.layout(), { kind, size: 'm' }], this.t('devMocks.hq.widgets.added', { name: this.name(kind) }));
    if (!this.missing().length) this.catalog()?.nativeElement.close();
  }

  applyPreset(p: Preset): void {
    this.save(PRESETS[p], this.t('devMocks.hq.widgets.presetApplied', { name: this.t('devMocks.hq.widgets.preset.' + p) }));
  }

  reset(): void {
    this.save(DEFAULT_LAYOUT, this.t('devMocks.hq.widgets.resetDone'));
    this.dockStore.set(MOST_USED);
  }

  inDock(key: ModuleKey): boolean {
    return this.dock().includes(key);
  }

  toggleDock(key: ModuleKey): void {
    const now = this.dock();
    if (now.includes(key)) {
      if (now.length > 1) this.dockStore.set(now.filter((k) => k !== key));
    } else if (now.length < 4) {
      this.dockStore.set([...now, key]);
    }
  }

  // ------------------------------------------------------------ dialogs

  open(kind: WidgetKind): void {
    if (this.editing()) return;
    this.opened.set(kind);
    this.detail()?.nativeElement.showModal();
  }

  closeDetail(): void {
    this.detail()?.nativeElement.close();
  }

  openCatalog(): void {
    this.catalog()?.nativeElement.showModal();
  }

  closeCatalog(): void {
    this.catalog()?.nativeElement.close();
  }

  backdrop(event: MouseEvent, which: 'detail' | 'catalog'): void {
    const el = (which === 'detail' ? this.detail() : this.catalog())?.nativeElement;
    if (event.target === el) el?.close();
  }

  nextTip(): void {
    this.tipIndex.update((i) => i + 1);
  }

  asCard(kind: WidgetKind): CardKind {
    return kind as CardKind;
  }
}
