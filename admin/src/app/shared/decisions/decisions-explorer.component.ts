import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  DecisionsApiService,
  type DecisionQuery,
  type DecisionRow,
  type DecisionShow,
  type DecisionSort,
  type DecisionSummary,
} from '../../services/decisions-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { formatDuration, formatNumber, formatShare, formatUSD, hoursAgo, plural, rangeHours, relativeTime, type RangeKey } from '../format';
import { IconComponent } from '../icon/icon.component';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { DecisionDetailComponent } from './decision-detail.component';
import { DecisionsFiltersComponent, type FiltersChange } from './decisions-filters.component';
import { DecisionsNumbersComponent } from './decisions-numbers.component';
import {
  SHOW_CHIPS,
  SHOW_LABEL,
  SORTS,
  SOURCE_LABEL,
  categoryShort,
  modelName,
  outcomeLabel,
  percent,
  rowCost,
  ruleName,
  topCategory,
  verdictAgrees,
} from './decision-format';

type ExplorerRange = Extract<RangeKey, '24h' | '7d' | '30d'>;
const RANGE_KEYS: ExplorerRange[] = ['24h', '7d', '30d'];
const RANGE_TEXT: Record<ExplorerRange, string> = { '24h': 'in the last 24 hours', '7d': 'in the last 7 days', '30d': 'in the last 30 days' };
const SHOWS: DecisionShow[] = ['acted', 'bans', 'near_miss', 'allowed', 'not_reviewed', 'action_failed'];
const FEEDBACKS = ['none', 'any', 'agree', 'disagree'] as const;
const SOURCES: DecisionRow['source'][] = ['first_message', 'spam_continuous', 'rule'];
const SORT_KEYS: DecisionSort[] = ['newest', 'cost', 'score', 'slowest'];
const LIMIT = 25;

export interface ExplorerView {
  range: ExplorerRange;
  show: DecisionShow | null;
  kind: 'ai' | 'rule' | null;
  feedback: (typeof FEEDBACKS)[number] | null;
  channel: string | null;
  chatter: string | null;
  chatterName: string | null;
  model: string | null;
  source: DecisionRow['source'] | null;
  sort: DecisionSort;
  page: number;
}

/** A filter the operator set, as a removable chip. */
interface ActiveFilter {
  key: string;
  label: string;
  clear: Partial<Record<keyof ExplorerView, null>>;
}

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | null => (value && (allowed as readonly string[]).includes(value) ? (value as T) : null);

/**
 * Chat protection decisions: the answer for the range, chip filters, the list and the detail sheet.
 * Everything the operator picks lives in the URL. With `channelID` set (a channel's Protection tab) the
 * channel is fixed: no channel picker and no channel name on rows.
 */
@Component({
  selector: 'app-decisions-explorer',
  templateUrl: './decisions-explorer.component.html',
  styleUrl: './decisions-explorer.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SkeletonComponent, DecisionDetailComponent, DecisionsFiltersComponent, DecisionsNumbersComponent],
})
export class DecisionsExplorerComponent implements OnInit, OnDestroy {
  private readonly api = inject(DecisionsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** A channel's Twitch id when the explorer lives on that channel's tab. */
  readonly channelID = input<string | null>(null);

  readonly view = signal<ExplorerView>({ range: '7d', show: null, kind: null, feedback: null, channel: null, chatter: null, chatterName: null, model: null, source: null, sort: 'newest', page: 1 });
  readonly openId = signal<string | null>(null);

  readonly rows = signal<DecisionRow[]>([]);
  readonly total = signal(0);
  readonly totalPages = signal(1);
  readonly listLoading = signal(true);
  readonly listError = signal<string | null>(null);
  readonly summary = signal<DecisionSummary | null>(null);
  readonly summaryLoading = signal(true);
  readonly summaryError = signal(false);
  readonly filtersOpen = signal(false);
  /** Names seen for channel and viewer ids, so a filter chip never shows a raw id. */
  private readonly names = signal<Record<string, string>>({});

  readonly ranges = RANGE_KEYS;
  readonly showChips = SHOW_CHIPS;
  readonly formatUSD = formatUSD;
  readonly relativeTime = relativeTime;

  readonly fixed = computed(() => !!this.channelID());
  readonly loading = computed(() => this.listLoading() || this.summaryLoading());

  private subscriptions = new Subscription();
  private listRequest?: Subscription;
  private summaryRequest?: Subscription;
  private listKey = '';
  private summaryKey = '';
  /** After Next/Previous crosses a page: which row of the new page to open. */
  private pendingOpen: 'first' | 'last' | null = null;

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const view: ExplorerView = {
          range: pick(params.get('range'), RANGE_KEYS) ?? '7d',
          show: pick(params.get('show'), SHOWS),
          kind: pick(params.get('kind'), ['ai', 'rule'] as const),
          feedback: pick(params.get('feedback'), FEEDBACKS),
          channel: this.channelID() || params.get('channel') || null,
          chatter: params.get('chatter') || null,
          chatterName: params.get('chatterName')?.trim() || null,
          model: params.get('model') || null,
          source: pick(params.get('source'), SOURCES),
          sort: pick(params.get('sort'), SORT_KEYS) ?? 'newest',
          page: Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1),
        };
        this.view.set(view);
        this.openId.set(params.get('open') || null);
        const listKey = JSON.stringify(view);
        const summaryKey = JSON.stringify([view.range, view.channel, view.chatter]);
        if (listKey !== this.listKey) this.loadList();
        if (summaryKey !== this.summaryKey) this.loadSummary();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.listRequest?.unsubscribe();
    this.summaryRequest?.unsubscribe();
  }

  /** Reload the answer and the list (the header's Refresh). */
  refresh(): void {
    this.loadList();
    this.loadSummary();
  }

  private from(): string {
    return hoursAgo(rangeHours(this.view().range));
  }

  loadList(): void {
    const view = this.view();
    this.listKey = JSON.stringify(view);
    this.listRequest?.unsubscribe();
    this.listLoading.set(true);
    this.listError.set(null);
    const query: DecisionQuery = {
      channel: view.channel,
      chatter: view.chatter,
      chatterName: view.chatterName,
      show: view.show,
      kind: view.kind,
      source: view.source,
      model: view.model,
      feedback: view.feedback,
      from: this.from(),
      sort: view.sort === 'newest' ? null : view.sort,
      page: view.page,
      limit: LIMIT,
    };
    this.listRequest = this.api.list(query).subscribe({
      next: ({ data }) => {
        this.rows.set(data.rows);
        this.total.set(data.pagination.total);
        this.totalPages.set(Math.max(1, data.pagination.totalPages));
        this.listLoading.set(false);
        this.remember(data.rows.flatMap((row) => [[row.channelID, row.channel], [row.chatter.id, row.chatter.name]] as Array<[string, string | null]>));
        const pending = this.pendingOpen;
        this.pendingOpen = null;
        if (pending && data.rows.length) this.go({ open: (pending === 'first' ? data.rows[0] : data.rows[data.rows.length - 1]).id }, true);
      },
      error: (error: unknown) => {
        this.listLoading.set(false);
        this.pendingOpen = null;
        this.listError.set(apiErrorMessage(error, 'The server did not answer.'));
      },
    });
  }

  loadSummary(): void {
    const view = this.view();
    this.summaryKey = JSON.stringify([view.range, view.channel, view.chatter]);
    this.summaryRequest?.unsubscribe();
    this.summaryLoading.set(true);
    this.summaryError.set(false);
    this.summaryRequest = this.api.summary({ channel: view.channel, chatter: view.chatter, from: this.from() }).subscribe({
      next: ({ data }) => {
        this.summary.set(data);
        this.summaryLoading.set(false);
        this.remember(data.byChannel.map((row) => [row.channelID, row.channel]));
      },
      error: () => {
        this.summaryLoading.set(false);
        this.summaryError.set(true);
      },
    });
  }

  private remember(pairs: Array<[string, string | null]>): void {
    const fresh = pairs.filter((pair): pair is [string, string] => !!pair[0] && !!pair[1] && this.names()[pair[0]] !== pair[1]);
    if (fresh.length) this.names.update((names) => ({ ...names, ...Object.fromEntries(fresh) }));
  }

  /** Change filters in the URL. Anything but `page`/`open` starts again at page 1. */
  go(change: Partial<Record<keyof ExplorerView | 'open', string | number | null>>, replaceUrl = false): void {
    const params: Record<string, string | number | null> = { ...change };
    const keys = Object.keys(change);
    if (keys.some((key) => key !== 'page' && key !== 'open')) params['page'] = null;
    if (params['range'] === '7d') params['range'] = null;
    if (params['sort'] === 'newest') params['sort'] = null;
    if (params['page'] === 1) params['page'] = null;
    if (this.fixed()) delete params['channel'];
    void this.router.navigate([], { relativeTo: this.route, queryParams: params, queryParamsHandling: 'merge', replaceUrl });
  }

  setRange(range: ExplorerRange): void {
    this.go({ range });
  }

  chipPressed(chip: (typeof SHOW_CHIPS)[number]): boolean {
    const view = this.view();
    return chip.kind ? view.kind === chip.kind && !view.show : view.show === chip.show && !view.kind;
  }

  setChip(chip: (typeof SHOW_CHIPS)[number]): void {
    this.go({ show: chip.show, kind: chip.kind });
  }

  setFeedback(feedback: 'none' | 'any'): void {
    this.go({ feedback: this.view().feedback === feedback ? null : feedback });
  }

  /** Chip counts come from the summary, so they only show while nothing narrows the list further than the summary does. */
  readonly chipCounts = computed<Record<string, number> | null>(() => {
    const s = this.summary();
    const view = this.view();
    if (!s || view.chatterName || view.model || view.source || view.feedback) return null;
    return { all: s.total, bans: s.bans + s.bansFailed, not_reviewed: s.notReviewed, rule: s.ruleHits };
  });

  /** A chip's count as text, or null when the summary has no exact count for it. */
  countFor(key: string): string | null {
    const value = this.chipCounts()?.[key];
    return value === undefined ? null : formatNumber(value);
  }

  /** The filters from the sheet (and odd URL combinations) as removable chips. */
  readonly active = computed<ActiveFilter[]>(() => {
    const view = this.view();
    const names = this.names();
    const list: ActiveFilter[] = [];
    if (view.channel && !this.fixed()) list.push({ key: 'channel', label: `Streamer: ${names[view.channel] ?? 'picked channel'}`, clear: { channel: null } });
    if (view.chatter) list.push({ key: 'chatter', label: `Viewer: ${names[view.chatter] ?? 'picked viewer'}`, clear: { chatter: null } });
    if (view.chatterName) list.push({ key: 'chatterName', label: `Viewer: ${view.chatterName}`, clear: { chatterName: null } });
    if (view.model) list.push({ key: 'model', label: `Model: ${modelName(view.model)}`, clear: { model: null } });
    if (view.source) list.push({ key: 'source', label: `Why: ${SOURCE_LABEL[view.source]}`, clear: { source: null } });
    if (view.feedback === 'agree' || view.feedback === 'disagree')
      list.push({ key: 'feedback', label: view.feedback === 'agree' ? 'You agreed with the bot' : "You didn't agree with the bot", clear: { feedback: null } });
    if (view.kind === 'ai') list.push({ key: 'kind', label: 'AI reviews only', clear: { kind: null } });
    if (view.show && view.kind) list.push({ key: 'show', label: SHOW_LABEL[view.show], clear: { show: null } });
    if (view.show === 'acted') list.push({ key: 'show', label: SHOW_LABEL.acted, clear: { show: null } });
    if (view.sort !== 'newest') list.push({ key: 'sort', label: `Sorted: ${SORTS.find((s) => s.key === view.sort)!.label}`, clear: { sort: null } });
    return list;
  });
  /** How many filters live in the sheet: the badge on the Filters button. */
  readonly sheetCount = computed(() => this.active().filter((item) => !['kind', 'show'].includes(item.key)).length);
  readonly anyFilter = computed(() => {
    const view = this.view();
    return this.active().length > 0 || !!view.show || !!view.kind || !!view.feedback;
  });

  clearAll(): void {
    this.go({ show: null, kind: null, feedback: null, channel: null, chatter: null, chatterName: null, model: null, source: null, sort: null });
  }

  applyFilters(change: FiltersChange): void {
    if (change.channelName && change.channel) this.remember([[change.channel, change.channelName]]);
    const { channelName: _ignored, ...rest } = change;
    this.go(rest);
  }

  /** The plain-language answer for the range. */
  readonly answer = computed(() => {
    const s = this.summary();
    if (!s) return null;
    const view = this.view();
    const range = RANGE_TEXT[view.range];
    const viewer = view.chatter ? this.names()[view.chatter] : null;
    const n = s.total;
    let title: string;
    if (this.fixed()) {
      title = n ? `Chat protection reviewed ${formatNumber(n)} of this channel's messages ${range}` : `Chat protection reviewed none of this channel's messages ${range}.`;
    } else if (view.chatter) {
      title = n ? `${plural(n, 'message')} from ${viewer ?? 'this viewer'} reviewed ${range}` : `No messages from ${viewer ?? 'this viewer'} reviewed ${range}.`;
    } else {
      title = n ? `${plural(n, 'message')} reviewed ${range}` : `No messages reviewed ${range}.`;
    }
    if (n) {
      const parts = [`${formatNumber(s.bans)} banned`];
      if (s.notReviewed) parts.push(`${formatNumber(s.notReviewed)} couldn't be reviewed`);
      title += `: ${parts.join(', ')}.`;
      if (s.providerUSD > 0) title += ` It cost us ${formatUSD(s.providerUSD)}.`;
    }
    const share = s.aiReviews ? s.notReviewed / s.aiReviews : 0;
    const notableMissed = s.notReviewed >= 3 && share >= 0.05;
    const warnings: Array<{ text: string; show: DecisionShow; button: string }> = [];
    if (s.bansFailed) warnings.push({ text: `Twitch refused ${plural(s.bansFailed, 'ban')}.`, show: 'action_failed', button: 'See refused' });
    if (notableMissed)
      warnings.push({
        text: `${formatNumber(s.notReviewed)} of ${plural(s.aiReviews, 'AI review')} (${formatShare(s.notReviewed, s.aiReviews)}) didn't finish, so those messages went through unchecked.`,
        show: 'not_reviewed',
        button: "See what wasn't reviewed",
      });
    const facts: string[] = [];
    if (s.aiReviews && s.latencyP50Ms > 0) facts.push(`Typical review ${formatDuration(s.latencyP50Ms)}`);
    if (s.included) facts.push(`${formatNumber(s.included)} included free ${s.included === 1 ? 'review' : 'reviews'}`);
    if (s.labelled) facts.push(`You've judged ${formatNumber(s.labelled)}: ${formatNumber(s.agree)} agreed with the bot, ${formatNumber(s.disagree)} didn't`);
    else if (n) facts.push('No verdicts from you in this range yet');
    return { title, tone: warnings.length ? 'warn' : 'ok', warnings, facts };
  });

  /** One row as the list shows it. */
  line(row: DecisionRow): { outcome: ReturnType<typeof outcomeLabel>; meta: string[]; verdict: { agree: boolean } | null } {
    const top = row.kind === 'ai' ? topCategory(row) : null;
    const meta: string[] = [];
    if (row.kind === 'rule') meta.push(`${ruleName(row.ruleType)} rule`);
    else if (top) meta.push(`${categoryShort(top.key)} ${percent(top.value)}%`);
    meta.push(...rowCost(row));
    return { outcome: outcomeLabel(row), meta, verdict: row.feedback ? { agree: verdictAgrees(row.feedback.label, row.verdict) } : null };
  }

  // ---- The detail sheet ----

  readonly openRow = computed(() => this.rows().find((row) => row.id === this.openId()) ?? null);
  readonly openIndex = computed(() => this.rows().findIndex((row) => row.id === this.openId()));
  readonly openPosition = computed(() => {
    const index = this.openIndex();
    return index < 0 ? null : { index: index + (this.view().page - 1) * LIMIT, total: this.total() };
  });
  readonly hasPrev = computed(() => {
    const index = this.openIndex();
    return index > 0 || (index === 0 && this.view().page > 1);
  });
  readonly hasNext = computed(() => {
    const index = this.openIndex();
    return index >= 0 && (index < this.rows().length - 1 || this.view().page < this.totalPages());
  });

  open(row: DecisionRow): void {
    this.go({ open: row.id });
  }

  closeSheet(): void {
    this.go({ open: null }, true);
  }

  step(direction: -1 | 1): void {
    const index = this.openIndex();
    const rows = this.rows();
    if (index < 0) return;
    const next = rows[index + direction];
    if (next) {
      this.go({ open: next.id }, true);
      return;
    }
    // Off the end of this page: load the neighbouring page and open its first (or last) row.
    const page = this.view().page + direction;
    if (page < 1 || page > this.totalPages()) return;
    this.pendingOpen = direction > 0 ? 'first' : 'last';
    this.go({ page, open: null }, true);
  }

  onSaved(event: { id: string; feedback: DecisionRow['feedback'] }): void {
    this.rows.update((rows) => rows.map((row) => (row.id === event.id ? { ...row, feedback: event.feedback } : row)));
    // "You've judged…" in the answer counts verdicts: refresh it quietly.
    this.summaryRequest?.unsubscribe();
    this.summaryRequest = this.api.summary({ channel: this.view().channel, chatter: this.view().chatter, from: this.from() }).subscribe({
      next: ({ data }) => this.summary.set(data),
      error: () => undefined,
    });
  }

  onlyViewer(viewer: { id: string; name: string }): void {
    this.remember([[viewer.id, viewer.name]]);
    this.go({ chatter: viewer.id, chatterName: null, open: null }, false);
  }

  pickChannel(channel: { channelID: string; channel: string | null }): void {
    this.remember([[channel.channelID, channel.channel]]);
    this.go({ channel: channel.channelID });
  }

  readonly models = computed(() => this.summary()?.byModel.map((row) => row.model) ?? []);
}
