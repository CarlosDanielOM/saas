import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowRight,
  ChevronDown,
  Coins,
  Crown,
  Heart,
  LucideAngularModule,
  MessageSquare,
  Moon,
  Sparkles,
  Sun,
  Trophy,
  User,
  Wallet
} from 'lucide-angular';

import { AnalyticsService } from '../../services/analytics.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface TipLeaderboardEntry {
  rank: number;
  donor: string;
  amount: number;
  note: string;
}

interface TipPageMockConfig {
  streamerName?: string;
  currency?: string;
  messageLimit?: number;
}

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_MESSAGE_LIMIT = 350;
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN'] as const;

function normalizeCurrency(value: string | undefined): string {
  if (!value) {
    return DEFAULT_CURRENCY;
  }

  const normalized = value.trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(normalized as (typeof SUPPORTED_CURRENCIES)[number])
    ? normalized
    : DEFAULT_CURRENCY;
}

function normalizeMessageLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MESSAGE_LIMIT;
  }

  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : DEFAULT_MESSAGE_LIMIT;
}

@Component({
  selector: 'app-tip-page',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './tip-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TipPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(AnalyticsService);
  private readonly languageService = inject(LanguageService);
  private readonly themeService = inject(ThemeService);
  private readonly sessionAuth = inject(SessionAuthService);

  readonly userIcon = User;
  readonly walletIcon = Wallet;
  readonly messageIcon = MessageSquare;
  readonly trophyIcon = Trophy;
  readonly sparklesIcon = Sparkles;
  readonly heartIcon = Heart;
  readonly arrowRightIcon = ArrowRight;
  readonly moonIcon = Moon;
  readonly sunIcon = Sun;
  readonly chevronDownIcon = ChevronDown;
  readonly crownIcon = Crown;
  readonly coinsIcon = Coins;

  readonly presetAmounts = signal([5, 10, 20, 50, 100]);

  selectPreset(amount: number): void {
    this.donationAmount.set(amount.toFixed(2));
  }

  private readonly mockConfig = signal<TipPageMockConfig>({
    currency: undefined,
    messageLimit: undefined
  });

  // User can override the default currency
  private readonly userCurrency = signal<string | null>(null);

  readonly routeStreamer = computed(() => getRouteParam(this.route, 'streamer') ?? 'domdima');
  readonly streamerName = computed(() => {
    const configuredName = this.mockConfig().streamerName?.trim();
    if (configuredName) {
      return configuredName;
    }

    const rawStreamer = decodeURIComponent(this.routeStreamer()).trim();
    if (!rawStreamer) {
      return 'DomDima';
    }

    return rawStreamer
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  });

  // Use user-selected currency if available, otherwise fall back to mock config default
  readonly selectedCurrency = computed(() => {
    const userSelected = this.userCurrency();
    if (userSelected) {
      return normalizeCurrency(userSelected);
    }
    return normalizeCurrency(this.mockConfig().currency);
  });

  readonly messageLimit = computed(() => normalizeMessageLimit(this.mockConfig().messageLimit));

  readonly donorName = signal('');
  readonly donationAmount = signal('25.00');
  readonly message = signal('Thanks for the stream. Keep going, this has been such a fun month to watch.');

  readonly monthlyLeaderboard = computed<TipLeaderboardEntry[]>(() => {
    this.languageService.currentLanguage();
    return [
      { rank: 1, donor: 'PixelPulse', amount: 250, note: this.t('tip.mockNotes.one') },
      { rank: 2, donor: 'LunaByte', amount: 180, note: this.t('tip.mockNotes.two') },
      { rank: 3, donor: 'NoxWave', amount: 140, note: this.t('tip.mockNotes.three') },
      { rank: 4, donor: 'Cafiend', amount: 95, note: this.t('tip.mockNotes.four') },
      { rank: 5, donor: 'RetroNova', amount: 60, note: this.t('tip.mockNotes.five') }
    ];
  });

  readonly remainingCharacters = computed(() => this.messageLimit() - this.message().length);
  readonly donationPreview = computed(() => {
    const parsed = Number(this.donationAmount());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  });
  readonly monthlyTotal = computed(() =>
    this.monthlyLeaderboard().reduce((total, entry) => total + entry.amount, 0)
  );

  readonly currencyOptions = computed(() => SUPPORTED_CURRENCIES.filter(c => c !== this.selectedCurrency()));

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'EN' : 'ES';
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  loginWithTwitch(): void {
    this.analytics.capture('tip_login_clicked', {
      source: 'tip_page',
      target_streamer: this.routeStreamer(),
    });
    this.analytics.capture('auth_started', {
      source: 'tip_page',
      target_streamer: this.routeStreamer(),
    });
    this.sessionAuth.startTwitchLogin();
  }

  updateCurrency(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.userCurrency.set(normalizeCurrency(value));
  }

  updateDonorName(event: Event): void {
    this.donorName.set((event.target as HTMLInputElement).value);
  }

  updateDonationAmount(event: Event): void {
    const input = event.target as HTMLInputElement;
    let value = input.value;
    
    // Allow empty string, single decimal point, and valid decimal numbers
    // Remove any characters that aren't digits or decimal points
    value = value.replace(/[^\d.]/g, '');
    
    // Ensure only one decimal point
    const parts = value.split('.');
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('');
    }
    
    // Update the signal with the cleaned value
    this.donationAmount.set(value);
    
    // If the cleaned value is different from input, update the input element
    // This prevents the cursor jumping issue
    if (input.value !== value) {
      input.value = value;
    }
  }

  updateMessage(event: Event): void {
    const nextValue = (event.target as HTMLTextAreaElement).value;
    this.message.set(nextValue.slice(0, this.messageLimit()));
  }

  formatAmount(amount: number, currency = this.selectedCurrency()): string {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 2
      }).format(amount);
    } catch {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: DEFAULT_CURRENCY,
        maximumFractionDigits: 2
      }).format(amount);
    }
  }
}
