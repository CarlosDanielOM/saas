import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent, LfIconName } from '../../../shared/lf-icon/lf-icon.component';
import { GrowthMockCreditsComponent, GrowthMockHeaderComponent } from './growth-mock-header.component';
import {
  DAILY_FOLLOWERS,
  GAME_LABELS,
  GROWTH_CHANNEL,
  GrowthRecord,
  LAST_30,
  Milestone,
  PREV_30,
  PathGoal,
  SMALL_CHANNEL_30,
  addDays,
  compact,
  fmt,
  followerMilestones,
  hoursLabel,
  monthGoal,
  monthsToViewers,
  pctChange,
  personalRecords,
  shortDate,
  twitchPath,
  weekdayName
} from './growth-mock-data';

type Track = 'partner' | 'affiliate';

interface VersusRow {
  key: 'viewers' | 'follows' | 'subs' | 'bits' | 'hours' | 'streams';
  now: number;
  before: number;
  /** Share of the bar the current period takes (0–100). */
  share: number;
  winner: 'now' | 'before' | 'tie';
}

/**
 * Dashboard proposal "Path": growth as a journey. How close am I to Twitch
 * Affiliate/Partner, which milestone is next and when I'll get there at my
 * pace, me vs me last month (duel-style), and the records I've set.
 */
@Component({
  selector: 'app-dashboard-path-mock',
  imports: [RouterLink, LfIconComponent, GrowthMockHeaderComponent, GrowthMockCreditsComponent],
  templateUrl: './dashboard-path-mock.component.html',
  styleUrls: ['./dashboard-mock.shared.css', './dashboard-path-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardPathMockComponent {
  private readonly language = inject(LanguageService);

  readonly live = signal(false);
  readonly plan = signal<'free' | 'pro'>('pro');
  readonly botOn = signal(true);
  readonly track = signal<Track>('partner');
  readonly lang = computed(() => this.language.currentLanguage());

  readonly goals = computed<PathGoal[]>(() =>
    this.track() === 'partner' ? twitchPath('partner') : twitchPath('affiliate', SMALL_CHANNEL_30, 21)
  );
  readonly doneCount = computed(() => this.goals().filter((g) => g.done).length);
  readonly missing = computed(() => this.goals().filter((g) => !g.done));
  readonly viewerMonths = monthsToViewers(75);
  readonly viewerGrowth = pctChange(LAST_30.avgViewers, PREV_30.avgViewers);

  readonly followers = GROWTH_CHANNEL.followers;
  readonly milestones: Milestone[] = followerMilestones();
  readonly passed = this.milestones.filter((m) => m.reached);
  readonly upcoming = this.milestones.filter((m) => !m.reached);
  readonly next = this.upcoming[0];
  readonly prevTarget = this.passed[this.passed.length - 1]?.target ?? 0;
  readonly toNextPct = Math.round(((this.followers - this.prevTarget) / (this.next.target - this.prevTarget)) * 100);
  readonly pace = Math.round((DAILY_FOLLOWERS.slice(-30).reduce((a, d) => a + d.gained, 0) / 30) * 10) / 10;

  readonly versus: VersusRow[] = (
    [
      ['viewers', LAST_30.avgViewers, PREV_30.avgViewers],
      ['follows', LAST_30.follows, PREV_30.follows],
      ['subs', LAST_30.subs, PREV_30.subs],
      ['bits', LAST_30.bits, PREV_30.bits],
      ['hours', Math.round(LAST_30.hours * 10) / 10, Math.round(PREV_30.hours * 10) / 10],
      ['streams', LAST_30.streams, PREV_30.streams]
    ] as Array<[VersusRow['key'], number, number]>
  ).map(([key, now, before]) => ({
    key,
    now,
    before,
    share: Math.round((now / (now + before || 1)) * 100),
    winner: now > before ? 'now' : now < before ? 'before' : 'tie'
  }));
  readonly score = {
    now: this.versus.filter((v) => v.winner === 'now').length,
    before: this.versus.filter((v) => v.winner === 'before').length
  };

  readonly goalsMonth = [
    { key: 'follows', ...monthGoal('follows', 240) },
    { key: 'subs', ...monthGoal('subs', 30) }
  ];

  readonly records: GrowthRecord[] = personalRecords();
  readonly freshRecords = this.records.filter((r) => r.fresh).length;

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }

  n(v: number, digits = 0): string {
    return fmt(v, this.lang(), digits);
  }

  c(v: number): string {
    return compact(v, this.lang());
  }

  date(iso: string): string {
    return shortDate(iso, this.lang());
  }

  inDays(days: number): string {
    return shortDate(addDays(days), this.lang());
  }

  day(weekday: number): string {
    return weekdayName(weekday, this.lang());
  }

  hours(h: number): string {
    return hoursLabel(h);
  }

  gameName(key: keyof typeof GAME_LABELS): string {
    return GAME_LABELS[key];
  }

  /** SVG ring: circumference of r=42 is ~263.9. */
  ringDash(goal: PathGoal): string {
    const pct = Math.min(1, goal.current / goal.target);
    const len = 263.9;
    return `${(pct * len).toFixed(1)} ${len}`;
  }

  goalValue(goal: PathGoal): string {
    if (goal.key === 'hours') return this.n(goal.current, goal.current % 1 ? 1 : 0);
    return this.n(goal.current);
  }

  versusValue(row: VersusRow, side: 'now' | 'before'): string {
    const v = row[side];
    if (row.key === 'hours') return hoursLabel(v);
    if (row.key === 'bits') return this.c(v);
    return this.n(v);
  }

  recordValue(r: GrowthRecord): string {
    if (r.key === 'long') return hoursLabel(r.value);
    if (r.key === 'follows' || r.key === 'subs') return '+' + this.n(r.value);
    return this.n(r.value);
  }

  recordIcon(r: GrowthRecord): LfIconName {
    const icons: Record<GrowthRecord['key'], LfIconName> = { peak: 'trend', avg: 'users', follows: 'star', bits: 'bits', subs: 'gift', long: 'timer' };
    return icons[r.key];
  }
}
