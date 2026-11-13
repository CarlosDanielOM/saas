import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { AssistantsApiService, type DocsAnswer, type DocsAnswerQuery, type DocsSummary } from '../../services/assistants-api.service';
import { DayBarsComponent, type DayBar } from '../../shared/day-bars/day-bars.component';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { RANGES, formatDuration, formatNumber, formatUSD, hoursAgo, isRangeKey, plural, rangeHours, type RangeKey } from '../../shared/format';
import { DocsAnswerComponent } from './docs-answer.component';
import { docsFailureLabel, langName, lowerFirst, wideScreen } from './assistants-format';

type Lang = NonNullable<DocsAnswerQuery['lang']>;
type Feedback = NonNullable<DocsAnswerQuery['feedback']>;
type Sort = NonNullable<DocsAnswerQuery['sort']>;

const LANGS: Lang[] = ['en', 'es'];
const FEEDBACK: Feedback[] = ['helpful', 'unhelpful', 'none'];
const SORTS: Sort[] = ['newest', 'cost', 'slowest'];
const PAGE_SIZE = 20;

interface Change {
  range?: RangeKey;
  lang?: Lang | null;
  feedback?: Feedback | null;
  sort?: Sort;
  page?: number;
}

/** `/ai/docs`: is the public "Ask the docs" helper used, does it answer, what does it cost. Visitors are anonymous. */
@Component({
  selector: 'app-docs-ai-page',
  templateUrl: './docs-ai-page.component.html',
  styleUrl: './docs-ai-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, SkeletonComponent, DayBarsComponent, DocsAnswerComponent],
})
export class DocsAiPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(AssistantsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly subscriptions = new Subscription();
  private summaryRequest?: Subscription;
  private answersRequest?: Subscription;
  private summaryKey = '';
  private answersKey = '';

  readonly ranges = RANGES.filter((range) => range.key !== '1h');
  readonly sorts: Array<{ key: Sort; label: string }> = [
    { key: 'newest', label: 'Newest' },
    { key: 'cost', label: 'Costliest' },
    { key: 'slowest', label: 'Slowest' },
  ];

  /** Desktop shows the numbers beside the list; phones fold them above it. */
  readonly wide = wideScreen();

  readonly range = signal<RangeKey>('30d');
  readonly lang = signal<Lang | null>(null);
  readonly feedback = signal<Feedback | null>(null);
  readonly sort = signal<Sort>('newest');
  readonly page = signal(1);

  readonly summary = signal<DocsSummary | null>(null);
  readonly summaryLoading = signal(true);
  readonly summaryFailed = signal(false);
  readonly rows = signal<DocsAnswer[]>([]);
  readonly total = signal(0);
  readonly totalPages = signal(1);
  readonly answersLoading = signal(true);
  readonly answersFailed = signal(false);

  readonly rangeLabel = computed(() => RANGES.find((range) => range.key === this.range())!.label);
  readonly days = computed<DayBar[]>(() => (this.summary()?.daily ?? []).map((day) => ({ date: day.date, value: day.asked, part: day.failed })));
  readonly formatCount = (value: number) => formatNumber(value);
  readonly formatNumber = formatNumber;
  readonly plural = plural;

  readonly answer = computed(() => {
    const summary = this.summary();
    if (!summary) return null;
    const t = summary.totals;
    const when = `in the last ${this.rangeLabel()}`;
    if (!t.asked) {
      return { tone: 'muted' as const, title: `No questions ${when}`, text: 'Questions visitors ask with "Ask the docs" on the documentation site show up here.', unhelpful: 0 };
    }
    const warn = t.failed > 0 && (t.failed / t.asked >= 0.05 || t.failed >= 5);
    const top = summary.failures[0];
    const cause = warn && top ? ` Most common reason: ${lowerFirst(docsFailureLabel(top.reason))}.` : '';
    return {
      tone: warn ? ('warn' as const) : ('ok' as const),
      title: `${plural(t.asked, 'question')} ${when}`,
      text:
        `${formatNumber(t.answered)} answered, ${formatNumber(t.abandoned)} abandoned before the answer, ${formatNumber(t.failed)} failed. ` +
        `It cost ${formatUSD(t.providerUSD)}. ${formatNumber(t.helpful)} rated helpful, ${formatNumber(t.unhelpful)} not helpful.${cause}`,
      unhelpful: t.unhelpful,
    };
  });

  readonly costLine = computed(() => {
    const summary = this.summary();
    if (!summary) return '';
    const { providerUSD, answered } = summary.totals;
    const parts = [`${formatUSD(providerUSD)} in total`];
    if (answered) parts.push(`${formatUSD(providerUSD / answered)} per answer`);
    if (summary.medianDurationMs) parts.push(`typical answer in ${formatDuration(summary.medianDurationMs)}`);
    return parts.join(' · ');
  });

  readonly langs = computed(() => {
    const rows = this.summary()?.byLang ?? [];
    const max = Math.max(1, ...rows.map((row) => row.answers));
    return rows.map((row) => ({ ...row, name: langName(row.lang), share: (row.answers / max) * 100 }));
  });
  readonly pages = computed(() => {
    const rows = this.summary()?.topPages ?? [];
    const max = Math.max(1, ...rows.map((row) => row.answers));
    return rows.map((row) => ({ ...row, share: (row.answers / max) * 100 }));
  });
  readonly failures = computed(() => (this.summary()?.failures ?? []).map((row) => ({ ...row, label: docsFailureLabel(row.reason) })));

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.queryParamMap.subscribe((params) => {
        const range = params.get('range');
        this.range.set(isRangeKey(range) && range !== '1h' ? range : '30d');
        const lang = params.get('lang') as Lang;
        this.lang.set(LANGS.includes(lang) ? lang : null);
        const feedback = params.get('feedback') as Feedback;
        this.feedback.set(FEEDBACK.includes(feedback) ? feedback : null);
        const sort = params.get('sort') as Sort;
        this.sort.set(SORTS.includes(sort) ? sort : 'newest');
        this.page.set(Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
        this.load();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.summaryRequest?.unsubscribe();
    this.answersRequest?.unsubscribe();
  }

  load(force = false): void {
    if (force || this.range() !== this.summaryKey || this.summaryFailed()) {
      this.summaryKey = this.range();
      this.summaryRequest?.unsubscribe();
      this.summaryLoading.set(true);
      this.summaryFailed.set(false);
      this.summaryRequest = this.api.docsSummary({ from: hoursAgo(rangeHours(this.range())) }).subscribe({
        next: ({ data }) => {
          this.summary.set(data);
          this.summaryLoading.set(false);
        },
        error: () => {
          this.summaryFailed.set(true);
          this.summaryLoading.set(false);
        },
      });
    }
    const query: DocsAnswerQuery = { lang: this.lang(), feedback: this.feedback(), sort: this.sort() === 'newest' ? null : this.sort(), page: this.page(), limit: PAGE_SIZE };
    const key = JSON.stringify(query);
    if (force || key !== this.answersKey || this.answersFailed()) {
      this.answersKey = key;
      this.answersRequest?.unsubscribe();
      this.answersLoading.set(true);
      this.answersFailed.set(false);
      this.answersRequest = this.api.docsAnswers(query).subscribe({
        next: ({ data }) => {
          this.rows.set(data.rows);
          this.total.set(data.pagination.total);
          this.totalPages.set(Math.max(1, data.pagination.totalPages));
          this.answersLoading.set(false);
        },
        error: () => {
          this.answersFailed.set(true);
          this.answersLoading.set(false);
        },
      });
    }
  }

  go(change: Change): void {
    const next = {
      range: change.range ?? this.range(),
      lang: change.lang !== undefined ? change.lang : this.lang(),
      feedback: change.feedback !== undefined ? change.feedback : this.feedback(),
      sort: change.sort ?? this.sort(),
      page: change.page ?? 1,
    };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        range: next.range === '30d' ? null : next.range,
        lang: next.lang || null,
        feedback: next.feedback || null,
        sort: next.sort === 'newest' ? null : next.sort,
        page: next.page > 1 ? next.page : null,
      },
    });
  }

  toggleLang(lang: Lang): void {
    this.go({ lang: this.lang() === lang ? null : lang });
  }

  toggleFeedback(feedback: Feedback): void {
    this.go({ feedback: this.feedback() === feedback ? null : feedback });
  }

  /** "See the N not helpful": the most useful shortcut on the page. */
  seeUnhelpful(): void {
    this.go({ feedback: 'unhelpful', lang: null });
    queueMicrotask(() => document.getElementById('docs-list-h')?.scrollIntoView({ block: 'start' }));
  }
}
