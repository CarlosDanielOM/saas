import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { UsageApiService, type UsageCategoryKey, type UsageFilters, type UsageSummary } from '../../services/usage-api.service';
import { DayBarsComponent, type DayBar } from '../../shared/day-bars/day-bars.component';
import {
  RANGES,
  formatCompact,
  formatCreditValue,
  formatCredits,
  formatNumber,
  formatUSD,
  hoursAgo,
  isRangeKey,
  plural,
  rangeHours,
  shortDay,
  type RangeKey,
} from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { UsageBreakdownComponent, type BreakdownRow } from './usage-breakdown.component';
import { UsageCallsComponent } from './usage-calls.component';
import { UsageFilterSheetComponent, type SheetChange } from './usage-filter-sheet.component';
import { ALWAYS_SHOWN_CHIPS, CATEGORY_CHIPS, CATEGORY_LABEL, isCategoryKey, modelName, modelOrProvider, planChipClass, planLabel, sourceLabel } from './usage-labels';

export type UsageView = 'channels' | 'viewers' | 'models' | 'days' | 'calls';
const VIEWS: Array<{ key: UsageView; label: string }> = [
  { key: 'channels', label: 'Channels' },
  { key: 'viewers', label: 'Viewers' },
  { key: 'models', label: 'Models' },
  { key: 'days', label: 'Days' },
  { key: 'calls', label: 'Every call' },
];
const USAGE_RANGES = RANGES.filter((range) => range.key !== '1h');
const ID = /^\d{1,20}$/;
const text = (value: string | null): string | null => (value && value.length <= 160 ? value : null);

/** Everything the URL holds. */
export interface UsageState {
  range: RangeKey;
  category: UsageCategoryKey | null;
  channel: string | null;
  actor: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  view: UsageView;
  sort: 'newest' | 'credits';
  kinds: 'usage' | 'all';
}

const DEFAULT: UsageState = { range: '7d', category: null, channel: null, actor: null, provider: null, model: null, source: null, view: 'channels', sort: 'newest', kinds: 'usage' };

@Component({
  selector: 'app-usage-page',
  templateUrl: './usage-page.component.html',
  styleUrl: './usage-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent, DayBarsComponent, UsageBreakdownComponent, UsageCallsComponent, UsageFilterSheetComponent],
})
export class UsagePageComponent implements OnInit, OnDestroy {
  private readonly api = inject(UsageApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly subscriptions = new Subscription();
  private request?: Subscription;
  private countsRequest?: Subscription;

  readonly ranges = USAGE_RANGES;
  readonly views = VIEWS;
  readonly state = signal<UsageState>(DEFAULT);
  readonly summary = signal<UsageSummary | null>(null);
  /** The filters the summary on screen belongs to. */
  private readonly summaryKey = signal<string | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  /** Category counts for the chips: from a summary without the category filter. */
  private readonly counts = signal<{ key: string; rows: UsageSummary['byCategory'] } | null>(null);
  /** Names seen in any summary or picked in the sheet, so a filter chip never shows a bare id. */
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());
  readonly sheetOpen = signal(false);

  readonly credits = formatCredits;
  readonly value = formatCreditValue;
  readonly usd = formatUSD;
  readonly num = formatNumber;
  readonly plural = plural;
  readonly dayFormat = (credits: number) => `${formatCredits(credits, true)} ${formatCreditValue(credits)}`;

  /** The API filters (no view, sort or row kinds). */
  readonly filters = computed<UsageFilters>(() => {
    const s = this.state();
    return { from: hoursAgo(rangeHours(s.range)), category: s.category, channel: s.channel, actor: s.actor, provider: s.provider, model: s.model, source: s.source };
  });
  private readonly filterKey = computed(() => {
    const s = this.state();
    return JSON.stringify([s.range, s.category, s.channel, s.actor, s.provider, s.model, s.source]);
  });
  private readonly countsKey = computed(() => {
    const s = this.state();
    return JSON.stringify([s.range, s.channel, s.actor, s.provider, s.model, s.source]);
  });
  readonly rangeText = computed(() => `the last ${USAGE_RANGES.find((range) => range.key === this.state().range)!.label}`);

  readonly chips = computed(() => {
    const counts = this.counts();
    const rows = counts && counts.key === this.countsKey() ? counts.rows : null;
    const count = (key: UsageCategoryKey) => (rows ? (rows.find((row) => row.category === key)?.count ?? 0) : null);
    const total = rows ? rows.reduce((sum, row) => sum + row.count, 0) : null;
    const active = this.state().category;
    return [
      { key: null as UsageCategoryKey | null, label: 'All', count: total },
      ...CATEGORY_CHIPS.filter((key) => ALWAYS_SHOWN_CHIPS.has(key) || key === active || (count(key) ?? 0) > 0).map((key) => ({ key, label: CATEGORY_LABEL[key], count: count(key) })),
    ];
  });

  readonly channelName = computed(() => this.nameOf(this.state().channel));
  readonly actorName = computed(() => this.nameOf(this.state().actor));
  readonly sheetCount = computed(() => {
    const s = this.state();
    return [s.channel, s.actor, s.provider, s.model, s.source].filter(Boolean).length;
  });
  readonly activeFilters = computed(() => {
    const s = this.state();
    const list: Array<{ key: keyof UsageState; label: string; value: string }> = [];
    if (s.channel) list.push({ key: 'channel', label: 'Streamer', value: this.channelName() });
    if (s.actor) list.push({ key: 'actor', label: 'Viewer', value: this.actorName() });
    if (s.provider) list.push({ key: 'provider', label: 'Provider', value: s.provider });
    if (s.model) list.push({ key: 'model', label: 'Model', value: modelName(s.model)! });
    if (s.source) list.push({ key: 'source', label: 'Source', value: sourceLabel(s.source) });
    return list;
  });
  /** "Limited to voice, from pixel_harbor, …" when any filter is on. */
  readonly limitedTo = computed(() => {
    const s = this.state();
    const parts: string[] = [];
    if (s.category) parts.push(CATEGORY_LABEL[s.category].toLowerCase());
    if (s.channel) parts.push(`streamer ${this.channelName()}`);
    if (s.actor) parts.push(`viewer ${this.actorName()}`);
    if (s.provider) parts.push(`provider ${s.provider}`);
    if (s.model) parts.push(`model ${modelName(s.model)}`);
    if (s.source) parts.push(`source “${sourceLabel(s.source)}”`);
    return parts.length ? `Limited to ${parts.join(', ')}.` : '';
  });

  readonly channelRows = computed<BreakdownRow[]>(() => {
    const summary = this.summary();
    if (!summary) return [];
    return summary.byChannel.map((row) => ({
      id: row.channelID,
      name: row.channel || 'Unknown channel',
      sub: plural(row.count, 'call'),
      chip: planLabel(row.planTier),
      chipClass: planChipClass(row.planTier),
      totals: row,
      active: row.channelID === this.state().channel,
    }));
  });
  readonly viewerRows = computed<BreakdownRow[]>(() => {
    const summary = this.summary();
    if (!summary) return [];
    return summary.byActor.map((row) => ({
      id: row.actor.id ?? '',
      name: row.actor.name || row.actor.login || 'Viewer without a name',
      sub: plural(row.count, 'call'),
      mono: row.actor.name || row.actor.login ? null : row.actor.id,
      totals: row,
      active: row.actor.id === this.state().actor,
    }));
  });
  readonly modelRows = computed<BreakdownRow[]>(() => {
    const summary = this.summary();
    if (!summary) return [];
    return summary.byModel.map((row) => ({
      id: JSON.stringify([row.provider, row.model]),
      name: modelOrProvider(row.model, row.provider),
      sub: `${CATEGORY_LABEL[row.category] ?? 'Other'} · ${row.provider} · ${plural(row.count, 'call')}`,
      monoName: true,
      totals: row,
      active: row.model ? row.model === this.state().model : row.provider === this.state().provider,
    }));
  });
  /** How many calls in the range name a viewer. */
  readonly viewerCoverage = computed(() => {
    const summary = this.summary();
    if (!summary) return null;
    return { known: summary.totals.withActor, total: summary.totals.count, viewers: summary.totals.chatters };
  });
  readonly days = computed<DayBar[]>(() => (this.summary()?.daily ?? []).map((day) => ({ date: day.date, value: day.credits })));
  readonly dayRows = computed(() => [...(this.summary()?.daily ?? [])].reverse());

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const range = params.get('range');
        const category = params.get('category');
        const channel = params.get('channel');
        const actor = params.get('actor');
        const view = params.get('view') as UsageView;
        const next: UsageState = {
          range: isRangeKey(range) && range !== '1h' ? range : '7d',
          category: isCategoryKey(category) ? category : null,
          channel: channel && ID.test(channel) ? channel : null,
          actor: actor && ID.test(actor) ? actor : null,
          provider: text(params.get('provider')),
          model: text(params.get('model')),
          source: text(params.get('source')),
          view: VIEWS.some((item) => item.key === view) ? view : 'channels',
          sort: params.get('sort') === 'credits' ? 'credits' : 'newest',
          kinds: params.get('kinds') === 'all' ? 'all' : 'usage',
        };
        this.state.set(next);
        if (this.summaryKey() !== this.filterKey()) this.load();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.request?.unsubscribe();
    this.countsRequest?.unsubscribe();
  }

  load(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.failed.set(false);
    const key = this.filterKey();
    const countsKey = this.countsKey();
    const withCategory = this.state().category !== null;
    this.request = this.api.summary(this.filters()).subscribe({
      next: ({ data }) => {
        this.summary.set(data);
        this.summaryKey.set(key);
        this.loading.set(false);
        this.remember(data);
        if (!withCategory) this.counts.set({ key: countsKey, rows: data.byCategory });
      },
      error: () => {
        this.loading.set(false);
        this.failed.set(true);
      },
    });
    // The chips keep their counts while one feature is picked: ask once for the summary without it.
    if (withCategory && this.counts()?.key !== countsKey) {
      this.countsRequest?.unsubscribe();
      this.countsRequest = this.api.summary({ ...this.filters(), category: null }).subscribe({
        next: ({ data }) => {
          this.counts.set({ key: countsKey, rows: data.byCategory });
          this.remember(data);
        },
        error: () => undefined,
      });
    }
  }

  go(change: Partial<UsageState>): void {
    const next = { ...this.state(), ...change };
    const params: Record<string, string | null> = {};
    for (const key of Object.keys(DEFAULT) as Array<keyof UsageState>) {
      params[key] = next[key] === DEFAULT[key] ? null : (next[key] as string);
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams: params });
  }

  clearFilters(): void {
    this.go({ category: null, channel: null, actor: null, provider: null, model: null, source: null });
  }

  removeFilter(key: keyof UsageState): void {
    this.go({ [key]: null });
  }

  onSheet(change: SheetChange): void {
    if (change.name) this.names.update((names) => new Map(names).set(change.name!.id, change.name!.label));
    if (change.view) this.sheetOpen.set(false);
    this.go(change.state);
  }

  pickChannel(row: BreakdownRow): void {
    this.go({ channel: row.active ? null : row.id });
  }

  pickViewer(row: BreakdownRow): void {
    if (!row.id) return;
    this.go({ actor: row.active ? null : row.id });
  }

  pickModel(row: BreakdownRow): void {
    const [provider, model] = JSON.parse(row.id) as [string, string | null];
    if (row.active) this.go(model ? { model: null } : { provider: null });
    else this.go(model ? { model } : { provider });
  }

  tabKey(event: KeyboardEvent, index: number): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = VIEWS[(index + step + VIEWS.length) % VIEWS.length];
    this.go({ view: next.key });
    queueMicrotask(() => (document.getElementById(`usage-tab-${next.key}`) as HTMLElement | null)?.focus());
  }

  day(date: string): string {
    return shortDay(date);
  }

  compact(value: number): string {
    return formatCompact(value);
  }

  private nameOf(id: string | null): string {
    return id ? (this.names().get(id) ?? id) : '';
  }

  private remember(data: UsageSummary): void {
    const names = new Map(this.names());
    for (const row of data.byChannel) if (row.channel) names.set(row.channelID, row.channel);
    for (const row of data.byActor) if (row.actor.id && (row.actor.name || row.actor.login)) names.set(row.actor.id, (row.actor.name || row.actor.login)!);
    this.names.set(names);
  }
}
