import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Shield,
  Zap,
  BarChart3,
  Volume2,
  Sun,
  Moon,
  Activity,
  Eye,
  Users,
  Heart,
  Sparkles,
  TrendingUp,
  AlertCircle,
  CheckCircle2
} from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';
import { ThemeService } from '../../services/theme.service';

interface KpiTile {
  id: string;
  label: string;
  value: number;
  delta: number;
  icon: typeof Activity;
  color: 'mod' | 'cmd' | 'ana' | 'voi' | 'ey' | 'us' | 'he' | 'sp';
}

interface HistoryPoint {
  day: string;
  viewers: number;
  hours: number;
  chat: number;
}

interface ActivityRow {
  id: string;
  type: 'mod' | 'sub' | 'follow' | 'cmd' | 'tip' | 'raid';
  text: string;
  ago: string;
  color: string;
}

interface SystemRow {
  id: string;
  label: string;
  status: 'nominal' | 'ok' | 'warn' | 'crit';
  value: string;
}

@Component({
  selector: 'app-landing-dashboard-mock-23',
  imports: [LucideAngularModule, RouterLink, CountUpDirective, UpperCasePipe],
  templateUrl: './landing-dashboard-mock-23.component.html',
  styleUrl: './landing-dashboard-mock-23.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingDashboardMock23Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly themeService = inject(ThemeService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly theme = this.themeService.theme;
  readonly isDarkMode = this.themeService.isDarkMode;

  // Sidebar / drawer state
  // Initial state: open on desktop (≥768px), closed on mobile so the drawer
  // doesn't cover the screen on first load.
  readonly sidebarOpen = signal(
    typeof window === 'undefined' ? true : window.innerWidth >= 768
  );

  // Mock channel context
  readonly channel = signal({
    name: 'astra',
    display: 'AstraArc',
    tier: 'premium' as const,
    live: true,
    startedAt: '2h 14m',
    category: 'Just Chatting',
    title: 'Late-night stargazing & chill'
  });

  // KPIs (in real product these come from the API)
  readonly kpis = computed<KpiTile[]>(() => {
    const live = this.siteStats().totalLiveViewer;
    return [
      { id: 'ey', label: 'Active viewers', value: Math.max(live, 1247), delta: 12.4, icon: Eye, color: 'ey' },
      { id: 'us', label: 'New followers', value: 84, delta: 6.1, icon: Users, color: 'us' },
      { id: 'he', label: 'Subs this month', value: 36, delta: 22.5, icon: Heart, color: 'he' },
      { id: 'sp', label: 'Bits (24h)', value: 18420, delta: 9.8, icon: Sparkles, color: 'sp' }
    ];
  });

  // Stream history — 14 day points
  readonly history = signal<HistoryPoint[]>([
    { day: '01', viewers: 412, hours: 2.4, chat: 1180 },
    { day: '02', viewers: 538, hours: 3.1, chat: 1410 },
    { day: '03', viewers: 502, hours: 2.8, chat: 1310 },
    { day: '04', viewers: 612, hours: 3.4, chat: 1620 },
    { day: '05', viewers: 728, hours: 4.0, chat: 1890 },
    { day: '06', viewers: 690, hours: 3.6, chat: 1740 },
    { day: '07', viewers: 845, hours: 4.2, chat: 2120 },
    { day: '08', viewers: 902, hours: 4.6, chat: 2310 },
    { day: '09', viewers: 1040, hours: 5.1, chat: 2640 },
    { day: '10', viewers: 980, hours: 4.8, chat: 2480 },
    { day: '11', viewers: 1120, hours: 5.4, chat: 2820 },
    { day: '12', viewers: 1080, hours: 5.0, chat: 2710 },
    { day: '13', viewers: 1210, hours: 5.8, chat: 3050 },
    { day: '14', viewers: 1247, hours: 2.3, chat: 1840 }
  ]);

  // Activity feed
  readonly activity = signal<ActivityRow[]>([
    { id: 'a1', type: 'raid', text: 'Raid from @nova_orbit (320 viewers)', ago: 'just now', color: '#f0abfc' },
    { id: 'a2', type: 'sub', text: '@lunarscript gifted 5 subs', ago: '2m', color: '#93c5fd' },
    { id: 'a3', type: 'tip', text: 'Tip $25 from @starfall', ago: '4m', color: '#fde68a' },
    { id: 'a4', type: 'mod', text: 'Auto-mod: 3 messages held', ago: '7m', color: '#a78bfa' },
    { id: 'a5', type: 'follow', text: '12 new followers', ago: '9m', color: '#c4b5fd' },
    { id: 'a6', type: 'cmd', text: '!so @darkmatter', ago: '12m', color: '#34d399' }
  ]);

  // System telemetry
  readonly system = signal<SystemRow[]>([
    { id: 's1', label: 'Bot uptime', status: 'nominal', value: '99.98%' },
    { id: 's2', label: 'Chat latency', status: 'ok', value: '42 ms' },
    { id: 's3', label: 'API rate', status: 'ok', value: '12 / 100 rpm' },
    { id: 's4', label: 'Voice queue', status: 'ok', value: '0 pending' },
    { id: 's5', label: 'Last heartbeat', status: 'nominal', value: '4 s ago' }
  ]);

  // Chart geometry (computed from history)
  readonly chartPath = computed(() => {
    const pts = this.history();
    const maxV = Math.max(...pts.map((p) => p.viewers));
    const w = 600;
    const h = 180;
    const pad = 8;
    const stepX = (w - pad * 2) / (pts.length - 1);
    const yFor = (v: number) => h - pad - (v / maxV) * (h - pad * 2);

    let line = '';
    let area = '';
    pts.forEach((p, i) => {
      const x = pad + i * stepX;
      const y = yFor(p.viewers);
      line += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
      area += i === 0 ? `M ${x} ${h}` : ` L ${x} ${y}`;
    });
    area += ` L ${pad + (pts.length - 1) * stepX} ${h} Z`;

    return { line, area, stepX, pad, h, w };
  });

  // KPIs for the "platform" rail (uses real live data)
  readonly platformKpis = computed(() => ({
    bots: this.siteStats().botActiveAccounts,
    users: this.siteStats().liveUsers,
    msgs: this.siteStats().messagesReceived
  }));

  // icons
  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;
  readonly sunIcon = Sun;
  readonly moonIcon = Moon;
  readonly activityIcon = Activity;
  readonly eyeIcon = Eye;
  readonly usersIcon = Users;
  readonly heartIcon = Heart;
  readonly sparklesIcon = Sparkles;
  readonly trendingIcon = TrendingUp;
  readonly alertIcon = AlertCircle;
  readonly checkIcon = CheckCircle2;

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }
}
