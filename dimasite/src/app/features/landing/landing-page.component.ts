import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideAngularModule,
  Activity,
  Tv,
  Users,
  MessageCircle,
  Zap,
  Settings,
  Check,
  Moon,
  Sun
} from 'lucide-angular';
import { environment } from '../../../environments/environment';

import { SiteStats } from '../../models/site-stats.model';
import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { AnalyticsService } from '../../services/analytics.service';
import { CheckoutIntentService } from '../../services/checkout-intent.service';
import { SupportedLanguage, LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { HeroOrbComponent } from './hero-orb.component';

interface SiteAnalyticsSnapshotDto {
  registeredUsers?: unknown;
  liveUsers?: unknown;
  authorizedAccounts?: unknown;
  totalMessages?: unknown;
  totalCommands?: unknown;
  totalLiveViewers?: unknown;
  liveChannels?: unknown;
}

interface LiveChannelBoardEntry {
  channelID: string;
  channel: string;
  viewers: number;
  profileImageUrl: string;
  botPlatforms: Array<'twitch' | 'kick'>;
}

type PlanKey = 'free' | 'premium' | 'pro';

interface PricingTier {
  key: PlanKey;
  label: string;
  monthlyPriceLabel: string;
  description: string;
  ctaLabel: string;
  ctaEnabled: boolean;
}

interface PricingRow {
  label: string;
  free: string;
  premium: string;
  pro: string;
  note?: string;
}

@Component({
  selector: 'app-landing-page',
  imports: [LucideAngularModule, CountUpDirective, HeroOrbComponent],
  templateUrl: './landing-page.component.html',
  styleUrl: './landing-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'onWindowScroll()'
  }
})
export class LandingPageComponent implements OnInit, OnDestroy {
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly router = inject(Router);
  private readonly analytics = inject(AnalyticsService);
  private readonly linksService = inject(LinksService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly checkoutIntent = inject(CheckoutIntentService);
  private readonly themeService = inject(ThemeService);

  readonly siteStats = signal<SiteStats>({
    registeredUsers: 0,
    liveUsers: 0,
    botActiveAccounts: 0,
    messagesReceived: 0,
    totalCommands: 0,
    totalLiveViewer: 0
  });
  readonly isDarkMode = computed(() => this.themeService.isDarkMode());

  readonly activityIcon = Activity;
  readonly tvIcon = Tv;
  readonly usersIcon = Users;
  readonly messageCircleIcon = MessageCircle;
  readonly zapIcon = Zap;
  readonly settingsIcon = Settings;
  readonly checkIcon = Check;
  readonly moonIcon = Moon;
  readonly sunIcon = Sun;

  private revealObserver: IntersectionObserver | null = null;
  private analyticsEventSource: EventSource | null = null;
  private analyticsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly analyticsConnectionStatus = signal<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  private analyticsReconnectAttempts = 0;
  readonly liveChannels = signal<LiveChannelBoardEntry[]>([]);
  readonly activePricingTier = signal<PlanKey>('premium');
  readonly showAllPricingRows = signal(false);

  readonly pricingTiers: PricingTier[] = [
    {
      key: 'free',
      label: 'Free',
      monthlyPriceLabel: '$0/mo',
      description: 'Perfect for streamers getting started with automation and moderation.',
      ctaLabel: 'Get Started',
      ctaEnabled: true
    },
    {
      key: 'premium',
      label: 'Premium',
      monthlyPriceLabel: '$6/mo',
      description: 'Best for growing communities that need smarter moderation and deeper controls.',
      ctaLabel: 'Choose Premium',
      ctaEnabled: true
    },
    {
      key: 'pro',
      label: 'Pro',
      monthlyPriceLabel: '$15/mo',
      description: 'Built for serious creators with higher scale, quality, and AI flexibility.',
      ctaLabel: 'Choose Pro',
      ctaEnabled: true
    }
  ];

  readonly pricingCapabilities: PricingRow[] = [
    { label: 'Chat moderation', free: 'Basic', premium: 'Smart', pro: 'AI' },
    { label: 'Support', free: 'Normal', premium: 'Priority', pro: 'Priority+' },
    { label: 'Custom commands', free: 'Unlimited', premium: 'Unlimited', pro: 'Unlimited' },
    {
      label: 'Analytics',
      free: 'Basic',
      premium: 'Advanced',
      pro: 'Advanced',
      note: 'Advanced analytics includes per-user message counts, stream attendance frequency, command usage, and more.'
    },
    { label: 'Temporary VIP/Mod', free: 'X', premium: 'Check', pro: 'Check' },
    { label: 'Variables', free: 'Cache (24h)', premium: 'Cache + DB', pro: 'Cache + DB' },
    { label: 'TTS', free: 'Basic', premium: 'Human-like', pro: 'Voice cloning' },
    { label: 'AI bot personalities', free: '1', premium: '2', pro: '3' },
    {
      label: 'AI mode quality',
      free: 'Base',
      premium: 'Tune*',
      pro: 'Tune*',
      note: '*Tune is available when enough data exists (more than 50k messages and 30 days of stream data).'
    },
    {
      label: 'Custom redemptions',
      free: 'Normal',
      premium: 'Advanced',
      pro: 'Advanced*',
      note: 'Advanced* supports rule-based behavior beyond on-redeem triggers (for example time/context conditions).'
    },
    {
      label: 'Memory learning from chat',
      free: 'None',
      premium: 'Learns from chat',
      pro: 'Learns from chat + stream summaries and more data'
    },
    {
      label: 'Upload visibility',
      free: 'Public marketplace only',
      premium: 'Public or private',
      pro: 'Public or private'
    },
    { label: 'SO overlay design', free: 'Default', premium: 'Custom', pro: 'Custom' }
  ];

  readonly pricingLimits: PricingRow[] = [
    {
      label: 'AI credits / month',
      free: '25',
      premium: '125',
      pro: '500',
      note: 'Credits are non-rollover.'
    },
    { label: 'Max upload size', free: '5MB', premium: '25MB', pro: '100MB' },
    { label: 'Max file storage', free: '100MB', premium: '1GB', pro: '10GB' },
    {
      label: 'Bandwidth',
      free: '10GB',
      premium: '1TB',
      pro: 'Unlimited*',
      note: '10GB is around 8 hours of video, 1TB is around 30 days. Unlimited is under fair-use and abuse policies.'
    },
    {
      label: 'Minimum command cooldowns',
      free: '5s',
      premium: '3s',
      pro: '1s',
      note: 'Streamer can still set cooldown per command following this minimum rule.'
    },
    { label: 'Stream analytics retention', free: '30d', premium: '180d', pro: '365d' },
    { label: 'Chat memory retention', free: '15d', premium: '45d', pro: '120d' }
  ];

  readonly visibleCapabilities = computed(() =>
    this.showAllPricingRows() ? this.pricingCapabilities : this.pricingCapabilities.slice(0, 6)
  );

  readonly visibleLimits = computed(() =>
    this.showAllPricingRows() ? this.pricingLimits : this.pricingLimits.slice(0, 4)
  );

  ngOnInit(): void {
    this.fetchAnalyticsSnapshot();
    this.connectAnalyticsStream();
    this.setupRevealAnimations();
    this.onWindowScroll();
  }

  ngOnDestroy(): void {
    this.analyticsEventSource?.close();
    if (this.analyticsReconnectTimer) {
      clearTimeout(this.analyticsReconnectTimer);
    }
    this.revealObserver?.disconnect();
    this.analyticsConnectionStatus.set('disconnected');
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  getCurrentLanguageInfo() {
    return this.languageService.getLanguageInfo(this.languageService.getCurrentLanguage());
  }

  loginWithTwitch(): void {
    this.checkoutIntent.clearPendingPlan();
    this.analytics.capture('landing_cta_clicked', {
      action: 'login',
      source: 'landing',
    });
    this.analytics.capture('auth_started', {
      source: 'landing',
    });
    this.beginAuthFlow();
  }

  choosePlan(plan: PlanKey): void {
    this.analytics.capture('checkout_intent_selected', {
      source: 'landing_pricing',
      target_plan: plan,
    });
    this.analytics.capture('auth_started', {
      source: 'landing_pricing',
      target_plan: plan,
    });

    if (plan === 'premium' || plan === 'pro') {
      this.checkoutIntent.setPendingPlan(plan);
    } else {
      this.checkoutIntent.clearPendingPlan();
    }

    this.beginAuthFlow();
  }

  openDiscord(): void {
    this.analytics.capture('discord_opened', {
      source: 'landing',
    });
    window.open(this.linksService.getDiscordUrl(), '_blank', 'noopener,noreferrer');
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  switchLanguage(language: SupportedLanguage): void {
    this.languageService.setLanguage(language);
  }

  getAnalyticsConnectionText(): string {
    switch (this.analyticsConnectionStatus()) {
      case 'connected':
        return this.t('landing.analyticsConnection.connected');
      case 'reconnecting':
        return this.t('landing.analyticsConnection.reconnecting');
      default:
        return this.t('landing.analyticsConnection.disconnected');
    }
  }

  digitCount(value: number): number {
    const normalized = Math.abs(Math.floor(value));
    if (normalized === 0) {
      return 1;
    }
    return String(normalized).length;
  }

  toggleTheme(): void {
    this.themeService.setTheme(this.themeService.isDarkMode() ? 'light' : 'dark');
  }

  setActivePricingTier(tier: PlanKey): void {
    this.activePricingTier.set(tier);
  }

  pricingValue(row: PricingRow, tier: PlanKey): string {
    return row[tier];
  }

  isCheckValue(value: string): boolean {
    return value.toLowerCase() === 'check';
  }

  togglePricingRows(): void {
    this.showAllPricingRows.update((value) => !value);
  }

  onWindowScroll(): void {
    const scrollY = window.scrollY || window.pageYOffset;
    const host = this.elementRef.nativeElement;

    const navbar = host.querySelector('.sticky-navbar');
    if (navbar) {
      navbar.classList.toggle('scrolled', scrollY > 8);
    }

    host.querySelectorAll('.parallax-layer').forEach((layer) => {
      const element = layer as HTMLElement;
      const depth = Number(element.dataset['depth'] ?? '0.04');
      element.style.transform = `translate3d(0, ${Math.round(scrollY * depth)}px, 0)`;
    });
  }

  private connectAnalyticsStream(): void {
    this.analyticsEventSource?.close();
    this.analyticsEventSource = new EventSource(`${environment.DIMA_API}/config/site/analytics/stream`);
    this.analyticsConnectionStatus.set('reconnecting');

    this.analyticsEventSource.onopen = () => {
      this.analyticsReconnectAttempts = 0;
      this.analyticsConnectionStatus.set('connected');
    };

    this.analyticsEventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data) as SiteAnalyticsSnapshotDto;
      this.applyAnalyticsSnapshot(payload);
      this.analyticsConnectionStatus.set('connected');
    };

    this.analyticsEventSource.onerror = () => {
      this.analyticsEventSource?.close();
      this.analyticsEventSource = null;
      this.analyticsReconnectAttempts += 1;
      this.analyticsConnectionStatus.set(
        this.analyticsReconnectAttempts > 3 ? 'disconnected' : 'reconnecting'
      );
      this.fetchAnalyticsSnapshot();
      this.scheduleAnalyticsReconnect();
    };
  }

  private scheduleAnalyticsReconnect(): void {
    if (this.analyticsReconnectTimer) {
      clearTimeout(this.analyticsReconnectTimer);
    }

    this.analyticsReconnectTimer = setTimeout(() => {
      this.connectAnalyticsStream();
    }, 3500);
  }

  private async fetchAnalyticsSnapshot(): Promise<void> {
    try {
      const response = await fetch(`${environment.DIMA_API}/config/site/analytics`);
      if (!response.ok) {
        return;
      }

      const envelope = (await response.json()) as { data?: SiteAnalyticsSnapshotDto };
      if (!envelope.data) {
        return;
      }

      this.applyAnalyticsSnapshot(envelope.data);
    } catch {
      // no-op; live stream retries and later snapshots recover state
    }
  }

  private applyAnalyticsSnapshot(payload: SiteAnalyticsSnapshotDto): void {
    this.siteStats.set({
      registeredUsers: this.safeNumber(payload.registeredUsers),
      liveUsers: this.safeNumber(payload.liveUsers),
      botActiveAccounts: this.safeNumber(payload.authorizedAccounts),
      messagesReceived: this.safeNumber(payload.totalMessages),
      totalCommands: this.safeNumber(payload.totalCommands),
      totalLiveViewer: this.safeNumber(payload.totalLiveViewers)
    });

    this.liveChannels.set(this.normalizeLiveChannels(payload.liveChannels));
  }

  private setupRevealAnimations(): void {
    this.revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          entry.target.classList.add('reveal-in');
          entry.target.classList.remove('reveal-init');
          this.revealObserver?.unobserve(entry.target);
        });
      },
      { threshold: 0.15 }
    );

    this.elementRef.nativeElement.querySelectorAll('.reveal-init').forEach((element) => {
      this.revealObserver?.observe(element as Element);
    });
  }

  private safeNumber(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(0, Math.floor(parsed));
  }

  private normalizeLiveChannels(value: unknown): LiveChannelBoardEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const raw = entry as Record<string, unknown>;
        const botPlatforms = Array.isArray(raw['botPlatforms'])
          ? raw['botPlatforms']
              .map((platform) => String(platform).toLowerCase())
              .filter((platform): platform is 'twitch' | 'kick' =>
                platform === 'twitch' || platform === 'kick'
              )
          : [];

        return {
          channelID: String(raw['channelID'] || ''),
          channel: String(raw['channel'] || raw['channelID'] || '').trim(),
          viewers: this.safeNumber(raw['viewers']),
          profileImageUrl: String(raw['profileImageUrl'] || ''),
          botPlatforms
        };
      })
      .filter((entry): entry is LiveChannelBoardEntry => Boolean(entry && entry.channel))
      .sort((a, b) => b.viewers - a.viewers);
  }

  private beginAuthFlow(): void {
    if (this.sessionAuth.hasValidSession()) {
      void this.router.navigate(['/login']);
      return;
    }

    this.sessionAuth.startTwitchLogin();
  }
}
