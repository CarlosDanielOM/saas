import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  PLATFORM_ID,
  computed,
  inject,
  signal
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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

import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
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

interface FeatureGuide {
  chip: string;
  titleKey: string;
  descriptionKey: string;
  ctaKey: string;
  path: string;
}

const FEATURE_GUIDES: readonly FeatureGuide[] = [
  {
    chip: 'AI',
    titleKey: 'landing.features.aiModerationTitle',
    descriptionKey: 'landing.features.aiModerationDescription',
    ctaKey: 'landing.features.aiModerationCta',
    path: '/follow-defense/'
  },
  {
    chip: 'AUTO',
    titleKey: 'landing.features.automationTitle',
    descriptionKey: 'landing.features.automationDescription',
    ctaKey: 'landing.features.automationCta',
    path: '/commands/'
  },
  {
    chip: 'DATA',
    titleKey: 'landing.features.analyticsTitle',
    descriptionKey: 'landing.features.analyticsDescription',
    ctaKey: 'landing.features.analyticsCta',
    path: '/dashboard/'
  },
  {
    chip: 'VOICE',
    titleKey: 'landing.features.ttsTitle',
    descriptionKey: 'landing.features.ttsDescription',
    ctaKey: 'landing.features.ttsCta',
    path: '/tts/'
  }
];

@Component({
  selector: 'app-landing-page',
  imports: [LucideAngularModule, CountUpDirective, BrandLogoComponent, RouterLink],
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
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

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

  readonly featureGuides = computed(() => {
    const prefix = this.languageService.currentLanguage() === 'es' ? '/es' : '';
    return FEATURE_GUIDES.map((feature) => ({
      ...feature,
      href: `https://docs.domdimabot.com${prefix}${feature.path}`
    }));
  });

  readonly pricingTiers = computed<PricingTier[]>(() => [
    {
      key: 'free',
      label: this.t('landing.pricingMatrix.item1'),
      monthlyPriceLabel: '$0',
      description: this.t('landing.pricingMatrix.item2'),
      ctaLabel: this.t('landing.pricingMatrix.item3')
    },
    {
      key: 'premium',
      label: 'Premium',
      monthlyPriceLabel: '$6',
      description: this.t('landing.pricingMatrix.item4'),
      ctaLabel: this.t('landing.pricingMatrix.item5')
    },
    {
      key: 'pro',
      label: 'Pro',
      monthlyPriceLabel: '$15',
      description: this.t('landing.pricingMatrix.item6'),
      ctaLabel: this.t('landing.pricingMatrix.item7')
    }
  ]);

  readonly pricingCapabilities = computed<PricingRow[]>(() => [
    { label: this.t('landing.pricingMatrix.item8'), free: this.t('landing.pricingMatrix.item9'), premium: this.t('landing.pricingMatrix.item10'), pro: this.t('landing.pricingMatrix.aiShort') },
    { label: this.t('landing.pricingMatrix.item11'), free: this.t('landing.pricingMatrix.item12'), premium: this.t('landing.pricingMatrix.item13'), pro: this.t('landing.pricingMatrix.item14') },
    { label: this.t('landing.pricingMatrix.item15'), free: this.t('landing.pricingMatrix.item16'), premium: this.t('landing.pricingMatrix.item16'), pro: this.t('landing.pricingMatrix.item16') },
    {
      label: this.t('landing.pricingMatrix.item17'),
      free: this.t('landing.pricingMatrix.item9'),
      premium: this.t('landing.pricingMatrix.item18'),
      pro: this.t('landing.pricingMatrix.item18'),
      note: this.t('landing.pricingMatrix.item20')
    },
    { label: this.t('landing.pricingMatrix.item21'), free: 'X', premium: 'Check', pro: 'Check' },
    { label: this.t('landing.pricingMatrix.item22'), free: 'Cache (24h)', premium: 'Cache + DB', pro: 'Cache + DB' },
    { label: 'TTS', free: this.t('landing.pricingMatrix.item23'), premium: this.t('landing.pricingMatrix.item23'), pro: this.t('landing.pricingMatrix.item23') },
    { label: this.t('landing.pricingMatrix.item24'), free: '1', premium: '2', pro: '3' },
    {
      label: this.t('landing.pricingMatrix.item25'),
      free: this.t('landing.pricingMatrix.item26'),
      premium: 'Tune*',
      pro: 'Tune*',
      note: this.t('landing.pricingMatrix.item27')
    },
    {
      label: this.t('landing.pricingMatrix.item28'),
      free: this.t('landing.pricingMatrix.item12'),
      premium: this.t('landing.pricingMatrix.item18'),
      pro: this.t('landing.pricingMatrix.item19'),
      note: this.t('landing.pricingMatrix.item29')
    },
    {
      label: this.t('landing.pricingMatrix.item30'),
      free: this.t('landing.pricingMatrix.item31'),
      premium: this.t('landing.pricingMatrix.item32'),
      pro: this.t('landing.pricingMatrix.item33')
    },
    {
      label: this.t('landing.pricingMatrix.item34'),
      free: this.t('landing.pricingMatrix.item35'),
      premium: this.t('landing.pricingMatrix.item36'),
      pro: this.t('landing.pricingMatrix.item36')
    },
    { label: this.t('landing.pricingMatrix.item37'), free: this.t('landing.pricingMatrix.item38'), premium: this.t('landing.pricingMatrix.item39'), pro: this.t('landing.pricingMatrix.item39') }
  ]);

  readonly pricingLimits = computed<PricingRow[]>(() => [
    {
      label: this.t('landing.pricingMatrix.item40'),
      free: '25,000',
      premium: '200,000',
      pro: '800,000',
      note: this.t('landing.pricingMatrix.item41')
    },
    { label: this.t('landing.pricingMatrix.item42'), free: '5MB', premium: '25MB', pro: '100MB' },
    { label: this.t('landing.pricingMatrix.item43'), free: this.t('landing.pricingMatrix.item31'), premium: '250MB', pro: '1GB' },
    {
      label: this.t('landing.pricingMatrix.item44'),
      free: '10GB',
      premium: '1TB',
      pro: this.t('landing.pricingMatrix.item45'),
      note: this.t('landing.pricingMatrix.item46')
    },
    {
      label: this.t('landing.pricingMatrix.item47'),
      free: '5s',
      premium: '3s',
      pro: '1s',
      note: this.t('landing.pricingMatrix.item48')
    },
    { label: this.t('landing.pricingMatrix.item49'), free: '30d', premium: '180d', pro: '365d' },
    { label: this.t('landing.pricingMatrix.item50'), free: '15d', premium: '45d', pro: '120d' }
  ]);

  readonly visibleCapabilities = computed(() =>
    this.showAllPricingRows() ? this.pricingCapabilities() : this.pricingCapabilities().slice(0, 6)
  );

  readonly visibleLimits = computed(() =>
    this.showAllPricingRows() ? this.pricingLimits() : this.pricingLimits().slice(0, 4)
  );

  ngOnInit(): void {
    // start() is browser-only internally: no SSE connection, no snapshot fetch
    // and no live telemetry is serialized during prerender. The live board
    // hydrates in its deterministic empty state and updates once the browser
    // establishes the stream.
    this.siteAnalytics.start();

    if (this.isBrowser) {
      this.onWindowScroll();
    }
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
