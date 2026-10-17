import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockHeaderComponent } from './growth-mock-header.component';
import { creditsFor, weekdayName, weekdayStats } from './growth-mock-data';
import { AUTOMOD_WEEK, BOT_STATUS, HabitKey, habits, mostWatchedGames } from './hq-mock-data';
import { BOT_CARDS, CHANNEL_CARDS, CardKind, HqCardComponent, HqHabitComponent, HqModulesComponent, PINNED_CARDS, stored } from './hq-mock-parts.component';

type Pane = 'channel' | 'bot';

/**
 * Dashboard proposal "Split": your channel on one side, your bot on the
 * other. Phones switch panes with two tabs and keep a one-line bot strip on
 * top so bot status is never more than a glance away. "Choose cards" hides
 * what you don't need (bot status and credits always stay).
 */
@Component({
  selector: 'app-dashboard-split-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, HqCardComponent, HqHabitComponent, HqModulesComponent],
  templateUrl: './dashboard-split-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './hq-mock-page.css', './dashboard-split-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardSplitMockComponent {
  private readonly language = inject(LanguageService);
  private readonly picker = viewChild<ElementRef<HTMLDialogElement>>('picker');

  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly pane = signal<Pane>('channel');

  private readonly hiddenCards = stored<CardKind[]>('mock.hq.split.cards', []);
  private readonly hiddenTips = stored<HabitKey[]>('mock.hq.split.tips', []);

  readonly channelCards = CHANNEL_CARDS;
  readonly botCards = BOT_CARDS;
  readonly allHabits = habits();
  readonly credits = computed(() => creditsFor(this.plan()));
  readonly automod = AUTOMOD_WEEK;
  readonly bot = BOT_STATUS;

  readonly shownChannel = computed(() => CHANNEL_CARDS.filter((k) => !this.hiddenCards.value().includes(k)));
  readonly shownBot = computed(() => BOT_CARDS.filter((k) => PINNED_CARDS.includes(k) || !this.hiddenCards.value().includes(k)));
  readonly tipsOn = computed(() => this.allHabits.filter((h) => !this.hiddenTips.value().includes(h.key)));
  /** Free shows one tip and one upsell for the rest. */
  readonly tipsShown = computed(() => (this.plan() === 'free' ? this.tipsOn().slice(0, 1) : this.tipsOn()));
  readonly tipsLocked = computed(() => (this.plan() === 'free' ? Math.max(0, this.tipsOn().length - 1) : 0));
  readonly fixCount = computed(() => this.tipsOn().filter((h) => h.tone === 'fix').length);
  readonly hiddenCount = computed(() => this.hiddenCards.value().length + this.hiddenTips.value().length);

  readonly topGame = mostWatchedGames()[0];
  readonly bestDay = weekdayStats().filter((d) => d.streams >= 3).sort((a, b) => b.followsPerStream - a.followsPerStream)[0];

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  day(weekday: number): string {
    return weekdayName(weekday, this.language.currentLanguage(), 'long');
  }

  isCardOn(kind: CardKind): boolean {
    return PINNED_CARDS.includes(kind) || !this.hiddenCards.value().includes(kind);
  }

  isPinned(kind: CardKind): boolean {
    return PINNED_CARDS.includes(kind);
  }

  isTipOn(key: HabitKey): boolean {
    return !this.hiddenTips.value().includes(key);
  }

  toggleCard(kind: CardKind): void {
    if (this.isPinned(kind)) return;
    const now = this.hiddenCards.value();
    this.hiddenCards.set(now.includes(kind) ? now.filter((k) => k !== kind) : [...now, kind]);
  }

  toggleTip(key: HabitKey): void {
    const now = this.hiddenTips.value();
    this.hiddenTips.set(now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
  }

  hideTip(key: HabitKey): void {
    if (this.isTipOn(key)) this.toggleTip(key);
  }

  showAll(): void {
    this.hiddenCards.set([]);
    this.hiddenTips.set([]);
  }

  openPicker(): void {
    this.picker()?.nativeElement.showModal();
  }

  closePicker(): void {
    this.picker()?.nativeElement.close();
  }

  /** Clicking the backdrop (outside the sheet) closes it. */
  backdrop(event: MouseEvent): void {
    if (event.target === this.picker()?.nativeElement) this.closePicker();
  }
}
