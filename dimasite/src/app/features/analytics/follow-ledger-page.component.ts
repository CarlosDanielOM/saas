import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowLeft,
  BarChart3,
  Lock,
  LucideAngularModule,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X
} from 'lucide-angular';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { LoadingIndicatorComponent } from '../../components/loading';
import {
  FollowLedgerMutualFilter,
  FollowLedgerPagination,
  FollowLedgerRow,
  FollowLedgerSortOrder,
  FollowLedgerSummary,
  FollowLedgerViewerRole
} from '../../models/follow-ledger.model';
import { AnalyticsApiService } from '../../services/analytics-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

@Component({
  selector: 'app-follow-ledger-page',
  imports: [RouterLink, LucideAngularModule, LoadingIndicatorComponent],
  templateUrl: './follow-ledger-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FollowLedgerPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly analyticsApi = inject(AnalyticsApiService);
  private readonly toastService = inject(ToastService);

  readonly backIcon = ArrowLeft;
  readonly searchIcon = Search;
  readonly clearIcon = X;
  readonly refreshIcon = RefreshCw;
  readonly followersIcon = Users;
  readonly sparklesIcon = Sparkles;
  readonly analyticsIcon = BarChart3;
  readonly lockIcon = Lock;

  readonly rows = signal<FollowLedgerRow[]>([]);
  readonly summary = signal<FollowLedgerSummary>({
    activeCount: 0,
    mutualCount: 0,
    nonMutualCount: 0
  });
  readonly pagination = signal<FollowLedgerPagination>({
    page: 1,
    limit: 24,
    total: 0,
    totalPages: 1
  });
  readonly viewerRole = signal<FollowLedgerViewerRole>('none');
  readonly channelName = signal('');
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly searchInput = signal('');
  readonly searchQuery = signal('');
  readonly mutualFilter = signal<FollowLedgerMutualFilter>('all');
  readonly sortOrder = signal<FollowLedgerSortOrder>('desc');
  readonly currentPage = signal(1);
  readonly itemsPerPage = signal(24);
  readonly itemsPerPageOptions = [24, 12, 48];

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({
          streamer,
          channelID: null,
          status: 'idle'
        });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({
          streamer,
          channelID,
          status: 'resolved' as const
        })),
        startWith({
          streamer,
          channelID: null,
          status: 'loading' as const
        })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });
  readonly channelResolution = toSignal(this.channelID$, {
    initialValue: {
      streamer: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase(),
      channelID: null,
      status: 'loading'
    } satisfies ChannelResolutionState
  });
  readonly channelID = computed(() => this.channelResolution().channelID);
  readonly planTier = computed(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
  readonly hasPaidAccess = computed(() => this.planTier() !== 'free');
  readonly showInitialLoading = computed(() => this.loading() && this.rows().length === 0);
  readonly showEmptyState = computed(() => !this.loading() && !this.errorMessage() && this.rows().length === 0);
  readonly pages = computed(() => {
    const total = this.pagination().totalPages;
    const current = this.currentPage();

    if (total <= 5) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }

    let start = current - 2;
    let end = current + 2;

    if (start < 1) {
      start = 1;
      end = 5;
    } else if (end > total) {
      end = total;
      start = total - 4;
    }

    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
  readonly resultRange = computed(() => {
    const pagination = this.pagination();
    if (pagination.total === 0) {
      return { start: 0, end: 0, total: 0 };
    }

    const start = (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.total, start + this.rows().length - 1);
    return {
      start,
      end,
      total: pagination.total
    };
  });

  private lastRequestKey = '';
  private requestSequence = 0;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();
      const hasPaidAccess = this.hasPaidAccess();
      const page = this.currentPage();
      const limit = this.itemsPerPage();
      const mutual = this.mutualFilter();
      const order = this.sortOrder();
      const search = this.searchQuery();

      if (!hasPaidAccess) {
        this.loading.set(false);
        this.refreshing.set(false);
        this.errorMessage.set(null);
        this.rows.set([]);
        this.summary.set({ activeCount: 0, mutualCount: 0, nonMutualCount: 0 });
        this.pagination.set({ page: 1, limit, total: 0, totalPages: 1 });
        this.lastRequestKey = '';
        return;
      }

      if (resolution.status === 'idle') {
        this.loading.set(false);
        this.errorMessage.set(this.t('analytics.follows.missingStreamer'));
        this.rows.set([]);
        this.lastRequestKey = '';
        return;
      }

      if (resolution.status === 'loading') {
        if (this.rows().length === 0) {
          this.loading.set(true);
        }
        return;
      }

      if (!resolution.channelID) {
        this.loading.set(false);
        this.errorMessage.set(this.t('analytics.follows.missingStreamer'));
        this.rows.set([]);
        this.lastRequestKey = '';
        return;
      }

      const nextKey = `${resolution.channelID}:${page}:${limit}:${mutual}:${order}:${search}`;
      if (nextKey === this.lastRequestKey) {
        return;
      }

      this.lastRequestKey = nextKey;
      void this.loadLedger(resolution.channelID);
    });
  }

  ngOnDestroy(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  trackFollower(row: FollowLedgerRow): string {
    return row.follower_id;
  }

  onSearchInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const value = target.value;
    this.searchInput.set(value);

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    this.searchDebounceTimer = setTimeout(() => {
      this.currentPage.set(1);
      this.searchQuery.set(value.trim());
    }, 220);
  }

  clearSearch(): void {
    this.searchInput.set('');
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.currentPage.set(1);
    this.searchQuery.set('');
  }

  setMutualFilter(filter: FollowLedgerMutualFilter): void {
    if (this.mutualFilter() === filter) {
      return;
    }

    this.currentPage.set(1);
    this.mutualFilter.set(filter);
  }

  setSortOrder(order: FollowLedgerSortOrder): void {
    if (this.sortOrder() === order) {
      return;
    }

    this.currentPage.set(1);
    this.sortOrder.set(order);
  }

  changePage(page: number): void {
    if (page < 1 || page > this.pagination().totalPages || page === this.currentPage()) {
      return;
    }

    this.currentPage.set(page);
  }

  onItemsPerPageChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    const value = Number.parseInt(target.value, 10);
    if (!this.itemsPerPageOptions.includes(value)) {
      return;
    }

    this.itemsPerPage.set(value);
    this.currentPage.set(1);
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID || !this.hasPaidAccess()) {
      return;
    }

    this.lastRequestKey = '';
    await this.loadLedger(channelID, true);
  }

  showUpgradeNotice(): void {
    this.toastService.warning(this.t('common.premiumFeature'), this.t('common.premiumSubscriptionRequired'));
  }

  formatFollowedAt(value: string): string {
    this.languageService.currentLanguage();

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return this.t('analytics.follows.durationUnknown');
    }

    const locale = this.languageService.currentLanguage() === 'es' ? 'es-ES' : 'en-US';
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  }

  formatFollowAge(value: string): string {
    this.languageService.currentLanguage();

    const followedAt = new Date(value);
    if (Number.isNaN(followedAt.getTime())) {
      return this.t('analytics.follows.durationUnknown');
    }

    const elapsedMs = Math.max(0, Date.now() - followedAt.getTime());
    const totalDays = Math.max(0, Math.floor(elapsedMs / 86400000));
    const years = Math.floor(totalDays / 365);
    const months = Math.floor((totalDays % 365) / 30);
    const days = totalDays - years * 365 - months * 30;
    const parts: string[] = [];

    if (years > 0) {
      parts.push(this.t('analytics.follows.durationYears', { count: years }));
    }
    if (months > 0) {
      parts.push(this.t('analytics.follows.durationMonths', { count: months }));
    }
    if (days > 0 || parts.length === 0) {
      parts.push(this.t('analytics.follows.durationDays', { count: days }));
    }

    if (parts.length === 1) {
      return parts[0];
    }

    return this.t('analytics.follows.durationPair', {
      first: parts[0],
      second: parts[1]
    });
  }

  getRoleLabel(): string {
    const role = this.viewerRole();
    if (role === 'owner') {
      return this.t('analytics.follows.ownerView');
    }
    if (role === 'admin') {
      return this.t('analytics.follows.adminView');
    }
    return '';
  }

  private async loadLedger(channelID: string, forcedRefresh = false): Promise<void> {
    const requestId = ++this.requestSequence;
    const hadRows = this.rows().length > 0;

    if (hadRows) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }

    if (forcedRefresh) {
      this.errorMessage.set(null);
    }

    try {
      const response = await firstValueFrom(
        this.analyticsApi.getFollowLedger(channelID, {
          status: 'active',
          mutual: this.mutualFilter(),
          order: this.sortOrder(),
          search: this.searchQuery(),
          page: this.currentPage(),
          limit: this.itemsPerPage()
        })
      );

      if (requestId !== this.requestSequence) {
        return;
      }

      if (response.error || !response.data) {
        throw new Error(response.message || this.t('analytics.follows.loadError'));
      }

      this.viewerRole.set(response.data.role);
      this.channelName.set(response.data.channelName);
      this.rows.set(response.data.rows);
      this.summary.set(response.data.summary);
      this.pagination.set(response.data.pagination);
      this.errorMessage.set(null);
    } catch (error) {
      if (requestId !== this.requestSequence) {
        return;
      }

      this.errorMessage.set(error instanceof Error ? error.message : this.t('analytics.follows.loadError'));
      if (!hadRows) {
        this.rows.set([]);
      }
    } finally {
      if (requestId === this.requestSequence) {
        this.loading.set(false);
        this.refreshing.set(false);
      }
    }
  }
}
