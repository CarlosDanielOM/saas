import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Observable, Subscription } from 'rxjs';

import type { Envelope } from '../../services/api-util';
import { AssistantsApiService, type AssistantSummary, type DocsSummary } from '../../services/assistants-api.service';
import { DecisionsApiService, type DecisionSummary } from '../../services/decisions-api.service';
import { OverviewApiService, type AdminOverview, type SpendFeature } from '../../services/overview-api.service';
import { UsageApiService, type UsageSummary, type UsageTotals } from '../../services/usage-api.service';
import { DayBarsComponent, type DayBar } from '../../shared/day-bars/day-bars.component';
import { RANGES, formatCreditValue, formatCredits, formatNumber, formatUSD, hoursAgo, isRangeKey, plural, rangeHours, type RangeKey } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { CATEGORY_LABEL, modelOrProvider, planChipClass, planLabel } from '../usage/usage-labels';

const HUB_RANGES = RANGES.filter((range) => range.key !== '1h');

/** One block's data: each loads on its own so a slow or failing call never blanks the page. */
export class Slot<T> {
  readonly data = signal<T | null>(null);
  /** The range the shown data covers (it trails the chosen range while a new one loads). */
  readonly range = signal<RangeKey | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  private request?: Subscription;

  constructor(private readonly fetch: (from: string) => Observable<Envelope<T>>) {}

  load(range: RangeKey): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.failed.set(false);
    this.request = this.fetch(hoursAgo(rangeHours(range))).subscribe({
      next: ({ data }) => {
        this.data.set(data);
        this.range.set(range);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.failed.set(true);
      },
    });
  }

  stop(): void {
    this.request?.unsubscribe();
  }
}

const ZERO: UsageTotals = { count: 0, credits: 0, providerUSD: 0, providerKnown: 0 };
const minus = (a: UsageTotals, b: UsageTotals | undefined): UsageTotals =>
  b
    ? {
        count: Math.max(0, a.count - b.count),
        credits: Math.max(0, a.credits - b.credits),
        providerUSD: Math.max(0, a.providerUSD - b.providerUSD),
        providerKnown: Math.max(0, a.providerKnown - b.providerKnown),
      }
    : a;

export interface HubModel {
  key: string;
  name: string;
  use: string;
  calls: number;
  credits: number | null;
  providerUSD: number | null;
}

@Component({
  selector: 'app-ai-hub-page',
  templateUrl: './ai-hub-page.component.html',
  styleUrl: './ai-hub-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent, DayBarsComponent],
})
export class AiHubPageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly overviewApi = inject(OverviewApiService);
  private readonly decisionsApi = inject(DecisionsApiService);
  private readonly usageApi = inject(UsageApiService);
  private readonly assistantsApi = inject(AssistantsApiService);
  private readonly subscriptions = new Subscription();

  readonly ranges = HUB_RANGES;
  readonly range = signal<RangeKey>('7d');
  readonly rangeText = computed(() => this.labelOf(this.range()));

  /** Always the last 7 days: failure counts and channels out of credits. */
  readonly overview = new Slot<AdminOverview>(() => this.overviewApi.get());
  readonly usage = new Slot<UsageSummary>((from) => this.usageApi.summary({ from }));
  readonly decisions = new Slot<DecisionSummary>((from) => this.decisionsApi.summary({ from }));
  readonly assistant = new Slot<AssistantSummary>((from) => this.assistantsApi.assistantSummary({ from }));
  readonly docs = new Slot<DocsSummary>((from) => this.assistantsApi.docsSummary({ from }));
  private readonly slots: Array<Slot<unknown>> = [this.usage, this.decisions, this.assistant, this.docs];

  readonly credits = formatCredits;
  readonly value = formatCreditValue;
  readonly usd = formatUSD;
  readonly num = formatNumber;
  readonly plural = plural;
  readonly dayFormat = (credits: number) => `${formatCredits(credits, true)} ${formatCreditValue(credits)}`;

  /** Charged chat protection reviews also leave usage receipts: they are counted once, under chat protection. */
  private readonly protectionReceipts = computed(() => this.usage.data()?.bySource.find((row) => row.source === 'moderation'));
  readonly voice = computed<UsageTotals | null>(() => {
    const usage = this.usage.data();
    return usage ? (usage.byCategory.find((row) => row.category === 'tts') ?? ZERO) : null;
  });
  readonly chatAI = computed<UsageTotals | null>(() => {
    const usage = this.usage.data();
    return usage ? minus(minus(usage.totals, this.voice() ?? undefined), this.protectionReceipts()) : null;
  });

  /** Failures over the last 7 days, from the overview. */
  readonly failed7d = computed(() => {
    const features = this.overview.data()?.features ?? [];
    const sum = (...keys: SpendFeature[]) => features.filter((row) => keys.includes(row.feature)).reduce((total, row) => total + row.failed, 0);
    return { voice: sum('voice'), chatAI: sum('ai_chat', 'memory', 'other') };
  });

  readonly waiting = computed<number | null>(() => {
    const decisions = this.decisions.data();
    if (decisions) return decisions.verdictsWaiting;
    const overview = this.overview.data();
    return overview ? (overview.attention.find((row) => row.key === 'verdicts_waiting')?.count ?? 0) : null;
  });
  readonly outOfCredits = computed(() => this.overview.data()?.attention.find((row) => row.key === 'credits_exhausted')?.count ?? 0);

  /** What providers charged us, from every block that loaded, and which blocks are missing from it. */
  readonly provider = computed(() => {
    const parts = [
      { name: 'chat protection', slot: this.decisions, usd: this.decisions.data()?.providerUSD },
      { name: 'the Dima assistant', slot: this.assistant, usd: this.assistant.data()?.totals.providerUSD },
      { name: 'Docs AI', slot: this.docs, usd: this.docs.data()?.totals.providerUSD },
    ];
    const chat = this.chatAI();
    const usd = (chat?.providerUSD ?? 0) + parts.reduce((sum, part) => sum + (part.usd ?? 0), 0);
    const missing = parts.filter((part) => part.usd === undefined && part.slot.failed()).map((part) => part.name);
    return { usd, missing, pending: parts.some((part) => part.usd === undefined && part.slot.loading()) };
  });

  readonly days = computed<DayBar[]>(() => (this.usage.data()?.daily ?? []).map((day) => ({ date: day.date, value: day.credits })));
  readonly topChannels = computed(() => {
    const usage = this.usage.data();
    if (!usage) return [];
    const top = usage.byChannel[0]?.credits || 1;
    return usage.byChannel.slice(0, 5).map((row) => ({ ...row, width: Math.max(1, Math.min(100, (row.credits / top) * 100)), plan: planLabel(row.planTier), planClass: planChipClass(row.planTier) }));
  });

  readonly models = computed<HubModel[]>(() => {
    const rows: HubModel[] = [];
    for (const row of this.usage.data()?.byModel ?? []) {
      if (row.count === 0) continue;
      rows.push({
        key: `u:${row.provider}:${row.model}:${row.category}`,
        name: modelOrProvider(row.model, row.provider),
        use: CATEGORY_LABEL[row.category] ?? 'Other',
        calls: row.count,
        credits: row.credits,
        providerUSD: row.providerKnown > 0 ? row.providerUSD : null,
      });
    }
    for (const row of this.decisions.data()?.byModel ?? []) {
      if (row.reviews === 0) continue;
      rows.push({ key: `d:${row.model}`, name: modelOrProvider(row.model, null), use: 'Chat protection', calls: row.reviews, credits: null, providerUSD: row.providerUSD });
    }
    return rows.sort((a, b) => b.calls - a.calls).slice(0, 6);
  });

  ngOnInit(): void {
    this.overview.load('7d');
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const value = params.get('range');
        const next: RangeKey = isRangeKey(value) && value !== '1h' ? value : '7d';
        if (next === this.range() && this.usage.data() !== null) return;
        this.range.set(next);
        this.reload();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    for (const slot of [this.overview, ...this.slots]) slot.stop();
  }

  reload(): void {
    const range = this.range();
    for (const slot of this.slots) slot.load(range);
  }

  setRange(range: RangeKey): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { range: range === '7d' ? null : range }, queryParamsHandling: 'merge' });
  }

  labelOf(range: RangeKey | null): string {
    return `the last ${HUB_RANGES.find((item) => item.key === range)?.label ?? '7 days'}`;
  }

  /** Query params for links into the AI pages, keeping the chosen range. */
  link(extra: Record<string, string | null> = {}): Record<string, string | null> {
    return { range: this.range() === '7d' ? null : this.range(), ...extra };
  }
}
