import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { COMMAND_USER_LEVELS, ChannelApiService, type ChannelCommand } from '../../services/channel-api.service';
import { ChannelDebugApiService, type CommandStat, type CommandStats } from '../../services/channel-debug-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { ConfirmModalComponent } from '../../shared/confirm-modal/confirm-modal.component';
import { ToastService } from '../../shared/toast/toast.service';
import { reasonText } from '../../shared/feed/feed-format';
import { formatNumber, plural, relativeTime } from '../../shared/format';
import { ChannelWorkspaceService } from './channel-workspace.service';
import { CommandEditorComponent, commandLabel, commandLevel, commandTrigger, type CommandSaved } from './command-editor.component';

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
  /** Runs that went wrong (failed, or refused by Twitch); turned off and cooldowns are not problems. */
  problems: number;
}

/** An older API sends no `problems`: then failures only (its blocked count mixes in viewers without the role). */
const problemsOf = (stat: CommandStat): number => stat.problems ?? stat.failed;
/** Runs the bot answered; usage replies answer too. An older API: ok only. */
export const answeredOf = (stat: CommandStat): number => stat.answered ?? stat.ok;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Commands tab: their commands, how each ran in the last 7 days, and editing all of them, built-ins too (owner routes). */
@Component({
  selector: 'app-channel-commands',
  templateUrl: './channel-commands.component.html',
  styleUrls: ['./channel-page.component.css', './channel-commands.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgTemplateOutlet, SkeletonComponent, IconComponent, ConfirmModalComponent, CommandEditorComponent],
})
export class ChannelCommandsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly channelApi = inject(ChannelApiService);
  private readonly debugApi = inject(ChannelDebugApiService);
  private readonly ws = inject(ChannelWorkspaceService);
  private readonly toast = inject(ToastService);
  private statsSub?: Subscription;

  readonly sorts = SORTS;
  readonly formatNumber = formatNumber;
  readonly answeredOf = answeredOf;
  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly commands = signal<ChannelCommand[]>([]);
  /** Function names whose built-in code runs instead of a reply (the editor's "Runs" choices). */
  readonly builtInActions = signal<readonly string[]>([]);
  readonly currentPage = signal(1);
  readonly totalPages = signal(1);
  readonly totalItems = signal(0);
  readonly stats = signal<CommandStats | null>(null);
  readonly statsError = signal<string | null>(null);
  readonly openKeys = signal<ReadonlySet<string>>(new Set());

  /** The open editor: `command` null = a new command. */
  readonly editor = signal<{ command: ChannelCommand | null } | null>(null);
  /** Commands whose on/off change is on its way. */
  readonly toggling = signal<ReadonlySet<string>>(new Set());
  readonly deleting = signal<ChannelCommand | null>(null);
  readonly deleteBusy = signal(false);
  readonly deleteError = signal<string | null>(null);
  readonly deleteTitle = computed(() => {
    const cmd = this.deleting();
    return cmd ? `Delete ${commandLabel(cmd)}?` : 'Delete';
  });
  readonly deleteMessage = computed(() => {
    const login = this.login();
    const text = login
      ? `It stops working in ${login}'s chat right away. There's no undo here, and ${login} isn't notified.`
      : "It stops working in the channel's chat right away. There's no undo here, and the streamer isn't notified.";
    return this.deleting()?.reserved ? `${text} It's a built-in command: the bot may add it back when the channel signs in again.` : text;
  });

  readonly channelID = this.ws.channelID;
  /** The channel login: new commands store it, and the editor names it. */
  readonly login = computed(() => this.ws.name() || this.commands().find((cmd) => cmd.channel)?.channel || '');
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
      const trigger = commandTrigger(cmd);
      const stat = byName.get(trigger.toLowerCase()) ?? null;
      return { key: cmd.id, cmd, trigger, stat, problems: stat ? problemsOf(stat) : 0 };
    });
    if (this.totalPages() === 1) {
      const known = new Set(this.commands().map((cmd) => commandTrigger(cmd).toLowerCase()));
      for (const stat of this.stats()?.commands ?? []) {
        if (!known.has(stat.name.toLowerCase())) {
          rows.push({ key: `stat:${stat.name}`, cmd: null, trigger: stat.name, stat, problems: problemsOf(stat) });
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
    const missed = stats.commands.reduce((sum, stat) => sum + stat.runs - answeredOf(stat), 0);
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

  /** `quiet` keeps the list on screen while it refreshes (after a write). */
  loadCommands(page: number, quiet = false): void {
    const channelID = this.channelID();
    if (!channelID) return;
    if (!quiet) {
      this.isLoading.set(true);
      this.error.set(null);
    }
    this.channelApi
      .getChannelCommands(channelID, page, 100)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.commands.set(response.data.rows);
          const actions = response.data.meta?.builtInActions;
          if (Array.isArray(actions)) this.builtInActions.set(actions.filter((name) => typeof name === 'string'));
          this.currentPage.set(response.data.pagination.page);
          this.totalPages.set(response.data.pagination.totalPages);
          this.totalItems.set(response.data.pagination.total);
          this.isLoading.set(false);
        },
        error: (err) => {
          if (!quiet) this.error.set("Couldn't load commands");
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

  /** Who can use it, in the site's words. */
  whoLabel(cmd: ChannelCommand): string {
    if (cmd.permissionMode === 'tags') return 'Custom rule';
    if (cmd.permissionMode === 'invalid') return 'Broken permission rule';
    const level = Number.isInteger(cmd.userLevel) ? commandLevel(cmd) : null;
    return (level && COMMAND_USER_LEVELS.find((item) => item.level === level)?.label) || cmd.userLevelName || 'Everyone';
  }

  openCreate(): void {
    if (this.login()) this.editor.set({ command: null });
  }

  openEdit(cmd: ChannelCommand): void {
    this.editor.set({ command: cmd });
  }

  onEditorSaved({ command, created }: CommandSaved): void {
    const label = commandLabel(command);
    if (!created) {
      this.patch(command.id, command);
      this.toast.success(`Saved ${label}`);
      return;
    }
    this.toast.success(`${capitalize(label)} created`);
    if (!command.id) {
      this.loadCommands(this.currentPage(), true);
      return;
    }
    this.commands.update((list) => [...list, command]);
    this.totalItems.update((total) => total + 1);
    this.openKeys.update((keys) => new Set(keys).add(command.id));
  }

  /** Turn on/off right away (owner route); put it back and say why when the API refuses. */
  toggle(cmd: ChannelCommand): void {
    if (this.toggling().has(cmd.id)) return;
    const enabled = !cmd.enabled;
    const label = commandLabel(cmd);
    const failed = (message: string) => {
      this.patch(cmd.id, { enabled: cmd.enabled });
      this.toast.error(message);
    };
    this.patch(cmd.id, { enabled });
    this.setToggling(cmd.id, true);
    this.channelApi
      .ownerUpdateCommand(this.channelID(), cmd.id, { enabled })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.setToggling(cmd.id, false);
          if (response?.error) {
            failed(response.message || `Couldn't turn ${label} ${enabled ? 'on' : 'off'}.`);
            return;
          }
          // Only `enabled`: an edit saved meanwhile may already be newer than this answer's other fields.
          if (response?.data?.id === cmd.id) this.patch(cmd.id, { enabled: response.data.enabled });
          this.toast.success(`${capitalize(label)} turned ${enabled ? 'on' : 'off'}`);
        },
        error: (err) => {
          this.setToggling(cmd.id, false);
          failed(apiErrorMessage(err, `Couldn't turn ${label} ${enabled ? 'on' : 'off'}. Try again.`));
        },
      });
  }

  askDelete(cmd: ChannelCommand): void {
    this.deleteError.set(null);
    this.deleting.set(cmd);
  }

  cancelDelete(): void {
    if (this.deleteBusy()) return;
    this.deleting.set(null);
    this.deleteError.set(null);
  }

  confirmDelete(): void {
    const cmd = this.deleting();
    if (!cmd || this.deleteBusy()) return;
    const label = commandLabel(cmd);
    const failed = (message: string) => {
      this.deleteBusy.set(false);
      this.deleteError.set(message);
    };
    this.deleteBusy.set(true);
    this.deleteError.set(null);
    this.channelApi
      .ownerDeleteCommand(this.channelID(), cmd.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (response?.error) {
            failed(response.message || `Couldn't delete ${label}. Try again.`);
            return;
          }
          this.deleteBusy.set(false);
          this.deleting.set(null);
          this.commands.update((list) => list.filter((item) => item.id !== cmd.id));
          this.totalItems.update((total) => Math.max(0, total - 1));
          this.toast.success(`${capitalize(label)} deleted`);
        },
        error: (err) => failed(apiErrorMessage(err, `Couldn't delete ${label}. Try again.`)),
      });
  }

  private patch(id: string, changes: Partial<ChannelCommand>): void {
    this.commands.update((list) => list.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  private setToggling(id: string, busy: boolean): void {
    const next = new Set(this.toggling());
    if (busy) next.add(id);
    else next.delete(id);
    this.toggling.set(next);
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

  /**
   * "Ran 120× · 4 didn't answer (on cooldown 3×) · last 2 h ago". `warn` only when some of those went wrong:
   * a command that is turned off or on cooldown is working as set.
   */
  statLine(row: CommandRow): { text: string; missed: string | null; warn: boolean; last: string } | null {
    const stat = row.stat;
    if (!stat || !stat.runs) return null;
    const top = stat.reasons[0];
    const count = stat.runs - answeredOf(stat);
    const missed = count
      ? `${formatNumber(count)} didn't answer${top ? ` (${this.reasonShort(top.reason)} ${formatNumber(top.count)}×)` : ''}`
      : null;
    return { text: `Ran ${formatNumber(stat.runs)}×`, missed, warn: row.problems > 0, last: `last ${relativeTime(stat.lastAt)}` };
  }

  /** How the last run went, in words. */
  lastRun(stat: CommandStat): string {
    const when = relativeTime(stat.lastAt);
    const why = reasonText(stat.lastReason);
    if (stat.lastOutcome === 'ok') return `${when}: answered`;
    if (stat.lastReason === 'usage') return `${when}: answered with how to use it`;
    if (stat.lastOutcome === 'failed') return `${when}: failed${why ? `, ${why}` : ''}`;
    return `${when}: didn't answer${why ? `, ${why}` : ''}`;
  }
}
