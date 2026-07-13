import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import { LanguageService } from '../../../services/language.service';
import { LandingAnalyticsService } from '../landing-analytics.service';

type PlanTier = 'free' | 'premium' | 'pro';
type TrendRange = 7 | 15 | 30;
type MobilePanel = 'chart' | 'goals';

interface ChannelProfile {
  id: string;
  username: string;
  displayName: string;
  profileImageUrl: string;
}

interface HistoryRow {
  date: string;
  hours: number;
  avgViewers: number;
  bits: number;
  subs: number;
  follows: number;
  donations: number;
  live?: boolean;
}

interface TrendPoint {
  label: string;
  viewers: number;
  hours: number;
  bits: number;
  follows: number;
  subs: number;
  donations: number;
}

interface GoalItem {
  id: string;
  label: string;
  current: number;
  target: number;
  format: 'compact' | 'money' | 'hours' | 'raw';
  tone: 'violet' | 'gold' | 'sky' | 'green';
}

type TrendSeriesKey = 'viewers' | 'bits' | 'follows' | 'subs' | 'donations' | 'hours';

interface ActivityMetrics {
  follows: number;
  subs: number;
  bits: number;
  donations: number;
  messages: number;
  commands: number;
}

const LIVE_API = 'https://api.domdimabot.com';
const CHANNEL_ID = '533538623';
const CHANNEL_LOGIN = 'cdom201';

const SEED_HISTORY: HistoryRow[] = [
  { date: 'Jul 12', hours: 4.2, avgViewers: 86, bits: 1240, subs: 3, follows: 18, donations: 25 },
  { date: 'Jul 10', hours: 3.1, avgViewers: 72, bits: 640, subs: 1, follows: 11, donations: 0 },
  { date: 'Jul 8', hours: 5.0, avgViewers: 104, bits: 2100, subs: 5, follows: 27, donations: 40 },
  { date: 'Jul 6', hours: 2.4, avgViewers: 58, bits: 320, subs: 0, follows: 7, donations: 10 },
  { date: 'Jul 4', hours: 3.8, avgViewers: 91, bits: 980, subs: 2, follows: 14, donations: 15 },
  { date: 'Jul 2', hours: 4.6, avgViewers: 113, bits: 1760, subs: 4, follows: 22, donations: 30 },
  { date: 'Jun 30', hours: 2.9, avgViewers: 67, bits: 410, subs: 1, follows: 9, donations: 0 }
];

function buildTrend(days: number): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const wave = Math.sin(i / 2.4) * 18 + Math.cos(i / 3.1) * 10;
    const pulse = Math.sin(i / 1.7) * 6;
    out.push({
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      viewers: Math.max(20, Math.round(78 + wave + (i % 5) * 3)),
      hours: Math.round((2.2 + (i % 4) * 0.55 + Math.abs(wave) / 40) * 10) / 10,
      bits: Math.max(0, Math.round(420 + wave * 22 + (i % 3) * 80)),
      follows: Math.max(0, Math.round(8 + wave / 4 + (i % 4))),
      subs: Math.max(0, Math.round(1.2 + Math.abs(pulse) / 3 + (i % 5 === 0 ? 2 : 0))),
      donations: Math.max(0, Math.round(8 + Math.abs(wave) / 3 + (i % 6) * 2))
    });
  }
  return out;
}

@Component({
  selector: 'app-prod-dashboard-mock',
  imports: [RouterLink, CountUpDirective],
  templateUrl: './prod-dashboard-mock.component.html',
  styleUrl: './prod-dashboard-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProdDashboardMockComponent {
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly languageService = inject(LanguageService);

  readonly channelLogin = CHANNEL_LOGIN;
  readonly liveChannels = this.analytics.liveChannels;
  readonly connectionStatus = this.analytics.connectionStatus;

  readonly planTier = signal<PlanTier>('pro');
  readonly botInChat = signal(true);
  readonly trendRange = signal<TrendRange>(15);
  readonly mobilePanel = signal<MobilePanel>('chart');
  readonly toast = signal<string | null>(null);

  readonly profile = signal<ChannelProfile | null>(null);
  readonly healthMs = signal<number | null>(null);

  readonly seededActivity = signal<ActivityMetrics>({
    follows: 12,
    subs: 2,
    bits: 840,
    donations: 15,
    messages: 1842,
    commands: 96
  });

  readonly kpis = signal({
    avgHours: 3.7,
    avgViewers: 84,
    bits30d: 12480,
    donations30d: 215,
    aiUsed: 128400,
    aiLimit: 500000
  });

  readonly goals = signal<GoalItem[]>([
    {
      id: 'followers',
      label: 'devMocks.dashboard.goalFollowers',
      current: 18420,
      target: 20000,
      format: 'compact',
      tone: 'violet'
    },
    {
      id: 'subs',
      label: 'devMocks.dashboard.goalSubs',
      current: 312,
      target: 400,
      format: 'raw',
      tone: 'gold'
    },
    {
      id: 'bits',
      label: 'devMocks.dashboard.goalBits',
      current: 12480,
      target: 15000,
      format: 'compact',
      tone: 'sky'
    },
    {
      id: 'hours',
      label: 'devMocks.dashboard.goalHours',
      current: 42.5,
      target: 60,
      format: 'hours',
      tone: 'green'
    }
  ]);

  readonly history = signal<HistoryRow[]>(SEED_HISTORY);
  readonly activeSeries = signal<Record<TrendSeriesKey, boolean>>({
    viewers: true,
    bits: true,
    follows: true,
    subs: true,
    donations: true,
    hours: true
  });

  private toastTimer: number | null = null;

  readonly connectionLabel = computed(() => {
    this.languageService.currentLanguage();
    switch (this.connectionStatus()) {
      case 'connected':
        return this.t('devMocks.dashboard.boardConnected');
      case 'reconnecting':
        return this.t('devMocks.dashboard.boardReconnecting');
      default:
        return this.t('devMocks.dashboard.boardOffline');
    }
  });

  readonly myLiveChannel = computed(() => {
    const id = CHANNEL_ID;
    const login = CHANNEL_LOGIN.toLowerCase();
    return (
      this.liveChannels().find(
        (channel) =>
          channel.channelID === id || channel.channel.toLowerCase() === login
      ) ?? null
    );
  });

  readonly isLive = computed(() => !!this.myLiveChannel());

  readonly displayName = computed(
    () => this.profile()?.displayName || CHANNEL_LOGIN
  );

  readonly avatarUrl = computed(
    () =>
      this.profile()?.profileImageUrl ||
      this.myLiveChannel()?.profileImageUrl ||
      ''
  );

  readonly avatarLetter = computed(() =>
    this.displayName().slice(0, 1).toUpperCase()
  );

  readonly aiPct = computed(() => {
    const { aiUsed, aiLimit } = this.kpis();
    if (!aiLimit) return 0;
    return Math.min(100, Math.round((aiUsed / aiLimit) * 100));
  });

  readonly goalRows = computed(() => {
    this.languageService.currentLanguage();
    return this.goals().map((goal) => ({
      ...goal,
      labelText: this.t(goal.label),
      pct: Math.min(100, Math.round((goal.current / Math.max(goal.target, 1)) * 100)),
      display: this.formatGoalValue(goal)
    }));
  });

  readonly trend = computed(() => buildTrend(this.trendRange()));

  readonly chartPaths = computed(() => {
    const points = this.trend();
    const empty = {
      viewers: '',
      bits: '',
      follows: '',
      subs: '',
      donations: '',
      hours: '',
      area: ''
    };
    if (points.length < 2) {
      return empty;
    }

    const w = 100;
    const h = 42;
    const pad = 2;
    const xAt = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
    const pathFor = (key: TrendSeriesKey, scale = 1) => {
      const max = Math.max(...points.map((p) => p[key]), 0.0001);
      return points
        .map((p, i) => {
          const y = h - pad - (p[key] / max) * (h - pad * 2) * scale;
          return `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(' ');
    };

    const viewers = pathFor('viewers', 1);
    const area =
      viewers +
      ` L ${xAt(points.length - 1).toFixed(2)} ${(h - pad).toFixed(2)}` +
      ` L ${xAt(0).toFixed(2)} ${(h - pad).toFixed(2)} Z`;

    return {
      viewers,
      bits: pathFor('bits', 0.9),
      follows: pathFor('follows', 0.82),
      subs: pathFor('subs', 0.78),
      donations: pathFor('donations', 0.8),
      hours: pathFor('hours', 0.75),
      area
    };
  });

  readonly historyRows = computed(() => {
    const rows = [...this.history()];
    if (this.isLive()) {
      const live = this.myLiveChannel();
      rows.unshift({
        date: 'Today',
        hours: 0,
        avgViewers: live?.viewers ?? 0,
        bits: this.seededActivity().bits,
        subs: this.seededActivity().subs,
        follows: this.seededActivity().follows,
        donations: this.seededActivity().donations,
        live: true
      });
    }
    return rows;
  });

  readonly uptimeLabel = computed(() => (this.isLive() ? 'Live now' : '—'));

  constructor() {
    void this.bootstrapPublic();
  }

  t(key: string, params?: Record<string, string | number>): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key, params);
  }

  setPlanTier(tier: PlanTier): void {
    this.planTier.set(tier);
    this.showToast(this.t('devMocks.dashboard.planSim', { tier }));
  }

  setTrendRange(range: TrendRange): void {
    this.trendRange.set(range);
  }

  setMobilePanel(panel: MobilePanel): void {
    this.mobilePanel.set(panel);
  }

  toggleSeries(key: TrendSeriesKey): void {
    this.activeSeries.update((current) => {
      const enabledCount = Object.values(current).filter(Boolean).length;
      if (current[key] && enabledCount <= 1) {
        return current;
      }
      return { ...current, [key]: !current[key] };
    });
  }

  isSeriesOn(key: TrendSeriesKey): boolean {
    return this.activeSeries()[key];
  }

  formatGoalValue(goal: GoalItem): string {
    switch (goal.format) {
      case 'money':
        return `${this.formatMoney(goal.current)} / ${this.formatMoney(goal.target)}`;
      case 'hours':
        return `${goal.current}h / ${goal.target}h`;
      case 'compact':
        return `${this.formatCompact(goal.current)} / ${this.formatCompact(goal.target)}`;
      default:
        return `${goal.current} / ${goal.target}`;
    }
  }

  toggleBot(): void {
    this.botInChat.update((v) => !v);
    this.showToast(
      this.botInChat()
        ? this.t('devMocks.dashboard.botJoined')
        : this.t('devMocks.dashboard.botLeft')
    );
  }

  formatViewers(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  }

  formatMoney(n: number): string {
    return `$${n.toLocaleString()}`;
  }

  formatCompact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return n.toLocaleString();
  }

  private async bootstrapPublic(): Promise<void> {
    const started = performance.now();

    try {
      const profileRes = await fetch(`${LIVE_API}/users?username=${CHANNEL_LOGIN}`);
      this.healthMs.set(Math.round(performance.now() - started));

      if (profileRes.ok) {
        const body = (await profileRes.json()) as {
          data?: {
            id?: string;
            username?: string;
            display_name?: string;
            profile_image_url?: string;
          };
        };
        const data = body.data;
        if (data) {
          this.profile.set({
            id: data.id || CHANNEL_ID,
            username: data.username || CHANNEL_LOGIN,
            displayName: data.display_name || CHANNEL_LOGIN,
            profileImageUrl: data.profile_image_url || ''
          });
        }
      }
    } catch {
      this.healthMs.set(null);
    }
  }

  private showToast(message: string): void {
    this.toast.set(message);
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastTimer = window.setTimeout(() => {
      this.toast.set(null);
      this.toastTimer = null;
    }, 2400);
  }
}
