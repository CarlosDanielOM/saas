import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Crown,
  Lock,
  LucideAngularModule,
  Moon,
  RotateCcw,
  Sparkles,
  Sun,
  Target,
  Volume2,
  X
} from 'lucide-angular';
import { map } from 'rxjs';

import { LanguageService } from '../../../services/language.service';
import { ThemeService } from '../../../services/theme.service';
import { BrandLogoComponent } from '../../../shared/brand-logo/brand-logo.component';

/**
 * Design mock for /tip/:streamer — local state only, no payments.
 * Strings live in a local dictionary so mock copy stays out of the shared i18n bundle.
 */

type Lang = 'en' | 'es';
type BoardTab = 'top' | 'recent';
type PayState = 'idle' | 'processing' | 'done';

interface Supporter {
  name: string;
  amount: number;
  note: string;
  minutesAgo: number;
}

interface Perk {
  id: 'alert' | 'tts' | 'hype' | 'legendary';
  min: number;
}

type AlertTierId = 'basic' | 'hype' | 'legendary';

/**
 * Invented alert variants by tip amount. Swap for the streamer's real alert
 * config once the tip system exists; the template switches on `id`.
 */
interface AlertTier {
  id: AlertTierId;
  min: number;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN'] as const;
const PRESETS = [3, 5, 10, 25, 50, 100];
const MIN_TIP = 1;
const MAX_TIP = 1000;
const MESSAGE_LIMIT = 300;
const GOAL = { raised: 725, target: 1000 };
const ALERT_TIERS: AlertTier[] = [
  { id: 'basic', min: 1 },
  { id: 'hype', min: 10 },
  { id: 'legendary', min: 50 }
];
const TTS_MIN = 3;
const PERKS: Perk[] = [
  { id: 'alert', min: 1 },
  { id: 'tts', min: TTS_MIN },
  { id: 'hype', min: 10 },
  { id: 'legendary', min: 50 }
];
const PROFILE_API = 'https://api.domdimabot.com';

const COPY: Record<Lang, Record<string, string>> = {
  en: {
    mockBanner: 'Design mock · no payments',
    live: 'Live',
    offline: 'Offline',
    login: 'Log in',
    liveNow: 'Live now',
    watching: '{n} watching',
    lastLive: 'Last live 2 days ago',
    streamerNote: 'Every tip pops up on stream and gets read out loud. Thank you for keeping the lights on.',
    amountTitle: 'Choose an amount',
    amountLabel: 'Tip amount',
    currencyLabel: 'Currency',
    minError: 'Minimum tip is {v}',
    maxError: 'Maximum tip is {v}',
    unlocks: 'Your tip unlocks',
    perk_alert: 'On-screen alert',
    perk_tts: 'Read aloud (TTS)',
    perk_hype: 'Hype alert',
    perk_legendary: 'Legendary alert',
    tier_basic: 'Basic',
    tier_hype: 'Hype',
    tier_legendary: 'Legendary',
    tierRange: '{from}–{to}',
    tierFrom: '{from}+',
    tiersLabel: 'Alert tiers',
    tierPick: 'Set amount to {v}',
    previewCaption: 'The alert style changes with the amount.',
    hypeKicker: 'Hype tip',
    legendaryKicker: 'Legendary tip',
    from_name: 'from {name}',
    from: 'from {v}',
    nameLabel: 'Name on stream',
    namePlaceholder: 'Your nickname',
    useTwitch: 'Use my Twitch name',
    messageLabel: 'Message',
    optional: 'optional',
    messagePlaceholder: 'Say something nice. It will be read out loud.',
    left: '{n} left',
    anonymous: 'Tip anonymously',
    anonymousHint: 'Shows as "Anonymous" on stream',
    hideAmount: 'Hide amount on stream',
    hideAmountHint: 'Only {streamer} sees how much you sent',
    previewTitle: 'How it appears on stream',
    replay: 'Replay',
    someone: 'Anonymous',
    tipped: 'tipped',
    sentTip: 'sent a tip',
    goalKicker: 'Stream goal',
    goalTitle: 'New camera for IRL streams',
    goalOf: 'of {v}',
    goalProjection: 'Your {amount} brings it to {pct}%',
    supportersKicker: 'Community',
    supportersTitle: 'Supporters',
    tabTop: 'Top this month',
    tabRecent: 'Recent',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',
    daysAgo: '{n} d ago',
    pay: 'Tip {v}',
    payWith: 'Continue with PayPal',
    total: 'Your tip',
    secure: 'Secure checkout by PayPal. We never see your card.',
    processing: 'Opening PayPal…',
    doneTitle: 'Thank you!',
    doneCopy: 'Your {v} tip is queued. Watch for your alert on stream in a few seconds.',
    doneAgain: 'Send another tip',
    close: 'Close',
    footer: 'Tips go to {streamer}. Payments are processed by PayPal.',
    themeLight: 'Switch to light mode',
    themeDark: 'Switch to dark mode',
    lang: 'Cambiar a español',
    streamPreview: 'Alert preview',
    offlineAlert: 'Your alert plays when {streamer} goes live'
  },
  es: {
    mockBanner: 'Mock de diseño · sin pagos',
    live: 'En vivo',
    offline: 'Offline',
    login: 'Iniciar sesión',
    liveNow: 'En vivo',
    watching: '{n} viendo',
    lastLive: 'En vivo hace 2 días',
    streamerNote: 'Cada propina aparece en el stream y se lee en voz alta. Gracias por mantener las luces encendidas.',
    amountTitle: 'Elige un monto',
    amountLabel: 'Monto de la propina',
    currencyLabel: 'Moneda',
    minError: 'La propina mínima es {v}',
    maxError: 'La propina máxima es {v}',
    unlocks: 'Tu propina desbloquea',
    perk_alert: 'Alerta en pantalla',
    perk_tts: 'Lectura en voz (TTS)',
    perk_hype: 'Alerta Hype',
    perk_legendary: 'Alerta Legendaria',
    tier_basic: 'Básica',
    tier_hype: 'Hype',
    tier_legendary: 'Legendaria',
    tierRange: '{from}–{to}',
    tierFrom: '{from}+',
    tiersLabel: 'Niveles de alerta',
    tierPick: 'Poner monto en {v}',
    previewCaption: 'El estilo de la alerta cambia según el monto.',
    hypeKicker: 'Propina Hype',
    legendaryKicker: 'Propina legendaria',
    from_name: 'de {name}',
    from: 'desde {v}',
    nameLabel: 'Nombre en el stream',
    namePlaceholder: 'Tu apodo',
    useTwitch: 'Usar mi nombre de Twitch',
    messageLabel: 'Mensaje',
    optional: 'opcional',
    messagePlaceholder: 'Escribe algo bonito. Se leerá en voz alta.',
    left: 'quedan {n}',
    anonymous: 'Propina anónima',
    anonymousHint: 'Aparece como "Anónimo" en el stream',
    hideAmount: 'Ocultar monto en el stream',
    hideAmountHint: 'Solo {streamer} ve cuánto enviaste',
    previewTitle: 'Así se verá en el stream',
    replay: 'Repetir',
    someone: 'Anónimo',
    tipped: 'envió',
    sentTip: 'envió una propina',
    goalKicker: 'Meta del stream',
    goalTitle: 'Cámara nueva para streams IRL',
    goalOf: 'de {v}',
    goalProjection: 'Tus {amount} la llevan al {pct}%',
    supportersKicker: 'Comunidad',
    supportersTitle: 'Apoyos',
    tabTop: 'Top del mes',
    tabRecent: 'Recientes',
    minutesAgo: 'hace {n} min',
    hoursAgo: 'hace {n} h',
    daysAgo: 'hace {n} d',
    pay: 'Enviar {v}',
    payWith: 'Continuar con PayPal',
    total: 'Tu propina',
    secure: 'Pago seguro con PayPal. Nunca vemos tu tarjeta.',
    processing: 'Abriendo PayPal…',
    doneTitle: '¡Gracias!',
    doneCopy: 'Tu propina de {v} está en cola. Mira tu alerta en el stream en unos segundos.',
    doneAgain: 'Enviar otra propina',
    close: 'Cerrar',
    footer: 'Las propinas van a {streamer}. PayPal procesa los pagos.',
    themeLight: 'Cambiar a modo claro',
    themeDark: 'Cambiar a modo oscuro',
    lang: 'Switch to English',
    streamPreview: 'Vista previa de la alerta',
    offlineAlert: 'Tu alerta se mostrará cuando {streamer} esté en vivo'
  }
};

const TOP: Supporter[] = [
  { name: 'PixelPulse', amount: 250, note: 'For the late-night streams and all the chaos.', minutesAgo: 4320 },
  { name: 'LunaByte', amount: 180, note: 'Immaculate timing as always.', minutesAgo: 1500 },
  { name: 'NoxWave', amount: 140, note: 'Best collab week so far.', minutesAgo: 9000 },
  { name: 'Cafiend', amount: 95, note: 'Keep the marathon energy going.', minutesAgo: 600 },
  { name: 'RetroNova', amount: 60, note: 'Saving this spot for next time.', minutesAgo: 12000 }
];

const RECENT: Supporter[] = [
  { name: 'mossy_k', amount: 5, note: 'that clutch was insane', minutesAgo: 3 },
  { name: 'Cafiend', amount: 20, note: 'hydrate!!', minutesAgo: 27 },
  { name: 'Anonymous', amount: 10, note: '', minutesAgo: 95 },
  { name: 'LunaByte', amount: 50, note: 'new camera fund lets gooo', minutesAgo: 210 },
  { name: 'tacoboi', amount: 3, note: 'first tip ever', minutesAgo: 1600 }
];

@Component({
  selector: 'app-tip-mock',
  imports: [RouterLink, LucideAngularModule, BrandLogoComponent],
  templateUrl: './tip-mock.component.html',
  styleUrl: './tip-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' }
})
export class TipMockComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);

  readonly icons = {
    ArrowRight,
    Check,
    ChevronDown,
    Crown,
    Lock,
    Moon,
    RotateCcw,
    Sparkles,
    Sun,
    Target,
    Volume2,
    X
  };

  readonly presets = PRESETS;
  readonly currencies = CURRENCIES;
  readonly perks = PERKS;
  readonly tiers = ALERT_TIERS;
  readonly confetti = Array.from({ length: 14 }, (_, i) => i);
  readonly messageLimit = MESSAGE_LIMIT;

  readonly login = toSignal(
    this.route.queryParamMap.pipe(map((q) => (q.get('streamer') ?? 'cdom201').trim().toLowerCase())),
    { initialValue: 'cdom201' }
  );

  readonly displayName = signal<string | null>(null);
  readonly avatarUrl = signal<string | null>(null);
  readonly avatarBroken = signal(false);

  readonly isLive = signal(true);
  readonly amountRaw = signal('10');
  readonly currency = signal<string>('USD');
  readonly donorName = signal('');
  readonly message = signal('');
  readonly anonymous = signal(false);
  readonly hideAmount = signal(false);
  readonly boardTab = signal<BoardTab>('top');
  readonly payState = signal<PayState>('idle');
  readonly alertKey = signal(0);

  readonly lang = computed<Lang>(() => (this.language.currentLanguage() === 'es' ? 'es' : 'en'));
  readonly isDark = computed(() => this.theme.isDarkMode());

  readonly streamer = computed(() => this.displayName() ?? this.login());
  readonly avatarLetter = computed(() => this.streamer().charAt(0).toUpperCase() || '?');

  readonly amount = computed(() => {
    const n = Number(this.amountRaw());
    return Number.isFinite(n) ? n : 0;
  });

  readonly amountError = computed(() => {
    if (this.amountRaw() === '') return '';
    if (this.amount() < MIN_TIP) return this.t('minError', { v: this.money(MIN_TIP) });
    if (this.amount() > MAX_TIP) return this.t('maxError', { v: this.money(MAX_TIP) });
    return '';
  });

  readonly canPay = computed(() => this.amount() >= MIN_TIP && this.amount() <= MAX_TIP);
  readonly currencySymbol = computed(() => {
    const part = this.formatter(this.currency())
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? '$';
  });

  readonly alertTier = computed<AlertTierId>(() => {
    const amount = this.canPay() ? this.amount() : MIN_TIP;
    return [...ALERT_TIERS].reverse().find((tier) => amount >= tier.min)?.id ?? 'basic';
  });

  readonly showTts = computed(() => !!this.message().trim() && this.canPay() && this.amount() >= TTS_MIN);

  readonly remaining = computed(() => MESSAGE_LIMIT - this.message().length);

  readonly alertName = computed(() =>
    this.anonymous() ? this.t('someone') : this.donorName().trim() || this.t('someone')
  );

  readonly goalPct = computed(() => Math.round((GOAL.raised / GOAL.target) * 100));
  readonly goalProjectedPct = computed(() =>
    Math.min(100, Math.round(((GOAL.raised + (this.canPay() ? this.amount() : 0)) / GOAL.target) * 100))
  );
  readonly goalRaised = GOAL.raised;
  readonly goalTarget = GOAL.target;

  readonly supporters = computed(() => (this.boardTab() === 'top' ? TOP : RECENT));

  private readonly doneBtn = viewChild<ElementRef<HTMLButtonElement>>('doneBtn');

  constructor() {
    effect(() => {
      const login = this.login();
      untracked(() => void this.loadProfile(login));
    });
    effect(() => this.doneBtn()?.nativeElement.focus());
  }

  t(key: string, params?: Record<string, string | number>): string {
    let text = COPY[this.lang()][key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  }

  money(value: number, opts: { compact?: boolean } = {}): string {
    const whole = Number.isInteger(value);
    return this.formatter(this.currency(), opts.compact || whole ? 0 : 2).format(value);
  }

  ago(minutes: number): string {
    if (minutes < 60) return this.t('minutesAgo', { n: minutes });
    if (minutes < 1440) return this.t('hoursAgo', { n: Math.round(minutes / 60) });
    return this.t('daysAgo', { n: Math.round(minutes / 1440) });
  }

  hue(name: string): number {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  tierRange(index: number): string {
    const tier = ALERT_TIERS[index];
    const next = ALERT_TIERS[index + 1];
    const from = this.money(tier.min, { compact: true });
    return next
      ? this.t('tierRange', { from, to: this.money(next.min - 1, { compact: true }) })
      : this.t('tierFrom', { from });
  }

  selectTier(tier: AlertTier): void {
    this.amountRaw.set(String(tier.min));
    this.replayAlert();
  }

  perkUnlocked(perk: Perk): boolean {
    return this.canPay() && this.amount() >= perk.min;
  }

  selectPreset(value: number): void {
    this.amountRaw.set(String(value));
    this.replayAlert();
  }

  isPreset(value: number): boolean {
    return this.amount() === value && this.amountRaw() !== '';
  }

  onAmountInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    let value = input.value.replace(/[^\d.]/g, '');
    const [whole, ...rest] = value.split('.');
    value = rest.length ? `${whole.slice(0, 4)}.${rest.join('').slice(0, 2)}` : whole.slice(0, 4);
    this.amountRaw.set(value);
    if (input.value !== value) input.value = value;
  }

  onCurrency(event: Event): void {
    this.currency.set((event.target as HTMLSelectElement).value);
  }

  onName(event: Event): void {
    this.donorName.set((event.target as HTMLInputElement).value.slice(0, 25));
  }

  onMessage(event: Event): void {
    this.message.set((event.target as HTMLTextAreaElement).value.slice(0, MESSAGE_LIMIT));
  }

  useTwitchName(): void {
    this.anonymous.set(false);
    this.donorName.set('viewer_' + Math.floor(1000 + Math.random() * 9000));
    this.replayAlert();
  }

  toggleAnonymous(): void {
    this.anonymous.update((v) => !v);
    this.replayAlert();
  }

  toggleHideAmount(): void {
    this.hideAmount.update((v) => !v);
    this.replayAlert();
  }

  replayAlert(): void {
    this.alertKey.update((k) => k + 1);
  }

  pay(): void {
    if (!this.canPay() || this.payState() !== 'idle') return;
    this.payState.set('processing');
    setTimeout(() => this.payState.set('done'), 1400);
  }

  resetPay(): void {
    this.payState.set('idle');
    this.message.set('');
    this.replayAlert();
  }

  onEscape(): void {
    if (this.payState() === 'done') this.resetPay();
  }

  toggleTheme(): void {
    this.theme.setTheme(this.isDark() ? 'light' : 'dark');
  }

  toggleLanguage(): void {
    this.language.toggleLanguage();
  }

  onAvatarError(): void {
    this.avatarBroken.set(true);
  }

  private formatter(currency: string, digits = 2): Intl.NumberFormat {
    const locale = this.lang() === 'es' ? 'es-MX' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  private async loadProfile(login: string): Promise<void> {
    this.displayName.set(null);
    this.avatarUrl.set(null);
    this.avatarBroken.set(false);
    if (!login) return;
    try {
      const res = await fetch(`${PROFILE_API}/users?username=${encodeURIComponent(login)}`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: { display_name?: string; profile_image_url?: string };
      };
      this.displayName.set(body.data?.display_name?.trim() || null);
      this.avatarUrl.set(body.data?.profile_image_url?.trim() || null);
    } catch {
      // letter fallback
    }
  }
}
