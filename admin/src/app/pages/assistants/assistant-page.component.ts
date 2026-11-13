import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  AssistantsApiService,
  type AssistantSummary,
  type AssistantTurn,
  type AssistantTurnQuery,
} from '../../services/assistants-api.service';
import { ChannelPickerComponent, type PickedChannel } from '../../shared/channel-picker/channel-picker.component';
import { DayBarsComponent, type DayBar } from '../../shared/day-bars/day-bars.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { RANGES, formatNumber, formatShare, formatUSD, hoursAgo, isRangeKey, plural, rangeHours, shortDay, type RangeKey } from '../../shared/format';
import { AssistantBlocksComponent, NEAR_LIMIT } from './assistant-blocks.component';
import { AssistantTurnComponent } from './assistant-turn.component';
import { AssistantTurnSheetComponent } from './assistant-turn-sheet.component';
import { errorLabel, lowerFirst, wideScreen } from './assistants-format';

type Status = NonNullable<AssistantTurnQuery['status']>;
type Level = NonNullable<AssistantTurnQuery['level']>;
type Sort = NonNullable<AssistantTurnQuery['sort']>;

const STATUSES: Status[] = ['completed', 'cancelled', 'problems'];
const LEVELS: Level[] = ['standard', 'expert'];
const SORTS: Sort[] = ['newest', 'cost', 'slowest'];
const ID = /^\d{1,20}$/;
const PAGE_SIZE = 25;

interface Change {
  range?: RangeKey;
  channel?: string | null;
  user?: string | null;
  status?: Status | null;
  level?: Level | null;
  sort?: Sort;
  page?: number;
  open?: string | null;
}

/**
 * `/ai/assistant`: is the Dima assistant used, is it working, what does it cost us. Chats are private, so the
 * page (like its API) shows how the assistant was used and never what was said.
 */
@Component({
  selector: 'app-assistant-page',
  templateUrl: './assistant-page.component.html',
  styleUrl: './assistant-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent, DayBarsComponent, ChannelPickerComponent, AssistantBlocksComponent, AssistantTurnComponent, AssistantTurnSheetComponent],
})
export class AssistantPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(AssistantsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sheet = viewChild<ElementRef<HTMLDialogElement>>('sheet');
  private readonly subscriptions = new Subscription();
  private summaryRequest?: Subscription;
  private turnsRequest?: Subscription;
  private summaryKey = '';
  private turnsKey = '';

  readonly ranges = RANGES.filter((range) => range.key !== '1h');
  readonly sorts: Array<{ key: Sort; label: string }> = [
    { key: 'newest', label: 'Newest' },
    { key: 'cost', label: 'Costliest' },
    { key: 'slowest', label: 'Slowest' },
  ];

  /** Desktop shows the numbers beside the list; phones fold them above it. */
  readonly wide = wideScreen();

  readonly range = signal<RangeKey>('30d');
  readonly channel = signal<string | null>(null);
  readonly user = signal<string | null>(null);
  readonly status = signal<Status | null>(null);
  readonly level = signal<Level | null>(null);
  readonly sort = signal<Sort>('newest');
  readonly page = signal(1);
  /** The turn whose exchange is open in the sheet (`?open=`). */
  readonly open = signal<string | null>(null);

  readonly summary = signal<AssistantSummary | null>(null);
  readonly summaryLoading = signal(true);
  readonly summaryFailed = signal(false);
  readonly rows = signal<AssistantTurn[]>([]);
  readonly total = signal(0);
  readonly totalPages = signal(1);
  readonly turnsLoading = signal(true);
  readonly turnsFailed = signal(false);
  /** Names learnt from the channel picker and earlier rows, so a filter chip never shows a raw id. */
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());
  private readonly people = signal<ReadonlyMap<string, string>>(new Map());

  readonly rangeLabel = computed(() => RANGES.find((range) => range.key === this.range())!.label);
  readonly channelRow = computed(() => this.summary()?.byChannel.find((row) => row.channelID === this.channel()) ?? null);
  readonly channelName = computed(() => {
    const id = this.channel();
    if (!id) return null;
    return this.channelRow()?.channel || this.names().get(id) || this.summary()?.limitsToday.find((row) => row.channelID === id)?.channel || 'this channel';
  });
  readonly userName = computed(() => {
    const id = this.user();
    return id ? this.people().get(id) || 'one person' : null;
  });
  readonly openRow = computed(() => this.rows().find((row) => row.id === this.open()) ?? null);
  readonly activeFilters = computed(() => (this.channel() ? 1 : 0) + (this.user() ? 1 : 0));

  /** Per-turn records only exist from this day; set when it falls inside the range. */
  readonly recordsNote = computed(() => {
    const summary = this.summary();
    if (!summary?.recordsSince) return null;
    return Date.parse(summary.recordsSince) > Date.parse(summary.from) ? shortDay(summary.recordsSince.slice(0, 10)) : null;
  });

  /** Channels at or near today's daily limit: shown above the fold, never only inside the numbers. */
  readonly nearLimit = computed(() =>
    (this.summary()?.limitsToday ?? [])
      .filter((row) => row.limit > 0 && row.used / row.limit >= NEAR_LIMIT)
      .map((row) => ({ ...row, share: Math.min(100, (row.used / row.limit) * 100) })),
  );

  readonly days = computed<DayBar[]>(() => (this.summary()?.daily ?? []).map((day) => ({ date: day.date, value: day.turns, part: day.failed })));
  readonly formatCount = (value: number) => formatNumber(value);
  readonly formatShare = formatShare;

  /** Chip counts from the per-turn breakdowns (they follow the channel filter, like the list). */
  readonly counts = computed(() => {
    const summary = this.summary();
    if (!summary) return null;
    const level = (key: Level) => summary.byLevel.find((row) => row.level === key)?.turns ?? 0;
    return { problems: summary.byLevel.reduce((sum, row) => sum + row.failed, 0), expert: level('expert'), standard: level('standard') };
  });

  /** The page's answer: messages, how they ended, what they cost. */
  readonly answer = computed(() => {
    const summary = this.summary();
    if (!summary) return null;
    const when = `in the last ${this.rangeLabel()}`;
    const channel = this.channelRow();
    if (this.channel()) {
      const name = this.channelName();
      if (!channel || !channel.turns) {
        return { tone: 'muted' as const, title: `No messages from ${name} ${when}`, text: 'Widen the range, or clear the channel to see every channel.', problems: 0 };
      }
      const since = this.recordsNote() ? ` (records start ${this.recordsNote()})` : '';
      const cancelled = channel.cancelled ?? 0;
      const answered = Math.max(0, channel.turns - channel.failed - cancelled);
      const warn = channel.failed > 0 && channel.failed / channel.turns >= 0.05;
      const top = summary.errors[0];
      const cause = warn && top ? ` Most common error: ${lowerFirst(errorLabel(top.code))} (${plural(top.count, 'time')}).` : '';
      return {
        tone: warn ? ('warn' as const) : ('ok' as const),
        title: `${plural(channel.turns, 'message')} from ${name} ${when}${since}`,
        text: `${formatNumber(answered)} answered, ${formatNumber(channel.failed)} failed, ${formatNumber(cancelled)} stopped by the person. They used ${plural(channel.units, 'daily message')}. It cost us ${formatUSD(channel.providerUSD)}.${cause}`,
        problems: channel.failed,
      };
    }
    const totals = summary.totals;
    if (!totals.turns) {
      return {
        tone: 'muted' as const,
        title: `No messages ${when}`,
        text: 'When streamers or their editors chat with the assistant in their dashboard, the messages show up here.',
        problems: 0,
      };
    }
    const from = totals.channels > 0 ? ` from ${plural(totals.channels, 'channel')}` : '';
    const going = totals.turns - totals.completed - totals.failed - totals.cancelled;
    const parts = [`${formatNumber(totals.completed)} answered`, `${formatNumber(totals.failed)} failed`, `${formatNumber(totals.cancelled)} stopped by the person`];
    if (going > 0) parts.push(`${formatNumber(going)} still going`);
    const warn = totals.failed > 0 && (totals.failed / totals.turns >= 0.05 || totals.failed >= 5);
    const top = summary.errors[0];
    const cause = warn && top ? ` Most common error: ${lowerFirst(errorLabel(top.code))} (${plural(top.count, 'time')}).` : '';
    return {
      tone: warn ? ('warn' as const) : ('ok' as const),
      title: `${plural(totals.turns, 'message')} ${when}${from}`,
      text: `${parts.join(', ')}. It cost us ${formatUSD(totals.providerUSD)}.${cause}`,
      problems: totals.failed,
    };
  });

  readonly costLine = computed(() => {
    const summary = this.summary();
    if (!summary) return '';
    const { providerUSD, turns } = summary.totals;
    const perDay = summary.daily.length ? providerUSD / summary.daily.length : 0;
    const parts = [`${formatUSD(providerUSD)} in total`, `${formatUSD(perDay)} a day`];
    if (turns) parts.push(`${formatUSD(providerUSD / turns)} per message`);
    return parts.join(' · ');
  });

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const range = params.get('range');
        this.range.set(isRangeKey(range) && range !== '1h' ? range : '30d');
        const channel = params.get('channel');
        this.channel.set(channel && ID.test(channel) ? channel : null);
        const user = params.get('user');
        this.user.set(user && ID.test(user) ? user : null);
        const status = params.get('status') as Status;
        this.status.set(STATUSES.includes(status) ? status : null);
        const level = params.get('level') as Level;
        this.level.set(LEVELS.includes(level) ? level : null);
        const sort = params.get('sort') as Sort;
        this.sort.set(SORTS.includes(sort) ? sort : 'newest');
        this.page.set(Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
        const open = params.get('open');
        this.open.set(open && /^[\w-]{1,64}$/.test(open) ? open : null);
        this.load();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.summaryRequest?.unsubscribe();
    this.turnsRequest?.unsubscribe();
  }

  /** Loads what the URL change affects; `force` reloads both (Retry, Refresh). */
  load(force = false): void {
    const from = hoursAgo(rangeHours(this.range()));
    const summaryKey = `${this.range()}|${this.channel()}`;
    if (force || summaryKey !== this.summaryKey || this.summaryFailed()) {
      this.summaryKey = summaryKey;
      this.loadSummary(from);
    }
    const query: AssistantTurnQuery = {
      from,
      channel: this.channel(),
      user: this.user(),
      status: this.status(),
      level: this.level(),
      sort: this.sort() === 'newest' ? null : this.sort(),
      page: this.page(),
      limit: PAGE_SIZE,
    };
    const turnsKey = JSON.stringify({ ...query, from: this.range() });
    if (force || turnsKey !== this.turnsKey || this.turnsFailed()) {
      this.turnsKey = turnsKey;
      this.loadTurns(query);
    }
  }

  private loadSummary(from: string): void {
    this.summaryRequest?.unsubscribe();
    this.summaryLoading.set(true);
    this.summaryFailed.set(false);
    this.summaryRequest = this.api.assistantSummary({ from, channel: this.channel() }).subscribe({
      next: ({ data }) => {
        this.summary.set(data);
        this.remember(data.byChannel.map((row) => [row.channelID, row.channel]));
        this.summaryLoading.set(false);
      },
      error: () => {
        this.summaryFailed.set(true);
        this.summaryLoading.set(false);
      },
    });
  }

  private loadTurns(query: AssistantTurnQuery): void {
    this.turnsRequest?.unsubscribe();
    this.turnsLoading.set(true);
    this.turnsFailed.set(false);
    this.turnsRequest = this.api.assistantTurns(query).subscribe({
      next: ({ data }) => {
        this.rows.set(data.rows);
        this.total.set(data.pagination.total);
        this.totalPages.set(Math.max(1, data.pagination.totalPages));
        this.remember(data.rows.map((row) => [row.channelID, row.channel]));
        const people = new Map(this.people());
        for (const row of data.rows) if (row.user.id) people.set(row.user.id, row.user.name || row.user.login);
        this.people.set(people);
        this.turnsLoading.set(false);
      },
      error: () => {
        this.turnsFailed.set(true);
        this.turnsLoading.set(false);
      },
    });
  }

  private remember(pairs: Array<[string, string | null]>): void {
    const names = new Map(this.names());
    for (const [id, name] of pairs) if (name) names.set(id, name);
    this.names.set(names);
  }

  go(change: Change): void {
    const next = {
      range: change.range ?? this.range(),
      channel: change.channel !== undefined ? change.channel : this.channel(),
      user: change.user !== undefined ? change.user : this.user(),
      status: change.status !== undefined ? change.status : this.status(),
      level: change.level !== undefined ? change.level : this.level(),
      sort: change.sort ?? this.sort(),
      page: change.page ?? 1,
      open: change.open !== undefined ? change.open : null,
    };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        range: next.range === '30d' ? null : next.range,
        channel: next.channel || null,
        user: next.user || null,
        status: next.status || null,
        level: next.level || null,
        sort: next.sort === 'newest' ? null : next.sort,
        page: next.page > 1 ? next.page : null,
        open: next.open || null,
      },
    });
  }

  toggleStatus(status: Status): void {
    this.go({ status: this.status() === status ? null : status });
  }

  toggleLevel(level: Level): void {
    this.go({ level: this.level() === level ? null : level });
  }

  pickChannel(id: string | null): void {
    this.go({ channel: this.channel() === id ? null : id });
  }

  pickUser(id: string): void {
    this.go({ user: id });
  }

  /** Opening keeps every filter and the page; only `open` changes. */
  openTurn(turn: AssistantTurn): void {
    this.remember([[turn.channelID, turn.channel]]);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { open: turn.id }, queryParamsHandling: 'merge' });
  }

  closeTurn(): void {
    if (this.open()) void this.router.navigate([], { relativeTo: this.route, queryParams: { open: null }, queryParamsHandling: 'merge' });
  }

  openSheet(): void {
    this.sheet()?.nativeElement.showModal();
  }

  closeSheet(): void {
    this.sheet()?.nativeElement.close();
  }

  picked(channel: PickedChannel): void {
    this.remember([[channel.channelID, channel.channel]]);
    this.closeSheet();
    this.go({ channel: channel.channelID });
  }

  /** Close the sheet on a tap on its backdrop. */
  backdrop(event: MouseEvent): void {
    if (event.target === this.sheet()?.nativeElement) this.closeSheet();
  }
}
