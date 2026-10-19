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
import { ActivatedRoute, RouterLink } from '@angular/router';
import * as echarts from 'echarts';
import { EChartsOption } from 'echarts';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';
import { distinctUntilChanged, map, of, shareReplay, Subscription, switchMap } from 'rxjs';

import {
  DashboardStreamHistoryPoint,
  LiveSessionMetrics
} from '../../models/dashboard.model';
import type { ModerationActionLogEntry } from '../../models/moderation.model';
import type { AiUsageSummaryData } from '../../models/usage.model';
import { DashboardApiService } from '../../services/dashboard-api.service';
import { DashboardChartConfigService } from '../../services/dashboard-chart-config.service';
import { LanguageService } from '../../services/language.service';
import { ModerationApiService } from '../../services/moderation-api.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { UsageApiService } from '../../services/usage-api.service';
import { LfIconComponent, LfIconName } from '../../shared/lf-icon/lf-icon.component';
import { getRouteParam, watchRouteParam } from '../../shared/utils/route-param.util';
import { creditDisplay, usageCreditDisplay } from '../../shared/utils/credit-display.util';
import { LoadingIndicatorComponent } from '../../components/loading';
import {
  ReferralPromoBannerComponent,
  ReferralPromoReward
} from '../../shared/referral-promo-banner/referral-promo-banner.component';
import { environment } from '../../../environments/environment';
import { ChatEventsService } from '../chat-events/chat-events.service';
import { GoalsComponent } from './components/goals/goals.component';
import { DashboardModerationCardComponent, ModLoad } from './components/dashboard-moderation-card.component';
import { compareWeeks, pctChange, summarizeAutomod } from './dashboard-week.util';
import { DashboardRaidCardComponent } from './components/dashboard-raid-card.component';

type TimeRange = '7d' | '15d' | '30d';
type Topic = 'tips' | 'games' | 'days' | 'raids' | 'moderation' | 'commands' | 'emotes';
type Pane = 'channel' | 'bot';

const TOPICS: Topic[] = ['tips', 'games', 'days', 'raids', 'moderation', 'commands', 'emotes'];
const CHANNEL_TOPICS: Topic[] = ['tips', 'games', 'days', 'raids'];
const BOT_TOPICS: Topic[] = ['moderation', 'commands', 'emotes'];
const TOPICS_KEY = 'dimasite.dashboard.topics';

/** Cards still being built: shown as "coming soon" so the layout is final. */
const SOON_ICONS: Partial<Record<Topic, LfIconName>> & Record<'tips', LfIconName> = {
  tips: 'bulb',
  games: 'gamepad',
  days: 'calendar',
  raids: 'users',
  commands: 'terminal',
  emotes: 'smile'
};

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

interface WeekFact {
  key: 'streams' | 'hours' | 'follows' | 'viewers' | 'subs' | 'bits';
  value: string;
  change: number | null;
}

/**
 * Streamer dashboard ("Split + Briefing"): bot health on top, shortcuts to
 * the most used modules, then the channel's week next to what the bot did.
 * Phones switch sides with two tabs and keep a one-line bot strip. "Show me"
 * chips choose the topics. Cards whose data isn't collected yet show as
 * "coming soon". The 30-day chart, stream list and goals sit in folded
 * sections at the bottom.
 */
@Component({
  selector: 'app-dashboard',
  imports: [
    GoalsComponent,
    NgxEchartsDirective,
    LoadingIndicatorComponent,
    ReferralPromoBannerComponent,
    LfIconComponent,
    DashboardModerationCardComponent,
    DashboardRaidCardComponent,
    RouterLink
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
  private readonly moderationApi = inject(ModerationApiService);
  private readonly usageApi = inject(UsageApiService);
  private readonly chatEvents = inject(ChatEventsService);
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
  private extrasSub = new Subscription();
  private timeContextInterval: number | null = null;
  private overviewChartInstance: echarts.EChartsType | null = null;
  private activeTooltipDataIndex: number | null = null;
  private viewportResizeHandler: (() => void) | null = null;

  readonly selectedTimeRange = signal<TimeRange>('30d');
  readonly timeRanges: TimeRange[] = ['7d', '15d', '30d'];
  readonly isMobileViewport = signal(false);
  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });
  readonly channelID = signal<string | null>(null);
  readonly bootstrap = computed(() => this.dashboardApi.bootstrapData()?.data ?? null);
  readonly loading = computed(() => this.dashboardApi.loading());
  readonly errorMessage = signal<string | null>(null);

  readonly planTier = computed(() => this.sessionAuth.getPlanTierForStreamer(this.streamer()));
  readonly planLabel = computed(() => {
    const tier = this.planTier();
    if (tier === 'premium') return this.t('navbar.planPremium');
    if (tier === 'pro') return this.t('navbar.planPro');
    return this.t('navbar.planFree');
  });

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
  readonly isOwner = computed(() => this.viewerRole() === 'owner');
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

  // ---------------------------------------------------------------- AI credits
  readonly usageSummary = signal<AiUsageSummaryData | null>(null);
  readonly aiCreditDisplay = computed(() => creditDisplay(this.dashboardApi.aiCredits(), this.planTier()));
  readonly aiCreditsData = computed(() => this.aiCreditDisplay().credits);
  readonly aiCreditsEstimated = computed(() => this.aiCreditDisplay().estimated);
  readonly aiCreditsAvailable = computed(() => this.aiCreditsData()?.available ?? false);
  readonly aiCreditsPercentLeft = computed(() => {
    const data = this.aiCreditsData();
    if (!data?.limit || data.limit <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round(((data.limit - data.used) / data.limit) * 100)));
  });
  readonly aiCreditsExhausted = computed(() => {
    const data = this.aiCreditsData();
    return !!data && data.available && data.balance <= 0;
  });
  /** Short "will my credits last?" line for the health row. */
  readonly creditsForecast = computed<{ warn: boolean; text: string }>(() => {
    const summary = this.usageSummary();
    const pace = usageCreditDisplay(summary).pacing;
    const endsAt = summary?.billingPeriod?.endsAt;
    const date = endsAt ? this.shortDate(endsAt) : '';
    if (!this.aiCreditsAvailable()) {
      return {
        warn: false,
        text: this.t(this.aiCreditsEstimated() ? 'usage.balance.syncing' : 'dashboard.kpis.aiCreditsNotAvailable')
      };
    }
    if (this.aiCreditsExhausted() || pace?.status === 'exhausted') {
      return { warn: true, text: date ? this.t('dashboard.brief.credits.out', { date }) : this.t('dashboard.brief.credits.outNow') };
    }
    if (!pace || !date) {
      return { warn: false, text: this.t('dashboard.brief.credits.left') };
    }
    if (pace.status === 'no_usage') {
      return { warn: false, text: this.t('dashboard.brief.credits.noUsage', { date }) };
    }
    const runout = pace.estimatedDaysUntilExhaustion;
    if (pace.expectedToExhaustWithinPeriod && runout !== null) {
      const gap = Math.max(1, Math.round(pace.remainingPeriodDays - runout));
      return runout < 1
        ? { warn: true, text: this.t('dashboard.brief.credits.runOutSoon', { gap }) }
        : {
            warn: true,
            text: this.t(gap === 1 ? 'dashboard.brief.credits.runOutOne' : 'dashboard.brief.credits.runOut', {
              days: Math.floor(runout),
              gap
            })
          };
    }
    return { warn: false, text: this.t('dashboard.brief.credits.lasts', { date }) };
  });

  // ----------------------------------------------------------- bot + automod
  readonly chatEnabled = computed(() => this.bootstrap()?.channel.chatEnabled ?? false);
  readonly isTogglingChat = signal<boolean>(false);

  readonly modState = signal<ModLoad>('loading');
  readonly modLogs = signal<ModerationActionLogEntry[]>([]);
  readonly modTotal = signal(0);
  readonly modEnabled = signal<boolean | null>(null);
  readonly automod = computed(() => summarizeAutomod(this.modLogs(), this.modTotal(), this.currentTimeContext()));
  readonly automodCount = computed(() => {
    const week = this.automod();
    return `${this.formatNumber(week.actions)}${week.capped ? '+' : ''}`;
  });

  readonly eventsState = signal<ModLoad>('loading');
  readonly eventsOn = signal(0);
  readonly eventsTotal = signal(0);

  // ------------------------------------------------------------- live + week
  readonly isLive = computed(() => this.dashboardApi.liveStatus()?.data?.isLive ?? false);
  readonly liveStream = computed(() => this.dashboardApi.liveStatus()?.data?.stream ?? null);
  readonly liveSession = computed(() => this.dashboardApi.liveSessionMetrics());
  readonly liveFor = computed(() => this.formatHours((this.liveSession()?.durationMinutes ?? 0) / 60));

  readonly currentTimeContext = signal(new Date());
  readonly serverTimeDisplay = computed(() => this.formatTimeContext(this.currentTimeContext(), 'UTC'));
  readonly localTimeDisplay = computed(() => this.formatTimeContext(this.currentTimeContext()));

  readonly week = computed(() => compareWeeks(this.getDisplayStreamHistory(), this.currentTimeContext()));
  readonly weekLabel = computed(() =>
    this.t('dashboard.brief.week', { from: this.shortDate(this.week().from), to: this.shortDate(this.week().to) })
  );
  readonly followChange = computed(() => pctChange(this.week().now.follows, this.week().before.follows));
  readonly weekFacts = computed<WeekFact[]>(() => {
    const { now, before } = this.week();
    return [
      { key: 'streams', value: this.formatNumber(now.streams), change: pctChange(now.streams, before.streams) },
      { key: 'hours', value: this.formatHours(now.hours), change: pctChange(now.hours, before.hours) },
      { key: 'follows', value: this.formatNumber(now.follows), change: pctChange(now.follows, before.follows) },
      { key: 'viewers', value: this.formatNumber(now.viewers), change: pctChange(now.viewers, before.viewers) },
      { key: 'subs', value: this.formatNumber(now.subs), change: pctChange(now.subs, before.subs) },
      { key: 'bits', value: this.formatCompactNumber(now.bits), change: pctChange(now.bits, before.bits) }
    ];
  });
  readonly answerHeadline = computed(() => {
    const now = this.week().now;
    if (!now.streams) return this.t('dashboard.brief.answer.none');
    return this.t(now.streams === 1 ? 'dashboard.brief.answer.streamsOne' : 'dashboard.brief.answer.streams', {
      count: now.streams,
      hours: this.formatHours(now.hours)
    });
  });
  readonly answerRest = computed(() => {
    const { now, lastStream } = this.week();
    const parts: string[] = [];
    if (now.streams) {
      const change = this.followChange();
      parts.push(
        change === null
          ? this.t('dashboard.brief.answer.follows', { count: this.formatNumber(now.follows) })
          : this.t('dashboard.brief.answer.followsChange', { count: this.formatNumber(now.follows), change: this.signedPct(change) })
      );
    } else if (lastStream) {
      parts.push(this.t('dashboard.brief.answer.last', { date: this.shortDate(lastStream) }));
    }
    if (this.modState() === 'ready' && this.modEnabled() !== false) {
      parts.push(
        this.automod().actions
          ? this.t('dashboard.brief.answer.automod', { count: this.automodCount() })
          : this.t('dashboard.brief.answer.automodNone')
      );
    }
    return parts.join(' ');
  });

  // ----------------------------------------------------------- layout choices
  readonly pane = signal<Pane>('channel');
  readonly topics = TOPICS;
  readonly chosenTopics = signal<Topic[]>(this.readTopics());
  readonly anyChannel = computed(() => CHANNEL_TOPICS.some((t) => this.chosenTopics().includes(t)));
  readonly anyBot = computed(() => BOT_TOPICS.some((t) => this.chosenTopics().includes(t)));
  readonly soonIcons = SOON_ICONS as Record<Topic, LfIconName>;
  readonly goodSoon: Topic[] = ['games', 'days'];
  readonly botSoon: Topic[] = ['commands', 'emotes'];
  readonly shortcuts: Array<{ key: string; icon: LfIconName; path: string }> = [
    { key: 'tts', icon: 'mic', path: 'tts' },
    { key: 'chatEvents', icon: 'chat', path: 'chat-events' },
    { key: 'triggers', icon: 'play', path: 'triggers' },
    { key: 'moderation', icon: 'shield', path: 'moderation' }
  ];

  readonly overviewChartOption = signal<EChartsOption>({});

  /**
   * Axis color guide shown under the chart on small screens, where the rotated
   * y-axis names are hidden to keep the tick labels from colliding. Each chip
   * lists the series colors that share that scale.
   */
  readonly chartAxisChips = computed<{ id: string; label: string; colors: string[] }[]>(() => [
    {
      id: 'engagement',
      label: this.t('dashboard.charts.axes.engagement'),
      colors: ['#22c55e', '#8b5cf6', '#a78bfa']
    },
    { id: 'hours', label: this.t('dashboard.charts.axes.hours'), colors: ['#7c3aed'] },
    { id: 'bits', label: this.t('dashboard.charts.axes.bits'), colors: ['#f59e0b'] },
    { id: 'donations', label: this.t('dashboard.charts.axes.donations'), colors: ['#ec4899'] }
  ]);

  private readonly REFERRAL_PROMO_DISMISS_KEY = 'dimasite.referral_promo.dismissed_at';
  private readonly REFERRAL_PROMO_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  readonly showReferralPromo = signal(false);
  readonly referralPromoLink = computed(() => `/${this.streamer()}/modules/referrals`);
  // Mirrors BOT_SUBSCRIPTION_REWARDS (monthly) in dimabot/src/utils/referral.ts.
  readonly referralPromoRewards = computed<ReferralPromoReward[]>(() => [
    {
      plan: 'premium',
      label: this.t('dashboard.referralPromo.premium'),
      amount: this.t('dashboard.referralPromo.perMonth', { credits: 50 })
    },
    {
      plan: 'pro',
      label: this.t('dashboard.referralPromo.pro'),
      amount: this.t('dashboard.referralPromo.perMonth', { credits: 100 })
    }
  ]);

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
          this.loadExtras(channelID);
          this.checkAndShowReferralPromo();
        },
        error: () => {
          this.errorMessage.set(this.t('dashboard.errors.loadFailed'));
        }
      });
  }

  ngOnDestroy(): void {
    this.dashboardLoadSub?.unsubscribe();
    this.extrasSub.unsubscribe();
    this.dashboardApi.stopLiveStatusPolling();
    this.dashboardApi.resetState();

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

  link(...parts: string[]): string[] {
    return ['/', this.streamer(), ...parts];
  }

  // ------------------------------------------------------------------ topics
  on(topic: Topic): boolean {
    return this.chosenTopics().includes(topic);
  }

  toggleTopic(topic: Topic): void {
    const now = this.chosenTopics();
    const next = now.includes(topic) ? now.filter((t) => t !== topic) : TOPICS.filter((t) => t === topic || now.includes(t));
    this.chosenTopics.set(next);
    try {
      localStorage.setItem(TOPICS_KEY, JSON.stringify(next));
    } catch {
      // storage may be blocked
    }
  }

  private readTopics(): Topic[] {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TOPICS_KEY) : null;
      if (raw) {
        const saved = JSON.parse(raw) as unknown;
        if (Array.isArray(saved)) return TOPICS.filter((t) => saved.includes(t));
      }
    } catch {
      // ignore broken saved state
    }
    return [...TOPICS];
  }

  /** Bot pane on phones: jump there from the one-line strip. */
  showBotPane(event: Event): void {
    event.preventDefault();
    this.pane.set('bot');
    if (typeof document !== 'undefined') {
      document.getElementById('dash-bot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  onHistoryToggle(event: Event): void {
    if ((event.target as HTMLDetailsElement).open) {
      this.scheduleChartResize();
    }
  }

  // -------------------------------------------------------------- formatting
  signedPct(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}%`;
  }

  shortDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(this.getDashboardLocale(), { month: 'short', day: 'numeric' });
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

  selectTimeRange(range: TimeRange): void {
    this.selectedTimeRange.set(range);
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
    // On small screens the rotated y-axis names are dropped and replaced by the
    // color chips under the chart, so neither the names nor the tick labels collide.
    const gridLeft = isMobile ? 36 : 78;
    const gridRight = isMobile ? 40 : 98;
    const axisNameGap = 36;
    const chartTop = isMobile ? 56 : 58;
    const chartBottom = isMobile ? 40 : 44;
    const innerAxisOffset = isMobile ? 34 : 58;
    const primaryTickFont = isMobile ? 9 : 10;
    const secondaryTickFont = isMobile ? 8 : 10;
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
        top: chartTop,
        left: gridLeft,
        right: gridRight,
        bottom: chartBottom,
        containLabel: true
      },
      legend: {
        type: isMobile ? 'plain' : 'scroll',
        top: 4,
        left: 0,
        right: 0,
        itemWidth: isMobile ? 8 : 11,
        itemHeight: isMobile ? 8 : 11,
        pageIconSize: isMobile ? 10 : 12,
        itemGap: isMobile ? 12 : 18,
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
          margin: isMobile ? 10 : 12,
          hideOverlap: true
        },
        boundaryGap: false,
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
          name: isMobile ? '' : engagementAxisLabel,
          nameGap: axisNameGap,
          nameRotate: 90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: isDark ? '#8fb0d5' : '#325f89',
            fontSize: 10,
            fontWeight: 700
          },
          axisLabel: {
            color: isDark ? '#8fb0d5' : '#325f89',
            fontSize: primaryTickFont,
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
          name: isMobile ? '' : bitsAxisLabel,
          nameGap: axisNameGap,
          nameRotate: -90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: '#ffd166',
            fontSize: 10,
            fontWeight: 700
          },
          axisLabel: {
            color: '#ffd166',
            fontSize: primaryTickFont,
            formatter: (value: number) => this.formatCompactNumber(value)
          },
          splitLine: { show: false }
        },
        {
          ...yAxis,
          type: 'value',
          position: 'left',
          offset: innerAxisOffset,
          scale: true,
          name: isMobile ? '' : hoursAxisLabel,
          nameGap: axisNameGap,
          nameRotate: 90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: '#7c3aed',
            fontSize: 10,
            fontWeight: 700
          },
          axisLabel: {
            color: '#7c3aed',
            fontSize: secondaryTickFont,
            formatter: (value: number) => this.formatHourAxisLabel(value)
          },
          splitLine: { show: false }
        },
        {
          ...yAxis,
          type: 'value',
          position: 'right',
          offset: innerAxisOffset,
          scale: true,
          name: isMobile ? '' : donationsAxisLabel,
          nameGap: axisNameGap,
          nameRotate: -90,
          nameLocation: 'middle',
          nameTextStyle: {
            color: '#ff5cf2',
            fontSize: 10,
            fontWeight: 700
          },
          axisLabel: {
            color: '#ff5cf2',
            fontSize: secondaryTickFont,
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


  toggleChatCompact(): void {
    const channelID = this.channelID();
    if (!channelID || this.isTogglingChat()) return;

    const enabled = !this.chatEnabled();
    this.isTogglingChat.set(true);

    this.dashboardApi.toggleChat(channelID, enabled).subscribe({
      next: (response) => {
        this.isTogglingChat.set(false);
        const current = this.dashboardApi.bootstrapData();
        if (!response.error && current?.data) {
          this.dashboardApi.bootstrapData.set({
            ...current,
            data: { ...current.data, channel: { ...current.data.channel, chatEnabled: enabled } }
          });
        }
      },
      error: () => {
        this.isTogglingChat.set(false);
      }
    });
  }

  /** Bot-side numbers: automod, chat events and the credits forecast. Each fails on its own. */
  private loadExtras(channelID: string): void {
    this.extrasSub.unsubscribe();
    this.extrasSub = new Subscription();

    this.extrasSub.add(
      this.moderationApi.getLogs(channelID, 1, 100).subscribe({
        next: (response) => {
          if (response.error || !response.data) {
            this.modState.set('error');
            return;
          }
          this.modLogs.set(response.data.logs ?? []);
          this.modTotal.set(response.data.total ?? 0);
          this.modState.set('ready');
        },
        error: () => this.modState.set('error')
      })
    );
    this.extrasSub.add(
      this.moderationApi.getSettings(channelID).subscribe({
        next: (response) => this.modEnabled.set(response.data ? response.data.enabled : null),
        error: () => this.modEnabled.set(null)
      })
    );
    this.extrasSub.add(
      this.chatEvents.getEvents(channelID).subscribe({
        next: (events) => {
          this.eventsTotal.set(events.length);
          this.eventsOn.set(events.filter((event) => event.enabled).length);
          this.eventsState.set('ready');
        },
        error: () => this.eventsState.set('error')
      })
    );
    this.extrasSub.add(
      this.usageApi.getSummary(channelID).subscribe({
        next: (response) => this.usageSummary.set(response.data ?? null),
        error: () => this.usageSummary.set(null)
      })
    );
  }

  private resetDashboardView(): void {
    this.dashboardApi.stopLiveStatusPolling();
    this.dashboardApi.resetState();
    this.extrasSub.unsubscribe();
    this.channelID.set(null);
    this.errorMessage.set(null);
    this.profileImageUrl.set(null);
    this.usageSummary.set(null);
    this.modState.set('loading');
    this.modLogs.set([]);
    this.modTotal.set(0);
    this.modEnabled.set(null);
    this.eventsState.set('loading');
    this.eventsOn.set(0);
    this.eventsTotal.set(0);
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

  private shouldShowReferralPromo(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    const dismissedAt = localStorage.getItem(this.REFERRAL_PROMO_DISMISS_KEY);
    if (!dismissedAt) {
      return true;
    }

    const elapsed = Date.now() - Number(dismissedAt);
    return !Number.isFinite(elapsed) || elapsed >= this.REFERRAL_PROMO_DISMISS_TTL_MS;
  }

  protected dismissReferralPromo(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.REFERRAL_PROMO_DISMISS_KEY, Date.now().toString());
    }
    this.showReferralPromo.set(false);
  }

  private checkAndShowReferralPromo(): void {
    const role = this.viewerRole();
    if (role === 'viewer' || role === null) {
      return;
    }

    if (!this.shouldShowReferralPromo()) {
      return;
    }

    this.showReferralPromo.set(true);
  }
}
