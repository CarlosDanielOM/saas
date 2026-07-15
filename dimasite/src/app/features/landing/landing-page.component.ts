import {
  ChangeDetectionStrategy,
  Component,
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
  Check,
  Moon,
  Sun
} from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { AnalyticsService } from '../../services/analytics.service';
import { CheckoutIntentService } from '../../services/checkout-intent.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { SiteAnalyticsService } from '../../services/site-analytics.service';
import { ThemeService } from '../../services/theme.service';

type PlanKey = 'free' | 'premium' | 'pro';

interface PricingTier {
  key: PlanKey;
  label: string;
  monthlyPriceLabel: string;
  description: string;
  ctaLabel: string;
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
  imports: [LucideAngularModule, CountUpDirective],
  templateUrl: './landing-page.component.html',
  styleUrl: './landing-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'onWindowScroll()'
  }
})
export class LandingPageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly analytics = inject(AnalyticsService);
  private readonly siteAnalytics = inject(SiteAnalyticsService);
  private readonly linksService = inject(LinksService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly checkoutIntent = inject(CheckoutIntentService);
  private readonly themeService = inject(ThemeService);

  readonly fallbackAvatar =
    'https://static-cdn.jtvnw.net/jtv_user_pictures/xarth/404_user_70x70.png';

  /** Live production site metrics + channels (SSE → api.domdimabot.com). */
  readonly siteStats = this.siteAnalytics.siteStats;
  readonly liveChannels = this.siteAnalytics.liveChannels;
  readonly analyticsConnectionStatus = this.siteAnalytics.connectionStatus;

  readonly isDarkMode = computed(() => this.themeService.isDarkMode());
  readonly navScrolled = signal(false);

  readonly activityIcon = Activity;
  readonly tvIcon = Tv;
  readonly usersIcon = Users;
  readonly messageCircleIcon = MessageCircle;
  readonly zapIcon = Zap;
  readonly checkIcon = Check;
  readonly moonIcon = Moon;
  readonly sunIcon = Sun;

  readonly activePricingTier = signal<PlanKey>('premium');
  readonly showAllPricingRows = signal(false);

  readonly featuredChannel = computed(() => this.liveChannels()[0] ?? null);
  readonly otherChannels = computed(() => this.liveChannels().slice(1, 5));

  readonly pricingTiers: PricingTier[] = [
    {
      key: 'free',
      label: 'Free',
      monthlyPriceLabel: '$0',
      description: 'Perfect for streamers getting started with automation and moderation.',
      ctaLabel: 'Get Started'
    },
    {
      key: 'premium',
      label: 'Premium',
      monthlyPriceLabel: '$6',
      description: 'Best for growing communities that need smarter moderation and deeper controls.',
      ctaLabel: 'Choose Premium'
    },
    {
      key: 'pro',
      label: 'Pro',
      monthlyPriceLabel: '$15',
      description: 'Built for serious creators with higher scale, quality, and AI flexibility.',
      ctaLabel: 'Choose Pro'
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
      free: '25,000',
      premium: '125,000',
      pro: '500,000',
      note: 'Credits are non-rollover.'
    },
    { label: 'Max upload size', free: '5MB', premium: '25MB', pro: '100MB' },
    { label: 'Max file storage', free: '50MB', premium: '250MB', pro: '1GB' },
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
    this.siteAnalytics.start();
    this.onWindowScroll();
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  loginWithTwitch(): void {
    this.checkoutIntent.clearPendingPlan();
    this.analytics.capture('landing_cta_clicked', {
      action: 'login',
      source: 'landing'
    });
    this.analytics.capture('auth_started', {
      source: 'landing'
    });
    this.beginAuthFlow();
  }

  choosePlan(plan: PlanKey): void {
    this.analytics.capture('checkout_intent_selected', {
      source: 'landing_pricing',
      target_plan: plan
    });
    this.analytics.capture('auth_started', {
      source: 'landing_pricing',
      target_plan: plan
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
      source: 'landing'
    });
    window.open(this.linksService.getDiscordUrl(), '_blank', 'noopener,noreferrer');
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

  readonly languageLabel = computed(() =>
    this.languageService.currentLanguage() === 'en' ? 'EN' : 'ES'
  );

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
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

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  formatViewers(n: number): string {
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(n);
  }

  onWindowScroll(): void {
    const scrollY = window.scrollY || window.pageYOffset;
    this.navScrolled.set(scrollY > 8);
  }

  private beginAuthFlow(): void {
    if (this.sessionAuth.hasValidSession()) {
      void this.router.navigate(['/login']);
      return;
    }

    this.sessionAuth.startTwitchLogin();
  }
}
