import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  OnDestroy,
  OnInit,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import * as echarts from 'echarts';
import { EChartsOption } from 'echarts';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';
import { distinctUntilChanged, map, of, shareReplay, Subscription, switchMap } from 'rxjs';

import { ActivityCounters } from '../../models/activity.model';
import {
  DashboardKpis,
  DashboardStreamHistoryPoint,
  LiveSessionMetrics,
  AiCreditsData
} from '../../models/dashboard.model';
import { DashboardApiService } from '../../services/dashboard-api.service';
import { DashboardChartConfigService } from '../../services/dashboard-chart-config.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { getRouteParam, watchRouteParam } from '../../shared/utils/route-param.util';
import { StreamHealthStatus } from './components/stream-health.component';
import { LoadingIndicatorComponent } from '../../components/loading';
import { ReferralPromoBannerComponent } from '../../shared/referral-promo-banner/referral-promo-banner.component';
import { environment } from '../../../environments/environment';

type TimeRange = '7d' | '15d' | '30d';
type MobilePanel = 'chart' | 'goals';

interface DailySeriesBucket {
  bits: number;
  donations: number;
  subs: number;
  hours: number;
  follows: number;
  viewersTotal: number;
  viewersCount: number;
}

type DashboardViewerRole = 'owner' | 'admin' | 'viewer';

@Component({
  selector: 'app-dashboard',
  imports: [
    NgxEchartsDirective,
    CountUpDirective,
    LoadingIndicatorComponent,
    ReferralPromoBannerComponent
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
  providers: [provideEchartsCore({ echarts })],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly dashboardApi = inject(DashboardApiService);
  private readonly chartConfig = inject(DashboardChartConfigService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);
  private readonly numberFormatter = new Intl.NumberFormat();
  private readonly compactNumberFormatter = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1
  });
  private readonly currencyFormatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  private readonly compactCurrencyFormatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1
  });
  private readonly tableDateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
  private readonly streamerParam$ = watchRouteParam(this.route, 'streamer').pipe(
    map((value) => (value ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private dashboardLoadSub?: Subscription;
  private timeContextInterval: number | null = null;
  private streamHealthInterval: number | null = null;
  private overviewChartInstance: echarts.EChartsType | null = null;
  private activeTooltipDataIndex: number | null = null;
  private viewportResizeHandler: (() => void) | null = null;

  readonly selectedTimeRange = signal<TimeRange>('30d');
  readonly selectedMobilePanel = signal<MobilePanel>('chart');
  readonly timeRanges: TimeRange[] = ['7d', '15d', '30d'];
  readonly isMobileViewport = signal(false);
  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });
  readonly channelID = signal<string | null>(null);
  readonly bootstrap = computed(() => this.dashboardApi.bootstrapData()?.data ?? null);
  readonly loading = computed(() => this.dashboardApi.loading());
  readonly connectionStatus = computed(() => this.dashboardApi.connectionStatus());
  readonly connectionTooltip = computed(() =>
    this.t(`dashboard.connectionTooltip.${this.connectionStatus()}`)
  );
  readonly errorMessage = signal<string | null>(null);

  readonly kpis = computed<DashboardKpis>(() => this.bootstrap()?.kpis ?? this.emptyKpis());
  readonly planTier = computed(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
  readonly channelName = computed(() => this.bootstrap()?.channel.name ?? '');
  readonly profileImageUrl = signal<string | null>(null);
  readonly displayName = computed(() => {
    const name = this.channelName().trim();
    if (name) {
      return name;
    }
    const login = this.streamer().trim();
    return login || '—';
  });
  readonly avatarUrl = computed(() => {
    const fromProfile = this.profileImageUrl();
    if (fromProfile) {
      return fromProfile;
    }
    const session = this.sessionAuth.session();
    const sessionLogin = (session?.twitchUser.login || '').trim().toLowerCase();
    if (sessionLogin && sessionLogin === this.streamer() && session?.twitchUser.profile_image_url) {
      return session.twitchUser.profile_image_url;
    }
    return null;
  });
  readonly avatarLetter = computed(() => {
    const name = this.displayName().trim();
    return name ? name.charAt(0).toUpperCase() : '?';
  });
  readonly viewerRole = computed<DashboardViewerRole | null>(() => this.bootstrap()?.role ?? null);
  readonly viewerRoleLabel = computed(() => {
    const role = this.viewerRole();
    if (role === 'owner' || role === 'admin') {
      return this.t(`dashboard.roles.${role}`);
    }

    return '';
  });
  readonly streamHistoryData = computed<DashboardStreamHistoryPoint[]>(() => {
    const history = this.getDisplayStreamHistory();
    return this.filterByTimeRange(history);
  });
  readonly streamHistoryRows = computed<DashboardStreamHistoryPoint[]>(() => {
    const history = [...this.streamHistoryData()];
    history.sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
    return history;
  });
  readonly totalFollowers = computed(() => this.bootstrap()?.totalFollowers ?? 0);
  readonly totalSubs = computed(() => this.bootstrap()?.totalSubs ?? 0);
  readonly monthlyGoals = computed(() =>
    this.bootstrap()?.monthlyGoals ?? {
      followersGoal: 1000,
      followersCurrent: 0,
      subsGoal: 1000,
      subsCurrent: 0
    }
  );
  readonly followersGoalPercent = computed(() =>
    this.calculateGoalPercent(this.monthlyGoals().followersCurrent, this.monthlyGoals().followersGoal)
  );
  readonly subsGoalPercent = computed(() =>
    this.calculateGoalPercent(this.monthlyGoals().subsCurrent, this.monthlyGoals().subsGoal)
  );

  // AI Credits (5th KPI tile)
  readonly aiCreditsData = computed(() => this.dashboardApi.aiCredits());
  readonly aiCreditsAvailable = computed(() => this.aiCreditsData()?.available ?? false);
  readonly aiCreditsUsed = computed(() => this.aiCreditsData()?.used ?? 0);
  readonly aiCreditsLimit = computed(() => this.aiCreditsData()?.limit ?? 0);
  readonly aiCreditsPercent = computed(() => {
    const used = this.aiCreditsUsed();
    const limit = this.aiCreditsLimit();
    if (!limit || limit <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  });
  readonly aiCreditsExhausted = computed(() => {
    const data = this.aiCreditsData();
    if (!data) return false;
    return data.available && data.balance <= 0;
  });
  readonly aiCreditsLabel = computed(() => {
    const used = this.formatAiCredits(this.aiCreditsUsed());
    const limit = this.formatAiCredits(this.aiCreditsLimit());
    return `${used} / ${limit}`;
  });
  readonly aiCreditsUpsell = computed(() => {
    if (!this.aiCreditsExhausted()) return '';
    const tier = this.planTier();
    if (tier === 'free') return this.t('dashboard.kpis.aiCreditsExhaustedFree');
    if (tier === 'premium') return this.t('dashboard.kpis.aiCreditsExhaustedPremium');
    return this.t('dashboard.kpis.aiCreditsExhaustedPro');
  });
  readonly aiCreditsNotAvailableLabel = computed(() =>
    this.t('dashboard.kpis.aiCreditsNotAvailable')
  );

  readonly currentTimeContext = signal(new Date());
  readonly serverTimeDisplay = computed(() => this.formatTimeContext(this.currentTimeContext(), 'UTC'));
  readonly localTimeDisplay = computed(() => this.formatTimeContext(this.currentTimeContext()));

  readonly overviewChartOption = signal<EChartsOption>({});

  // Live stream status
  readonly isLive = computed(() => this.dashboardApi.liveStatus()?.data?.isLive ?? false);
  readonly liveStream = computed(() => this.dashboardApi.liveStatus()?.data?.stream ?? null);

  // Chat enabled status
  readonly chatEnabled = computed(() => this.bootstrap()?.channel.chatEnabled ?? false);
  readonly isTogglingChat = signal<boolean>(false);

  readonly activityCounters = computed<ActivityCounters>(() => {
    const liveMetrics = this.dashboardApi.liveSessionMetrics();

    return {
      follows: liveMetrics?.follows ?? 0,
      subs: liveMetrics?.subs ?? 0,
      bits: liveMetrics?.bits ?? 0,
      donations: liveMetrics?.donations ?? 0,
      messages: liveMetrics?.messages ?? 0,
      commands: liveMetrics?.commands ?? 0
    };
  });

  // Stream health
  readonly streamHealth = signal<StreamHealthStatus>({
    isConnected: false,
    responseTimeMs: 0,
    lastChecked: new Date().toISOString()
  });

  private readonly REFERRAL_PROMO_DISMISS_KEY = 'dimasite.referral_promo.dismissed_at';
  private readonly REFERRAL_PROMO_DAILY_KEY = 'dimasite.referral_promo.last_shown_at';
  private readonly REFERRAL_PROMO_DAILY_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly REFERRAL_PROMO_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  readonly showReferralPromo = signal(false);
  readonly referralPromoTitle = signal('');
  readonly referralPromoMessage = signal('');
  readonly referralPromoCta = signal('');
  readonly referralPromoLink = signal('');

  constructor() {
    effect(() => {
      const tier = this.planTier();
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-plan-tier', tier);
      }
    });

    effect(() => {
      this.themeService.isDarkMode();
      this.languageService.currentLanguage();
      this.isMobileViewport();
      this.buildChart(this.streamHistoryData());
    });

    effect(() => {
      const panel = this.selectedMobilePanel();
      const isMobile = this.isMobileViewport();
      if (!isMobile || panel !== 'chart') {
        return;
      }

      this.scheduleChartResize();
    });
  }

  ngOnInit(): void {
    this.startTimeContextClock();
    this.setupViewportTracking();

    this.dashboardLoadSub = this.streamerParam$
      .pipe(
        switchMap((streamer) => {
          this.resetDashboardView();

          if (!streamer) {
            this.errorMessage.set(this.t('dashboard.errors.missingChannel'));
            return of(null);
          }

           void this.loadChannelAvatar(streamer);

           return this.sessionAuth.resolveChannelID(streamer).pipe(
             switchMap((channelID) => {
               if (!channelID) {
                 this.errorMessage.set(this.t('dashboard.errors.missingChannel'));
                 return of(null);
               }

               this.channelID.set(channelID);
               return this.dashboardApi.getBootstrap(channelID);
             })
           );
        })
      )
      .subscribe({
        next: (response) => {
          const channelID = this.channelID();
          if (!response || !channelID) {
            return;
          }

          if (response.error || !response.data) {
            this.errorMessage.set(response.message ?? this.t('dashboard.errors.loadFailed'));
            return;
          }

           this.errorMessage.set(null);
           this.dashboardApi.startLiveStatusPolling(channelID);
           this.dashboardApi.startAiCreditsPolling(channelID);
           this.updateStreamHealth();
           this.startStreamHealthMonitoring();
           this.checkAndShowReferralPromo();
        },
        error: () => {
          this.errorMessage.set(this.t('dashboard.errors.loadFailed'));
        }
      });
  }

  ngOnDestroy(): void {
    this.dashboardLoadSub?.unsubscribe();
    this.dashboardApi.stopLiveStatusPolling();
    this.dashboardApi.resetState();
    this.stopStreamHealthMonitoring();

    if (this.timeContextInterval !== null) {
      window.clearInterval(this.timeContextInterval);
      this.timeContextInterval = null;
    }

    if (this.viewportResizeHandler && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.viewportResizeHandler);
      this.viewportResizeHandler = null;
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  formatHistoryDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return this.tableDateFormatter.format(date);
  }

  isStreamLiveToday(stream: DashboardStreamHistoryPoint): boolean {
    const liveMetrics = this.dashboardApi.liveSessionMetrics();
    if (!liveMetrics?.isLive) {
      return false;
    }

    return this.toUtcDayKey(stream.date) === this.toUtcDayKey(new Date().toISOString());
  }

  formatHours(hours: number): string {
    const safeHours = Math.max(0, hours);
    const wholeHours = Math.floor(safeHours);
    const minutes = Math.round((safeHours - wholeHours) * 60);

    if (wholeHours === 0 && minutes > 0) {
      return `${minutes}m`;
    }

    if (minutes === 0) {
      return `${wholeHours}h`;
    }

    return `${wholeHours}h ${minutes}m`;
  }

  formatNumber(value: number): string {
    return this.numberFormatter.format(Math.max(0, Math.round(value)));
  }

  formatCurrency(value: number): string {
    return this.currencyFormatter.format(Math.max(0, value));
  }

  formatPercent(value: number): string {
    return `${value}%`;
  }

  formatAiCredits(value: number): string {
    if (!value || value <= 0) return '0';
    if (value >= 1000) {
      const k = value / 1000;
      return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return Math.round(value).toString();
  }

  selectTimeRange(range: TimeRange): void {
    this.selectedTimeRange.set(range);
  }

  selectMobilePanel(panel: MobilePanel): void {
    this.selectedMobilePanel.set(panel);
    if (panel === 'chart') {
      this.scheduleChartResize();
    }
  }

  private getDisplayStreamHistory(): DashboardStreamHistoryPoint[] {
    const bootstrap = this.bootstrap();
    const history = [...(bootstrap?.streamHistory ?? [])];
    const liveSession = this.dashboardApi.liveSessionMetrics();
    const isLive = this.isLive();

    if (bootstrap?.isLive && history.length > 0) {
      const lastPoint = history[history.length - 1];
      if (this.isLikelySyntheticLivePoint(lastPoint)) {
        history.pop();
      }
    }

    if (isLive && liveSession) {
      history.push(this.buildLiveHistoryPoint(liveSession));
    }

    return history;
  }

  private buildLiveHistoryPoint(liveSession: LiveSessionMetrics): DashboardStreamHistoryPoint {
    return {
      date: new Date().toISOString(),
      viewers: liveSession.averageViewers,
      hours: Math.round(liveSession.durationMinutes / 6) / 10,
      bits: liveSession.bits,
      donations: liveSession.donations,
      follows: liveSession.follows,
      subs: liveSession.subs
    };
  }

  private isLikelySyntheticLivePoint(point: DashboardStreamHistoryPoint | undefined): boolean {
    if (!point) {
      return false;
    }

    const todayKey = this.toUtcDayKey(new Date().toISOString());
    return this.toUtcDayKey(point.date) === todayKey;
  }

  timeRangeLabel(range: TimeRange): string {
    return this.t(`dashboard.timeRange.${range}`);
  }

  private buildChart(history: DashboardStreamHistoryPoint[]): void {
    const bucketByDay = new Map<string, DailySeriesBucket>();

    // First, bucket the existing data by day
    for (const point of history) {
      const dayKey = this.toUtcDayKey(point.date);
      const current = bucketByDay.get(dayKey) ?? {
        bits: 0,
        donations: 0,
        subs: 0,
        hours: 0,
        follows: 0,
        viewersTotal: 0,
        viewersCount: 0
      };

      current.bits += point.bits;
      current.donations += point.donations;
      current.subs += point.subs;
      current.hours += point.hours;
      current.follows += point.follows;
      current.viewersTotal += point.viewers;
      current.viewersCount += 1;

      bucketByDay.set(dayKey, current);
    }

    // Generate all days in the selected range
    const range = this.selectedTimeRange();
    const days = range === '7d' ? 7 : range === '15d' ? 15 : 30;
    const allDays = this.buildUtcDayRange(days);

    // Build data arrays with zeros for missing days
    const labels = allDays.map((dayKey) => this.formatChartDate(dayKey));
    const bits = allDays.map((dayKey) => Math.round(bucketByDay.get(dayKey)?.bits ?? 0));
    const subs = allDays.map((dayKey) => Math.round(bucketByDay.get(dayKey)?.subs ?? 0));
    const hours = allDays.map((dayKey) => Number((bucketByDay.get(dayKey)?.hours ?? 0).toFixed(1)));
    const donations = allDays.map((dayKey) => Number((bucketByDay.get(dayKey)?.donations ?? 0).toFixed(2)));
    const avgViewers = allDays.map((dayKey) => {
      const bucket = bucketByDay.get(dayKey);
      if (!bucket || bucket.viewersCount === 0) {
        return 0;
      }

      return Math.round(bucket.viewersTotal / bucket.viewersCount);
    });
    const follows = allDays.map((dayKey) => Math.round(bucketByDay.get(dayKey)?.follows ?? 0));

    const lineBase = this.chartConfig.getLineChartBase();
    const isDark = this.themeService.isDarkMode();
    const isMobile = this.isMobileViewport();
    const lineAxis = lineBase.xAxis as Record<string, unknown>;
    const yAxis = lineBase.yAxis as Record<string, unknown>;
    const bitsLabel = this.t('dashboard.charts.series.bits');
    const subsLabel = this.t('dashboard.charts.series.subs');
    const hoursLabel = this.t('dashboard.charts.series.hours');
    const donationsLabel = this.t('dashboard.charts.series.donations');
    const avgViewersLabel = this.t('dashboard.charts.series.avgViewers');
    const followsLabel = this.t('dashboard.charts.series.follows');
    const legendLabelBySeries = new Map<string, string>([
      [bitsLabel, isMobile ? 'Bits' : bitsLabel],
      [donationsLabel, isMobile ? 'Don.' : donationsLabel],
      [hoursLabel, isMobile ? 'Hours' : hoursLabel],
      [avgViewersLabel, isMobile ? 'Avg' : avgViewersLabel],
      [followsLabel, isMobile ? 'Follows' : followsLabel],
      [subsLabel, isMobile ? 'Subs' : subsLabel]
    ]);
    const engagementAxisLabel = this.t('dashboard.charts.axes.engagement');
    const bitsAxisLabel = this.t('dashboard.charts.axes.bits');
    const hoursAxisLabel = this.t('dashboard.charts.axes.hours');
    const donationsAxisLabel = this.t('dashboard.charts.axes.donations');
    const tooltipFormatter = (params: unknown): string => {
      const entries = Array.isArray(params) ? params : [params];
      const rows = entries
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return '';
          }

          const item = entry as {
            axisValueLabel?: unknown;
            seriesName?: unknown;
            marker?: unknown;
            value?: unknown;
          };
          const seriesName = String(item.seriesName || '');
          const numericValue = Number(item.value || 0);
          return `${String(item.marker || '')}${seriesName}: ${this.formatTooltipMetricValue(seriesName, numericValue, {
            bitsLabel,
            donationsLabel,
            hoursLabel
          })}`;
        })
        .filter(Boolean)
        .join('<br/>');

      const first = entries[0] as { axisValueLabel?: unknown } | undefined;
      return [`<strong>${String(first?.axisValueLabel || '')}</strong>`, rows].filter(Boolean).join('<br/>');
    };

    const nextOption: EChartsOption = {
      ...lineBase,
      grid: {
        ...(lineBase.grid as Record<string, unknown>),
        top: isMobile ? 74 : 60,
        left: isMobile ? 30 : 64,
        right: isMobile ? 30 : 84,
        bottom: isMobile ? 26 : 44,
        containLabel: true
      },
      legend: {
        type: isMobile ? 'plain' : 'scroll',
        top: isMobile ? 0 : 4,
        left: 0,
        right: 0,
        itemWidth: isMobile ? 8 : 11,
        itemHeight: isMobile ? 8 : 11,
        pageIconSize: isMobile ? 10 : 12,
        itemGap: isMobile ? 7 : 18,
        textStyle: {
          color: isDark ? '#d8ebff' : '#174069',
          fontSize: isMobile ? 9 : 11,
          fontWeight: 600
        },
        formatter: (name: string) => legendLabelBySeries.get(name) ?? name,
        data: [bitsLabel, donationsLabel, hoursLabel, avgViewersLabel, followsLabel, subsLabel]
      },
      tooltip: {
        ...(lineBase.tooltip as Record<string, unknown>),
        trigger: 'axis',
        confine: true,
        formatter: tooltipFormatter,
        backgroundColor: isDark ? 'rgba(8, 16, 30, 0.94)' : 'rgba(255, 255, 255, 0.96)',
        borderColor: isDark ? 'rgba(35, 213, 255, 0.65)' : 'rgba(33, 132, 255, 0.42)',
        borderWidth: 1,
        position: this.getTooltipPosition,
        textStyle: {
          color: isDark ? '#e8f6ff' : '#15395f'
        }
      },
      xAxis: {
        ...lineAxis,
        axisLabel: {
          color: isDark ? '#8fb0d5' : '#325f89',
          fontSize: isMobile ? 10 : 11,
          margin: isMobile ? 10 : 14
        },
        boundaryGap: isMobile,
        axisLine: {
          lineStyle: {
            color: isDark ? 'rgba(90, 138, 184, 0.35)' : 'rgba(34, 84, 130, 0.25)'
          }
        },
        data: labels
      },
      yAxis: [
        {
          ...yAxis,
          type: 'value',
          position: 'left',
          scale: true,
          minInterval: 1,
          name: isMobile ? engagementAxisLabel : engagementAxisLabel,
          nameGap: isMobile ? 8 : 18,
          nameRotate: 90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: isDark ? '#8fb0d5' : '#325f89',
            fontSize: isMobile ? 8 : 10,
            fontWeight: 700,
            padding: isMobile ? [0, 0, 0, 0] : [0, 0, 4, 0]
          },
          axisLabel: {
            color: isDark ? '#8fb0d5' : '#325f89',
            fontSize: isMobile ? 8 : 10,
            formatter: (value: number) => this.formatCompactNumber(value)
          },
          splitLine: {
            lineStyle: {
              color: isDark ? 'rgba(90, 138, 184, 0.16)' : 'rgba(34, 84, 130, 0.12)',
              type: 'dashed'
            }
          }
        },
        {
          ...yAxis,
          type: 'value',
          position: 'right',
          scale: true,
          minInterval: 1,
          name: bitsAxisLabel,
          nameGap: isMobile ? 8 : 18,
          nameRotate: -90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: '#ffd166',
            fontSize: isMobile ? 8 : 10,
            fontWeight: 700,
            padding: isMobile ? [0, 0, 0, 0] : [0, 0, 4, 0]
          },
          axisLabel: {
            color: '#ffd166',
            fontSize: isMobile ? 8 : 10,
            formatter: (value: number) => this.formatCompactNumber(value)
          },
          splitLine: { show: false }
        },
        {
          ...yAxis,
          type: 'value',
          position: 'left',
          offset: isMobile ? 22 : 56,
          scale: true,
          name: hoursAxisLabel,
          nameGap: isMobile ? 5 : 18,
          nameRotate: 90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: '#7c3aed',
            fontSize: isMobile ? 7 : 10,
            fontWeight: 700,
            padding: isMobile ? [0, 0, 0, 0] : [0, 0, 4, 0]
          },
          axisLabel: {
            color: '#7c3aed',
            fontSize: isMobile ? 7 : 10,
            formatter: (value: number) => this.formatHourAxisLabel(value)
          },
          splitLine: { show: false }
        },
        {
          ...yAxis,
          type: 'value',
          position: 'right',
          offset: isMobile ? 22 : 56,
          scale: true,
          name: donationsAxisLabel,
          nameGap: isMobile ? 5 : 18,
          nameRotate: -90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: '#ff5cf2',
            fontSize: isMobile ? 7 : 10,
            fontWeight: 700,
            padding: isMobile ? [0, 0, 0, 0] : [0, 0, 4, 0]
          },
          axisLabel: {
            color: '#ff5cf2',
            fontSize: isMobile ? 7 : 10,
            formatter: (value: number) => this.formatCompactCurrency(value)
          },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: bitsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          yAxisIndex: 1,
          data: bits,
          lineStyle: { width: 2.5, color: '#f59e0b' }
        },
        {
          name: donationsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          yAxisIndex: 3,
          data: donations,
          lineStyle: { width: 2.5, color: '#ec4899' }
        },
        {
          name: subsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          yAxisIndex: 0,
          data: subs,
          lineStyle: { width: 2.5, color: '#22c55e' }
        },
        {
          name: hoursLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          yAxisIndex: 2,
          data: hours,
          lineStyle: { width: 2.5, color: '#7c3aed' }
        },
        {
          name: avgViewersLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          yAxisIndex: 0,
          data: avgViewers,
          lineStyle: { width: 2.5, color: '#8b5cf6' }
        },
        {
          name: followsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          yAxisIndex: 0,
          data: follows,
          lineStyle: { width: 2.5, color: '#a78bfa' }
        }
      ]
    };

    if (!this.overviewChartInstance) {
      this.overviewChartOption.set(nextOption);
      return;
    }

    const tooltipIndex = this.activeTooltipDataIndex;
    this.overviewChartInstance.setOption(nextOption, { notMerge: false, lazyUpdate: true });
    this.scheduleChartResize();

    if (tooltipIndex !== null && labels.length > 0) {
      const nextIndex = Math.min(Math.max(tooltipIndex, 0), labels.length - 1);
      setTimeout(() => {
        this.overviewChartInstance?.dispatchAction({
          type: 'showTip',
          seriesIndex: 0,
          dataIndex: nextIndex
        });
      }, 0);
    }
  }

  onOverviewChartInit(chart: unknown): void {
    const chartInstance = chart as echarts.EChartsType;
    this.overviewChartInstance = chartInstance;
    this.scheduleChartResize();

    chartInstance.on('showTip', (...args: unknown[]) => {
      const [event] = args;
      const dataIndex =
        event && typeof event === 'object' && 'dataIndex' in event
          ? (event as { dataIndex?: unknown }).dataIndex
          : undefined;
      this.activeTooltipDataIndex = typeof dataIndex === 'number' ? dataIndex : null;
    });

    chartInstance.on('hideTip', () => {
      this.activeTooltipDataIndex = null;
    });

    chartInstance.getZr().on('globalout', () => {
      this.activeTooltipDataIndex = null;
    });

    const currentOption = this.overviewChartOption();
    if (Object.keys(currentOption).length > 0) {
      chartInstance.setOption(currentOption, { notMerge: false, lazyUpdate: true });
    }
  }

  private readonly getTooltipPosition = (
    point: number[],
    _params: unknown,
    _dom: unknown,
    _rect: unknown,
    size: { contentSize: number[]; viewSize: number[] }
  ): [number, number] => {
    const [pointX, pointY] = point;
    const [contentWidth, contentHeight] = size.contentSize;
    const [viewWidth, viewHeight] = size.viewSize;
    const padding = 12;
    const gap = viewWidth <= 720 ? 10 : 16;
    const isMobile = viewWidth <= 720;

    let x = isMobile ? pointX - contentWidth * 0.5 : pointX - contentWidth / 2;
    x = Math.min(Math.max(padding, x), Math.max(padding, viewWidth - contentWidth - padding));

    let y = pointY - contentHeight - gap;
    const belowY = pointY + gap;
    const canFitAbove = y >= padding;
    const canFitBelow = belowY + contentHeight <= viewHeight - padding;

    if (!canFitAbove && canFitBelow) {
      y = belowY;
    } else if (!canFitAbove && !canFitBelow) {
      const availableAbove = pointY - padding;
      const availableBelow = viewHeight - pointY - padding;
      y = availableAbove >= availableBelow
        ? Math.max(padding, pointY - contentHeight - gap)
        : Math.min(viewHeight - contentHeight - padding, belowY);
    }

    y = Math.min(Math.max(padding, y), Math.max(padding, viewHeight - contentHeight - padding));

    return [Math.round(x), Math.round(y)];
  };

  private filterByTimeRange<T extends { date: string }>(source: T[]): T[] {
    if (source.length === 0) {
      return source;
    }

    const range = this.selectedTimeRange();
    const days = range === '7d' ? 7 : range === '15d' ? 15 : 30;
    return [...source]
      .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
      .slice(-days);
  }

  private formatChartDate(value: string): string {
    const date = this.parseUtcDayKey(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat(this.getDashboardLocale(), {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    }).format(date);
  }

  private toUtcDayKey(value: string): string {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private buildUtcDayRange(days: number): string[] {
    const allDays: string[] = [];
    const today = new Date();
    const utcCursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(utcCursor);
      date.setUTCDate(utcCursor.getUTCDate() - i);
      allDays.push(this.toUtcDayKey(date.toISOString()));
    }

    return allDays;
  }

  private parseUtcDayKey(value: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return new Date(value);
    }

    const [, year, month, day] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  private startTimeContextClock(): void {
    if (this.timeContextInterval !== null) {
      window.clearInterval(this.timeContextInterval);
    }

    this.currentTimeContext.set(new Date());
    this.timeContextInterval = window.setInterval(() => {
      this.currentTimeContext.set(new Date());
    }, 60_000);
  }

  private setupViewportTracking(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const updateViewport = () => {
      const isMobile = window.innerWidth <= 720;
      this.isMobileViewport.set(isMobile);
      this.scheduleChartResize();
    };

    this.viewportResizeHandler = updateViewport;
    updateViewport();
    window.addEventListener('resize', updateViewport, { passive: true });
  }

  private scheduleChartResize(): void {
    if (!this.overviewChartInstance) {
      return;
    }

    if (typeof window === 'undefined') {
      this.overviewChartInstance.resize();
      return;
    }

    window.requestAnimationFrame(() => {
      this.overviewChartInstance?.resize();
    });
  }

  private formatTimeContext(value: Date, timeZone?: string): string {
    return new Intl.DateTimeFormat(this.getDashboardLocale(), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short'
    }).format(value);
  }

  private getDashboardLocale(): string {
    return this.languageService.getCurrentLanguage() === 'es' ? 'es-ES' : 'en-US';
  }

  private calculateGoalPercent(current: number, goal: number): number {
    if (goal <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((current / goal) * 100)));
  }

  formatCompactNumber(value: number): string {
    return this.compactNumberFormatter.format(Math.max(0, Number(value || 0)));
  }

  formatCompactCurrency(value: number): string {
    return this.compactCurrencyFormatter.format(Math.max(0, Number(value || 0)));
  }

  private formatHourAxisLabel(value: number): string {
    const safeValue = Math.max(0, Number(value || 0));
    if (safeValue >= 10) {
      return `${Math.round(safeValue)}h`;
    }

    return `${safeValue.toFixed(safeValue % 1 === 0 ? 0 : 1)}h`;
  }

  private formatTooltipMetricValue(
    seriesName: string,
    value: number,
    labels: { bitsLabel: string; donationsLabel: string; hoursLabel: string }
  ): string {
    if (seriesName === labels.donationsLabel) {
      return this.formatCurrency(value);
    }

    if (seriesName === labels.hoursLabel) {
      return this.formatHours(value);
    }

    if (seriesName === labels.bitsLabel) {
      return this.formatNumber(value);
    }

    return this.formatNumber(value);
  }

  private emptyKpis(): DashboardKpis {
    return {
      activeViewers: 0,
      averageViewers: 0,
      monthlyAverageViewers: 0,
      averageHoursPerStream: 0,
      totalBits: 0,
      totalStreams: 0,
      totalDonations: 0,
      activeFollows: 0,
      activeSubs: 0,
      monthlyGoalSubs: 1000,
      subsProgressPct: 0
    };
  }

  onChatEnabledChange(enabled: boolean): void {
    // Optimistically update the local state
    const currentBootstrap = this.dashboardApi.bootstrapData();
    if (currentBootstrap?.data) {
      this.dashboardApi.bootstrapData.set({
        ...currentBootstrap,
        data: {
          ...currentBootstrap.data,
          channel: {
            ...currentBootstrap.data.channel,
            chatEnabled: enabled
          }
        }
      });
    }
  }

  toggleChatCompact(): void {
    const channelID = this.channelID();
    if (!channelID || this.isTogglingChat()) return;

    const newEnabledState = !this.chatEnabled();
    this.isTogglingChat.set(true);

    this.dashboardApi.toggleChat(channelID, newEnabledState).subscribe({
      next: (response) => {
        this.isTogglingChat.set(false);
        if (!response.error) {
          this.onChatEnabledChange(newEnabledState);
        }
      },
      error: () => {
        this.isTogglingChat.set(false);
      }
    });
  }

  private updateStreamHealth(): void {
    const startTime = performance.now();
    const channelID = this.channelID();
    if (!channelID) return;

    this.dashboardApi.getLiveStatus(channelID).subscribe({
      next: () => {
        const responseTime = Math.round(performance.now() - startTime);
        this.streamHealth.set({
          isConnected: true,
          responseTimeMs: responseTime,
          lastChecked: new Date().toISOString()
        });
      },
      error: () => {
        this.streamHealth.set({
          isConnected: false,
          responseTimeMs: 0,
          lastChecked: new Date().toISOString()
        });
      }
    });
  }

  private startStreamHealthMonitoring(): void {
    this.stopStreamHealthMonitoring();
    this.streamHealthInterval = window.setInterval(() => this.updateStreamHealth(), 30000);
  }

  private stopStreamHealthMonitoring(): void {
    if (this.streamHealthInterval !== null) {
      window.clearInterval(this.streamHealthInterval);
      this.streamHealthInterval = null;
    }
  }

  private resetDashboardView(): void {
    this.dashboardApi.stopLiveStatusPolling();
    this.dashboardApi.resetState();
    this.stopStreamHealthMonitoring();
    this.channelID.set(null);
    this.errorMessage.set(null);
    this.profileImageUrl.set(null);
    this.streamHealth.set({
      isConnected: false,
      responseTimeMs: 0,
      lastChecked: new Date().toISOString()
    });
  }

  private async loadChannelAvatar(login: string): Promise<void> {
    const normalized = login.trim().toLowerCase();
    if (!normalized) {
      this.profileImageUrl.set(null);
      return;
    }

    const session = this.sessionAuth.session();
    const sessionLogin = (session?.twitchUser.login || '').trim().toLowerCase();
    if (sessionLogin === normalized && session?.twitchUser.profile_image_url) {
      this.profileImageUrl.set(session.twitchUser.profile_image_url);
      return;
    }

    try {
      const response = await fetch(
        `${environment.DIMA_API}/users?username=${encodeURIComponent(normalized)}`
      );
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as {
        data?: { profile_image_url?: string };
      };
      const imageUrl = body.data?.profile_image_url?.trim();
      if (imageUrl) {
        this.profileImageUrl.set(imageUrl);
      }
    } catch {
      // keep letter fallback
    }
  }

  private shouldShowReferralPromoToday(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    const dismissedAt = localStorage.getItem(this.REFERRAL_PROMO_DISMISS_KEY);
    if (dismissedAt) {
      const elapsed = Date.now() - Number(dismissedAt);
      if (elapsed < this.REFERRAL_PROMO_DISMISS_TTL_MS) {
        return false;
      }
    }

    const lastShownAt = localStorage.getItem(this.REFERRAL_PROMO_DAILY_KEY);
    if (lastShownAt) {
      const elapsed = Date.now() - Number(lastShownAt);
      if (elapsed < this.REFERRAL_PROMO_DAILY_TTL_MS) {
        return false;
      }
    }

    return true;
  }

  protected dismissReferralPromo(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.REFERRAL_PROMO_DISMISS_KEY, Date.now().toString());
    }
    this.showReferralPromo.set(false);
  }

  private markReferralPromoShown(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.REFERRAL_PROMO_DAILY_KEY, Date.now().toString());
    }
  }

  private checkAndShowReferralPromo(): void {
    const role = this.viewerRole();
    if (role === 'viewer' || role === null) {
      return;
    }

    if (!this.shouldShowReferralPromoToday()) {
      return;
    }

    const streamer = this.streamer();
    this.referralPromoTitle.set(this.t('dashboard.referralPromo.title'));
    this.referralPromoMessage.set(this.t('dashboard.referralPromo.message'));
    this.referralPromoCta.set(this.t('dashboard.referralPromo.cta'));
    this.referralPromoLink.set(`/${streamer}/modules/referrals`);

    this.showReferralPromo.set(true);
    this.markReferralPromoShown();
  }
}
