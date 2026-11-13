import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  ChannelDebugApiService,
  type BotLogEntry,
  type BotLogLevel,
  type BotLogPage,
} from '../../services/channel-debug-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { dateTime, formatNumber, plural, relativeTime } from '../../shared/format';
import { ChannelWorkspaceService } from './channel-workspace.service';

type LevelFilter = 'problems' | BotLogLevel;
const LEVELS: BotLogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug'];
const LEVEL_NAME: Record<BotLogLevel, string> = { fatal: 'Fatal', error: 'Error', warn: 'Warning', info: 'Info', debug: 'Debug' };
/** Code words read in plain English inside "where it happened". */
const PLAIN_WORD: Record<string, string> = { tts: 'voice', eventsub: 'Twitch event', ai: 'AI', api: 'API', obs: 'OBS', vts: 'VTube Studio', ast: 'command' };
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Bot log tab: what the bot itself logged about this channel in the last 7 days. */
@Component({
  selector: 'app-channel-logs',
  templateUrl: './channel-logs.component.html',
  styleUrls: ['./channel-page.component.css', './channel-logs.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent],
})
export class ChannelLogsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ChannelDebugApiService);
  readonly ws = inject(ChannelWorkspaceService);
  private request?: Subscription;
  private copyTimer?: ReturnType<typeof setTimeout>;

  readonly maxLimit = MAX_LIMIT;
  readonly formatNumber = formatNumber;
  readonly channelID = this.ws.channelID;
  readonly page = signal<BotLogPage | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly openIds = signal<ReadonlySet<string>>(new Set());
  readonly copiedId = signal<string | null>(null);

  private readonly query = toSignal(this.route.queryParamMap, { requireSync: true });
  readonly level = computed<LevelFilter>(() => {
    const value = this.query().get('level');
    return LEVELS.includes(value as BotLogLevel) ? (value as BotLogLevel) : 'problems';
  });
  readonly limit = computed(() => {
    const value = Number(this.query().get('limit'));
    return Number.isFinite(value) && value > DEFAULT_LIMIT ? Math.min(MAX_LIMIT, Math.floor(value)) : DEFAULT_LIMIT;
  });

  readonly entries = computed(() => this.page()?.entries ?? []);
  private readonly counts = computed(() => this.page()?.counts ?? null);

  readonly chips = computed(() => {
    const c = this.counts();
    const n = (level: BotLogLevel) => (c ? c[level] ?? 0 : null);
    const problems = c ? (c.fatal ?? 0) + (c.error ?? 0) + (c.warn ?? 0) : null;
    const chips: Array<{ key: LevelFilter; label: string; count: number | null; dot: BotLogLevel | null }> = [
      { key: 'problems', label: 'Problems', count: problems, dot: null },
    ];
    if ((n('fatal') ?? 0) > 0 || this.level() === 'fatal') chips.push({ key: 'fatal', label: 'Fatal', count: n('fatal'), dot: 'fatal' });
    chips.push(
      { key: 'error', label: 'Errors', count: n('error'), dot: 'error' },
      { key: 'warn', label: 'Warnings', count: n('warn'), dot: 'warn' },
      { key: 'info', label: 'Info', count: n('info'), dot: 'info' },
      { key: 'debug', label: 'Debug', count: n('debug'), dot: 'debug' },
    );
    return chips;
  });

  /** The page's answer, from the 7-day counts (they ignore the level filter). */
  readonly answer = computed<{ tone: 'ok' | 'warn' | 'live'; title: string; text: string | null }>(() => {
    const c = this.counts();
    if (!c) return { tone: 'ok', title: '', text: null };
    const errors = (c.error ?? 0) + (c.fatal ?? 0);
    const warnings = c.warn ?? 0;
    const routine = (c.info ?? 0) + (c.debug ?? 0);
    const routineText = routine ? `${plural(routine, 'routine line')} (info and debug) too.` : null;
    if (!errors && !warnings) {
      return { tone: 'ok', title: 'No errors or warnings about this channel in the last 7 days.', text: routineText };
    }
    const parts = [errors ? plural(errors, 'error') : null, warnings ? plural(warnings, 'warning') : null].filter(Boolean).join(' and ');
    const fatal = c.fatal ? `${formatNumber(c.fatal)} of the errors ${c.fatal === 1 ? 'was' : 'were'} fatal.` : null;
    return {
      tone: errors ? 'live' : 'warn',
      title: `The bot logged ${parts} about this channel in the last 7 days.`,
      text: fatal,
    };
  });

  readonly emptyTitle = computed(() => {
    const level = this.level();
    if (level === 'problems') return 'No errors or warnings in the last 7 days';
    return `No ${level === 'warn' ? 'warnings' : level === 'error' ? 'errors' : `${LEVEL_NAME[level].toLowerCase()} lines`} in the last 7 days`;
  });
  readonly emptyText = computed(() =>
    this.level() === 'problems'
      ? 'The bot had nothing to complain about for this channel. Pick Info to see its routine lines.'
      : 'Pick another level above, or Problems for errors and warnings together.',
  );

  constructor() {
    effect(() => {
      const level = this.level();
      const limit = this.limit();
      untracked(() => this.load(level, limit));
    });
    this.destroyRef.onDestroy(() => clearTimeout(this.copyTimer));
  }

  reload(): void {
    this.load(this.level(), this.limit());
  }

  private load(level: LevelFilter, limit: number): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api
      .logs(this.channelID(), { level: level === 'problems' ? null : level, limit: limit === DEFAULT_LIMIT ? undefined : limit })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.page.set(response.data);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err, 'Check your connection and try again.'));
          this.loading.set(false);
        },
      });
  }

  setLevel(level: LevelFilter): void {
    this.openIds.set(new Set());
    this.navigate({ level: level === 'problems' ? null : level, limit: null });
  }

  showMore(): void {
    this.navigate({ limit: String(Math.min(MAX_LIMIT, this.limit() * 2)) });
  }

  private navigate(queryParams: Record<string, string | null>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
  }

  onToggle(id: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    const next = new Set(this.openIds());
    if (open) next.add(id);
    else next.delete(id);
    this.openIds.set(next);
  }

  /** "redemptionHandler" → "Redemption handler"; null when the line did not say. */
  where(entry: BotLogEntry): string | null {
    const fn = entry.function?.trim();
    if (!fn) return null;
    if (fn.length > 48 || /[/\\:()\s]/.test(fn)) return fn;
    const words = fn
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_.-]+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ')
      .map((word) => PLAIN_WORD[word] ?? word)
      .join(' ');
    return words ? words[0].toUpperCase() + words.slice(1) : fn;
  }

  fields(entry: BotLogEntry): Array<{ key: string; value: string }> {
    return Object.entries(entry.data ?? {}).map(([key, value]) => ({
      key,
      value: value === null ? 'null' : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value),
    }));
  }

  levelName(level: BotLogLevel): string {
    return LEVEL_NAME[level] ?? level;
  }

  relative(at: string): string {
    return relativeTime(at);
  }

  fullTime(at: string): string {
    return dateTime(at);
  }

  async copy(entry: BotLogEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      this.copiedId.set(entry.id);
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copiedId.set(null), 2000);
    } catch {
      this.copiedId.set(null);
    }
  }
}
