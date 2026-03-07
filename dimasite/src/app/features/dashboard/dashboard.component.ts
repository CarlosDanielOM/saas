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
import { ActivatedRoute } from '@angular/router';
import * as echarts from 'echarts';
import { EChartsOption } from 'echarts';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';
import { firstValueFrom } from 'rxjs';
import { Subscription } from 'rxjs';

import { ActivityCounters } from '../../models/activity.model';
import {
  DashboardKpis,
  DashboardStreamHistoryPoint
} from '../../models/dashboard.model';
import { DashboardAmbientComponent } from './dashboard-ambient.component';
import { DashboardApiService } from '../../services/dashboard-api.service';
import { DashboardChartConfigService } from '../../services/dashboard-chart-config.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { ActivityFeedComponent } from './components/activity-feed.component';
import { LiveStreamCardComponent } from './components/live-stream-card.component';
import { QuickActionsComponent } from './components/quick-actions.component';
import { StreamHealthComponent, StreamHealthStatus } from './components/stream-health.component';

type TimeRange = '7d' | '15d' | '30d';
type MobilePanel = 'chart' | 'goals';

interface DailySeriesBucket {
  bits: number;
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
    DashboardAmbientComponent,
    LiveStreamCardComponent,
    QuickActionsComponent,
    ActivityFeedComponent,
    StreamHealthComponent
  ],
  templateUrl: './dashboard.component.html',
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
  private readonly currencyFormatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  private readonly chartDateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  });
  private readonly tableDateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  private bootstrapSub?: Subscription;

  readonly selectedTimeRange = signal<TimeRange>('30d');
  readonly selectedMobilePanel = signal<MobilePanel>('chart');
  readonly timeRanges: TimeRange[] = ['7d', '15d', '30d'];
  readonly streamer = computed(
    () =>
      this.route.snapshot.paramMap.get('streamer') ??
      this.route.parent?.snapshot.paramMap.get('streamer') ??
      ''
  );
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
  readonly viewerRole = computed<DashboardViewerRole | null>(() => this.bootstrap()?.role ?? null);
  readonly viewerRoleLabel = computed(() => {
    const role = this.viewerRole();
    if (role === 'owner' || role === 'admin') {
      return this.t(`dashboard.roles.${role}`);
    }

    return '';
  });
  readonly streamHistoryData = computed<DashboardStreamHistoryPoint[]>(() => {
    const history = this.bootstrap()?.streamHistory ?? [];
    const filtered = this.filterByTimeRange(history);
    
    // Add today's live session data if streaming
    const liveMetrics = this.dashboardApi.liveSessionMetrics();
    if (liveMetrics?.isLive) {
      const todayPoint: DashboardStreamHistoryPoint = {
        date: new Date().toISOString(),
        viewers: liveMetrics.averageViewers,
        hours: Math.round(liveMetrics.durationMinutes / 6) / 10, // Round to 1 decimal
        bits: liveMetrics.bits,
        donations: liveMetrics.donations,
        follows: liveMetrics.follows,
        subs: liveMetrics.subs
      };
      filtered.push(todayPoint);
    }
    
    return filtered;
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

  readonly overviewChartOption = signal<EChartsOption>({});

  // Live stream status
  readonly isLive = computed(() => this.dashboardApi.liveStatus()?.data?.isLive ?? false);
  readonly liveStream = computed(() => this.dashboardApi.liveStatus()?.data?.stream ?? null);

  // Chat enabled status
  readonly chatEnabled = computed(() => this.bootstrap()?.channel.chatEnabled ?? false);
  readonly isTogglingChat = signal<boolean>(false);

  // Activity counters (will be updated via WebSocket in future)
  readonly activityCounters = signal<ActivityCounters>({
    follows: 0,
    subs: 0,
    bits: 0,
    donations: 0,
    messages: 0,
    commands: 0
  });

  // Stream health
  readonly streamHealth = signal<StreamHealthStatus>({
    isConnected: false,
    responseTimeMs: 0,
    lastChecked: new Date().toISOString()
  });

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
      this.buildChart(this.streamHistoryData());
    });
  }

  async ngOnInit(): Promise<void> {
    const streamer = this.streamer();
    if (!streamer) {
      this.errorMessage.set(this.t('dashboard.errors.missingChannel'));
      return;
    }

    const channelID = await firstValueFrom(this.sessionAuth.resolveChannelID(streamer));
    if (!channelID) {
      this.errorMessage.set(this.t('dashboard.errors.missingChannel'));
      return;
    }

    this.channelID.set(channelID);

    this.bootstrapSub = this.dashboardApi.getBootstrap(channelID).subscribe({
      next: (response) => {
        if (response.error || !response.data) {
          this.errorMessage.set(response.message ?? this.t('dashboard.errors.loadFailed'));
          return;
        }

        this.errorMessage.set(null);
        this.dashboardApi.startLiveStatusPolling(channelID);
        
        // Start health monitoring
        this.updateStreamHealth();
        setInterval(() => this.updateStreamHealth(), 30000);
      },
      error: () => {
        this.errorMessage.set(this.t('dashboard.errors.loadFailed'));
      }
    });
  }

  ngOnDestroy(): void {
    this.bootstrapSub?.unsubscribe();
    this.dashboardApi.stopLiveStatusPolling();
  }

  t(key: string): string {
    return this.languageService.translate(key);
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
    
    const streamDate = new Date(stream.date);
    const today = new Date();
    
    return streamDate.toDateString() === today.toDateString();
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

  selectTimeRange(range: TimeRange): void {
    this.selectedTimeRange.set(range);
  }

  selectMobilePanel(panel: MobilePanel): void {
    this.selectedMobilePanel.set(panel);
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
        subs: 0,
        hours: 0,
        follows: 0,
        viewersTotal: 0,
        viewersCount: 0
      };

      current.bits += point.bits;
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
    const allDays: string[] = [];
    const today = new Date();
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      allDays.push(`${year}-${month}-${day}`);
    }

    // Build data arrays with zeros for missing days
    const labels = allDays.map((dayKey) => this.formatChartDate(dayKey));
    const bits = allDays.map((dayKey) => Math.round(bucketByDay.get(dayKey)?.bits ?? 0));
    const subs = allDays.map((dayKey) => Math.round(bucketByDay.get(dayKey)?.subs ?? 0));
    const hours = allDays.map((dayKey) => Number((bucketByDay.get(dayKey)?.hours ?? 0).toFixed(1)));
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
    const lineAxis = lineBase.xAxis as Record<string, unknown>;
    const yAxis = lineBase.yAxis as Record<string, unknown>;
    const bitsLabel = this.t('dashboard.charts.series.bits');
    const subsLabel = this.t('dashboard.charts.series.subs');
    const hoursLabel = this.t('dashboard.charts.series.hours');
    const avgViewersLabel = this.t('dashboard.charts.series.avgViewers');
    const followsLabel = this.t('dashboard.charts.series.follows');

    this.overviewChartOption.set({
      ...lineBase,
      grid: {
        ...(lineBase.grid as Record<string, unknown>),
        top: 52
      },
      legend: {
        type: 'scroll',
        top: 4,
        left: 0,
        right: 0,
        itemWidth: 11,
        itemHeight: 11,
        textStyle: {
          color: isDark ? '#d8ebff' : '#174069',
          fontSize: 11,
          fontWeight: 600
        },
        data: [bitsLabel, subsLabel, hoursLabel, avgViewersLabel, followsLabel]
      },
      tooltip: {
        ...(lineBase.tooltip as Record<string, unknown>),
        trigger: 'axis',
        backgroundColor: isDark ? 'rgba(8, 16, 30, 0.94)' : 'rgba(255, 255, 255, 0.96)',
        borderColor: isDark ? 'rgba(35, 213, 255, 0.65)' : 'rgba(33, 132, 255, 0.42)',
        borderWidth: 1,
        textStyle: {
          color: isDark ? '#e8f6ff' : '#15395f'
        }
      },
      xAxis: {
        ...lineAxis,
        axisLabel: {
          color: isDark ? '#8fb0d5' : '#325f89'
        },
        axisLine: {
          lineStyle: {
            color: isDark ? 'rgba(90, 138, 184, 0.35)' : 'rgba(34, 84, 130, 0.25)'
          }
        },
        data: labels
      },
      yAxis: {
        ...yAxis,
        axisLabel: {
          color: isDark ? '#8fb0d5' : '#325f89'
        },
        splitLine: {
          lineStyle: {
            color: isDark ? 'rgba(90, 138, 184, 0.16)' : 'rgba(34, 84, 130, 0.12)',
            type: 'dashed'
          }
        },
        name: this.t('dashboard.charts.countAxisLabel'),
        nameGap: 28,
        nameLocation: 'middle',
        nameTextStyle: {
          color: isDark ? '#9cc3ea' : '#2d5b87',
          fontWeight: 600
        }
      },
      series: [
        {
          name: bitsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: bits,
          lineStyle: { width: 2.5, color: '#ffd166' }
        },
        {
          name: subsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: subs,
          lineStyle: { width: 2.5, color: '#31f7a6' }
        },
        {
          name: hoursLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: hours,
          lineStyle: { width: 2.5, color: '#29d9ff' }
        },
        {
          name: avgViewersLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: avgViewers,
          lineStyle: { width: 2.5, color: '#ff5cf2' }
        },
        {
          name: followsLabel,
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: follows,
          lineStyle: { width: 2.5, color: '#8f9dff' }
        }
      ]
    });
  }

  private filterByTimeRange<T extends { date: string }>(source: T[]): T[] {
    if (source.length === 0) {
      return source;
    }

    const range = this.selectedTimeRange();
    const days = range === '7d' ? 7 : range === '15d' ? 15 : 30;
    return source.slice(-days);
  }

  private formatChartDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return this.chartDateFormatter.format(date);
  }

  private toUtcDayKey(value: string): string {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private calculateGoalPercent(current: number, goal: number): number {
    if (goal <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((current / goal) * 100)));
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
}
