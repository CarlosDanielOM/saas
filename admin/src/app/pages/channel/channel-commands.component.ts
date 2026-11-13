import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { ChannelApiService, type ChannelCommand } from '../../services/channel-api.service';
import { ChannelDebugApiService, type CommandStat, type CommandStats } from '../../services/channel-debug-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { reasonText } from '../../shared/feed/feed-format';
import { formatNumber, plural, relativeTime } from '../../shared/format';
import { ChannelWorkspaceService } from './channel-workspace.service';

type SortKey = 'name' | 'used' | 'problems';
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'used', label: 'Most used' },
  { key: 'problems', label: 'Most problems' },
];
const STATS_DAYS = 7;

/** Short reason next to a count: "on cooldown 14×". Unknown codes fall back to the feed's wording. */
const SHORT_REASON: Record<string, string> = {
  cooldown: 'on cooldown',
  permission_denied: 'viewer not allowed',
  permission_invalid: 'broken permission rule',
  disabled: 'turned off',
  chat_disabled: 'chat turned off',
  no_credits: 'no credits left',
  send_failed: "reply couldn't be sent",
  held_for_moderation: 'held by Twitch',
  error: 'error',
  exception: 'bot error',
  handler_error: 'bot error',
};
/** The main reason across all commands: "mostly cooldowns". */
const MOSTLY: Record<string, string> = {
  cooldown: 'cooldowns',
  permission_denied: "viewers who weren't allowed",
  permission_invalid: 'broken permission rules',
  disabled: 'commands that are turned off',
  error: 'errors',
  exception: 'bot errors',
  handler_error: 'bot errors',
};

export interface CommandRow {
  key: string;
  /** Null for a command that ran but is not in their list (built-in or deleted). */
  cmd: ChannelCommand | null;
  trigger: string;
  stat: CommandStat | null;
  /** Runs that didn't answer. */
  problems: number;
}

/** Commands tab: their commands, and how each ran in the last 7 days. */
@Component({
  selector: 'app-channel-commands',
  templateUrl: './channel-commands.component.html',
  styleUrls: ['./channel-page.component.css', './channel-commands.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgTemplateOutlet, SkeletonComponent, IconComponent],
})
export class ChannelCommandsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly channelApi = inject(ChannelApiService);
  private readonly debugApi = inject(ChannelDebugApiService);
  private readonly ws = inject(ChannelWorkspaceService);
  private statsSub?: Subscription;

  readonly sorts = SORTS;
  readonly formatNumber = formatNumber;
  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly commands = signal<ChannelCommand[]>([]);
  readonly currentPage = signal(1);
  readonly totalPages = signal(1);
  readonly totalItems = signal(0);
  readonly stats = signal<CommandStats | null>(null);
  readonly statsError = signal<string | null>(null);
  readonly openKeys = signal<ReadonlySet<string>>(new Set());

  readonly channelID = this.ws.channelID;
  private readonly query = toSignal(this.route.queryParamMap, { requireSync: true });
  readonly filter = computed(() => this.query().get('q') ?? '');
  readonly sort = computed<SortKey>(() => {
    const value = this.query().get('sort');
    return value === 'used' || value === 'problems' ? value : 'name';
  });

  readonly offCount = computed(() => this.commands().filter((cmd) => !cmd.enabled).length);
  /** Stats keyed by the lower-cased trigger ("!so"). */
  private readonly statsByName = computed(
    () => new Map((this.stats()?.commands ?? []).map((stat) => [stat.name.toLowerCase(), stat])),
  );

  /** Their commands with how each ran, plus commands that ran but are not in their list (only when the whole list is loaded). */
  readonly rows = computed<CommandRow[]>(() => {
    const byName = this.statsByName();
    const rows: CommandRow[] = this.commands().map((cmd) => {
      const stat = byName.get(cmd.cmd.toLowerCase()) ?? null;
      return { key: cmd.id, cmd, trigger: cmd.cmd, stat, problems: stat ? stat.runs - stat.ok : 0 };
    });
    if (this.totalPages() === 1) {
      const known = new Set(this.commands().map((cmd) => cmd.cmd.toLowerCase()));
      for (const stat of this.stats()?.commands ?? []) {
        if (!known.has(stat.name.toLowerCase())) {
          rows.push({ key: `stat:${stat.name}`, cmd: null, trigger: stat.name, stat, problems: stat.runs - stat.ok });
        }
      }
    }
    return rows;
  });

  readonly visibleRows = computed(() => {
    const term = this.filter().trim().toLowerCase();
    const rows = term
      ? this.rows().filter((row) =>
          `${row.trigger} ${row.cmd?.name ?? ''} ${row.cmd?.message ?? ''} ${row.cmd?.func ?? ''}`.toLowerCase().includes(term),
        )
      : [...this.rows()];
    const byName = (a: CommandRow, b: CommandRow) => a.trigger.localeCompare(b.trigger, 'en', { sensitivity: 'base' });
    const sort = this.sort();
    if (sort === 'used') rows.sort((a, b) => (b.stat?.runs ?? 0) - (a.stat?.runs ?? 0) || byName(a, b));
    else if (sort === 'problems') rows.sort((a, b) => b.problems - a.problems || (b.stat?.runs ?? 0) - (a.stat?.runs ?? 0) || byName(a, b));
    else rows.sort(byName);
    return rows;
  });
  readonly listed = computed(() => this.visibleRows().filter((row) => row.cmd));
  readonly unlisted = computed(() => this.visibleRows().filter((row) => !row.cmd));

  /** What the numbers cover: the 7 days, or less when recording started inside them. */
  readonly window = computed(() => {
    const stats = this.stats();
    if (stats?.recordsSince && new Date(stats.recordsSince).getTime() > new Date(stats.from).getTime()) {
      return `since ${new Date(stats.recordsSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    return `in the last ${STATS_DAYS} days`;
  });
  readonly windowTitle = computed(() => this.window()[0].toUpperCase() + this.window().slice(1));

  /** The page's answer. */
  readonly answer = computed<{ tone: 'ok' | 'warn' | 'muted'; title: string; text: string | null }>(() => {
    const count = `${plural(this.totalItems(), 'command')}.`;
    const stats = this.stats();
    if (this.statsError()) return { tone: 'muted', title: count, text: this.statsError() };
    if (!stats) return { tone: 'muted', title: count, text: `Loading how they ran in the last ${STATS_DAYS} days…` };
    if (!stats.recordsSince) {
      return {
        tone: 'muted',
        title: count,
        text: 'Command runs are recorded from the day this console went live; nothing yet for this channel.',
      };
    }
    const runs = stats.commands.reduce((sum, stat) => sum + stat.runs, 0);
    if (!runs) return { tone: 'muted', title: `${count} None of them ran ${this.window()}.`, text: null };
    const missed = stats.commands.reduce((sum, stat) => sum + stat.runs - stat.ok, 0);
    const failed = stats.commands.reduce((sum, stat) => sum + stat.failed, 0);
    const title = `${count} ${this.windowTitle()} they ran ${plural(runs, 'time')}.`;
    if (!missed) return { tone: 'ok', title, text: 'Every run answered.' };
    const reasons = new Map<string, number>();
    for (const stat of stats.commands) {
      for (const r of stat.reasons) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count);
    }
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const mostly = top ? (MOSTLY[top] ? `, mostly ${MOSTLY[top]}` : `, mostly because ${reasonText(top)}`) : '';
    const failedText = failed ? ` ${plural(failed, 'run')} failed with an error.` : '';
    return { tone: failed ? 'warn' : 'ok', title, text: `${plural(missed, 'run')} didn't answer${mostly}.${failedText}` };
  });

  ngOnInit(): void {
    this.loadCommands(1);
    this.loadStats();
  }

  loadCommands(page: number): void {
    const channelID = this.channelID();
    if (!channelID) return;
    this.isLoading.set(true);
    this.error.set(null);
    this.channelApi
      .getChannelCommands(channelID, page, 100)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.commands.set(response.data.rows);
          this.currentPage.set(response.data.pagination.page);
          this.totalPages.set(response.data.pagination.totalPages);
          this.totalItems.set(response.data.pagination.total);
          this.isLoading.set(false);
        },
        error: (err) => {
          this.error.set("Couldn't load commands");
          this.isLoading.set(false);
          console.error('Error loading commands:', err);
        },
      });
  }

  loadStats(): void {
    this.statsSub?.unsubscribe();
    this.stats.set(null);
    this.statsError.set(null);
    this.statsSub = this.debugApi
      .commandStats(this.channelID(), STATS_DAYS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => this.stats.set(response.data),
        error: (err) => this.statsError.set(apiErrorMessage(err, `Couldn't load how they ran in the last ${STATS_DAYS} days.`)),
      });
  }

  onPageChange(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.setQuery({ q: null });
    this.loadCommands(page);
  }

  setFilter(value: string): void {
    this.setQuery({ q: value || null });
  }

  setSort(sort: SortKey): void {
    this.setQuery({ sort: sort === 'name' ? null : sort });
  }

  private setQuery(queryParams: Record<string, string | null>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
  }

  onToggle(key: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    const next = new Set(this.openKeys());
    if (open) next.add(key);
    else next.delete(key);
    this.openKeys.set(next);
  }

  cooldownLabel(seconds: number): string {
    if (!seconds) return 'No cooldown';
    if (seconds < 60) return `${seconds}s cooldown`;
    const minutes = Math.round(seconds / 6) / 10;
    return `${minutes}m cooldown`;
  }

  cooldownLong(seconds: number): string {
    return seconds ? `${plural(seconds, 'second')} between uses` : 'Can be used any time';
  }

  reasonShort(reason: string): string {
    return SHORT_REASON[reason] ?? reasonText(reason) ?? reason;
  }

  /** "Ran 120× · 4 didn't answer (on cooldown 3×) · last 2 h ago" */
  statLine(row: CommandRow): { text: string; problems: string | null; last: string } | null {
    const stat = row.stat;
    if (!stat || !stat.runs) return null;
    const top = stat.reasons[0];
    const problems = row.problems
      ? `${formatNumber(row.problems)} didn't answer${top ? ` (${this.reasonShort(top.reason)} ${formatNumber(top.count)}×)` : ''}`
      : null;
    return { text: `Ran ${formatNumber(stat.runs)}×`, problems, last: `last ${relativeTime(stat.lastAt)}` };
  }

  /** How the last run went, in words. */
  lastRun(stat: CommandStat): string {
    const when = relativeTime(stat.lastAt);
    const why = reasonText(stat.lastReason);
    if (stat.lastOutcome === 'ok') return `${when}: answered`;
    if (stat.lastOutcome === 'failed') return `${when}: failed${why ? `, ${why}` : ''}`;
    return `${when}: didn't answer${why ? `, ${why}` : ''}`;
  }
}
