import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockHeaderComponent } from './growth-mock-header.component';
import { creditsFor, pctChange, shortDate } from './growth-mock-data';
import { AUTOMOD_WEEK, BOT_STATUS, HabitKey, WEEK, habits, weekStreams } from './hq-mock-data';
import { HqCardComponent, HqHabitComponent, HqModulesComponent, stored } from './hq-mock-parts.component';

type Topic = 'tips' | 'games' | 'days' | 'raids' | 'moderation' | 'commands' | 'emotes';
type Pane = 'channel' | 'bot';
const TOPICS: Topic[] = ['tips', 'games', 'days', 'raids', 'moderation', 'commands', 'emotes'];

/**
 * Dashboard proposal "Split + Briefing": the weekly report from Briefing laid
 * out like Split. Bot health and shortcuts on top, then your channel (numbered
 * fixes, what's working, raids) next to what your bot did. Phones switch sides
 * with two tabs and keep a one-line bot strip. "Show me" chips pick the
 * topics; any tip can be hidden and brought back.
 */
@Component({
  selector: 'app-dashboard-split-briefing-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, HqCardComponent, HqHabitComponent, HqModulesComponent],
  templateUrl: './dashboard-split-briefing-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './hq-mock-page.css', './dashboard-split-briefing-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardSplitBriefingMockComponent {
  private readonly language = inject(LanguageService);

  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly pane = signal<Pane>('channel');

  private readonly topicsStore = stored<Topic[]>('mock.hq.splitbrief.topics', TOPICS);
  private readonly hiddenStore = stored<HabitKey[]>('mock.hq.splitbrief.hidden', []);
  readonly topics = TOPICS;

  readonly week = weekStreams();
  readonly followChange = pctChange(this.week.now.follows, this.week.before.follows);
  readonly automod = AUTOMOD_WEEK;
  readonly bot = BOT_STATUS;
  readonly credits = computed(() => creditsFor(this.plan()));

  private readonly all = habits();
  readonly fixes = computed(() => this.all.filter((h) => h.tone === 'fix' && !this.hiddenStore.value().includes(h.key)));
  readonly fixesShown = computed(() => (this.plan() === 'free' ? this.fixes().slice(0, 1) : this.fixes()));
  readonly fixesLocked = computed(() => (this.plan() === 'free' ? Math.max(0, this.fixes().length - 1) : 0));
  readonly goods = computed(() => this.all.filter((h) => h.tone === 'good' && !this.hiddenStore.value().includes(h.key)));
  readonly hiddenCount = computed(() => this.hiddenStore.value().length);

  readonly anyChannel = computed(() => ['tips', 'games', 'days', 'raids'].some((t) => this.on(t as Topic)));
  readonly anyBot = computed(() => ['moderation', 'commands', 'emotes'].some((t) => this.on(t as Topic)));
  readonly showGood = computed(() => (this.on('tips') && this.goods().length > 0) || this.on('games') || this.on('days') || this.on('raids'));

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  date(iso: string): string {
    return shortDate(iso, this.language.currentLanguage());
  }

  weekLabel(): string {
    return this.t('devMocks.hq.brief.week', { from: this.date(WEEK.from), to: this.date(WEEK.to) });
  }

  on(topic: Topic): boolean {
    return this.topicsStore.value().includes(topic);
  }

  toggle(topic: Topic): void {
    const now = this.topicsStore.value();
    this.topicsStore.set(now.includes(topic) ? now.filter((t) => t !== topic) : TOPICS.filter((t) => t === topic || now.includes(t)));
  }

  hide(key: HabitKey): void {
    this.hiddenStore.set([...this.hiddenStore.value(), key]);
  }

  restore(): void {
    this.hiddenStore.set([]);
  }

  pct(v: number): string {
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
  }
}
