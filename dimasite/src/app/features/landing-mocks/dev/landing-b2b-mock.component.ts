import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  Clapperboard,
  Gift,
  LayoutTemplate,
  LucideAngularModule,
  MessageSquareText,
  Minus,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Users,
  Volume2
} from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { LinksService } from '../../../services/links.service';
import { SiteAnalyticsService } from '../../../services/site-analytics.service';
import { ThemeService } from '../../../services/theme.service';
import { BrandLogoComponent } from '../../../shared/brand-logo/brand-logo.component';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';

/**
 * B2B landing proposal. Live metrics/channels come from the same SSE board as
 * the production landing; the dashboard preview uses sample data.
 * Copy lives in a local dictionary so mock strings stay out of the shared i18n bundle.
 */

type Lang = 'en' | 'es';
type PlanKey = 'free' | 'premium' | 'pro';

interface Plan {
  key: PlanKey;
  price: string;
  bullets: string[];
}

interface MatrixRow {
  key: string;
  free: string;
  premium: string;
  pro: string;
}

interface ModulePill {
  key: string;
  tier?: 'premium' | 'pro';
  status?: 'beta' | 'alpha';
}

const PLANS: Plan[] = [
  { key: 'free', price: '$0', bullets: ['b_cmds', 'b_tts', 'b_defense', 'b_credits_free'] },
  { key: 'premium', price: '$6', bullets: ['b_analytics', 'b_smartmod', 'b_tempvip', 'b_credits_premium'] },
  { key: 'pro', price: '$15', bullets: ['b_aimod', 'b_retention', 'b_cooldown', 'b_credits_pro'] }
];

// Mirrors the production landing matrix; '✓' / '—' render as icons.
const MATRIX: MatrixRow[] = [
  { key: 'm_moderation', free: 'Basic', premium: 'Smart', pro: 'AI' },
  { key: 'm_commands', free: 'Unlimited', premium: 'Unlimited', pro: 'Unlimited' },
  { key: 'm_analytics', free: 'Basic', premium: 'Advanced', pro: 'Advanced' },
  { key: 'm_tempvip', free: '—', premium: '✓', pro: '✓' },
  { key: 'm_variables', free: 'Cache (24h)', premium: 'Cache + DB', pro: 'Cache + DB' },
  { key: 'm_tts', free: '✓', premium: '✓', pro: '✓' },
  { key: 'm_personalities', free: '1', premium: '2', pro: '3' },
  { key: 'm_credits', free: '25,000', premium: '200,000', pro: '800,000' },
  { key: 'm_cooldown', free: '5s', premium: '3s', pro: '1s' },
  { key: 'm_retention', free: '30d', premium: '180d', pro: '365d' },
  { key: 'm_memory', free: '15d', premium: '45d', pro: '120d' },
  { key: 'm_storage', free: '—', premium: '250 MB', pro: '1 GB' },
  { key: 'm_upload', free: '5 MB', premium: '25 MB', pro: '100 MB' },
  { key: 'm_support', free: 'Normal', premium: 'Priority', pro: 'Priority+' }
];

const MODULES: ModulePill[] = [
  { key: 'mod_events' },
  { key: 'mod_clips' },
  { key: 'mod_redemptions', status: 'beta' },
  { key: 'mod_triggers', status: 'beta' },
  { key: 'mod_memories', status: 'beta' },
  { key: 'mod_summaries' },
  { key: 'mod_referrals' },
  { key: 'mod_overlays', status: 'alpha' },
  { key: 'mod_dimafx', status: 'beta' },
  { key: 'mod_ledger', tier: 'premium' },
  { key: 'mod_roulette', tier: 'pro', status: 'alpha' }
];

const DOCS = 'https://docs.domdimabot.com';

const COPY: Record<Lang, Record<string, string>> = {
  en: {
    nav_product: 'Product',
    nav_how: 'How it works',
    nav_pricing: 'Pricing',
    nav_docs: 'Docs',
    login: 'Log in',
    getStarted: 'Get started',
    themeLight: 'Switch to light mode',
    themeDark: 'Switch to dark mode',
    lang: 'Cambiar a español',
    heroLive: '{n} channels live with DomDimaBot',
    heroLiveOff: 'Live board connecting…',
    heroTitle: 'Run your Twitch channel',
    heroTitleAccent: 'from one control room.',
    heroCopy:
      'Moderation, commands, analytics, TTS and overlays in a single dashboard. Built for streamers who run their channel like a business.',
    heroPrimary: 'Get started free',
    heroSecondary: 'Compare plans',
    heroFine: 'Free plan · Sign in with Twitch · Premium from $6/mo',
    pvLabel: 'Dashboard preview',
    pvSample: 'Sample data',
    pvLive: 'Live',
    pvChatters: 'Chatters',
    pvMsgs: 'Msgs / min',
    pvCmds: 'Commands',
    pvActivity: 'Chat activity',
    pvLog: 'Automation log',
    pv1: 'Follow Defense switched to Silent: 42 follows in 5s',
    pv2: 'Link removed from @free_followers_xyz',
    pv3: '!discord answered 18 times this stream',
    pv4: 'TTS read a $10 cheer from LunaByte',
    now: 'now',
    proofKicker: 'Live board',
    proofTitle: 'Running on real channels, right now',
    st_messages: 'Chat messages processed',
    st_commands: 'Commands executed',
    st_live: 'Channels live now',
    st_viewers: 'Viewers on those streams',
    liveStrip: 'Live right now',
    viewers: '{n} viewers',
    liveEmpty: 'No channels live at the moment. The numbers above still update in real time.',
    productKicker: 'Product',
    productTitle: 'Everything your channel needs, in one place',
    productCopy: 'Turn on what you need from the dashboard. Every module shares the same settings, roles and analytics.',
    f_defense_k: 'Moderation',
    f_defense_t: 'Follow Defense and chat moderation',
    f_defense_c:
      'Detects follow-bot waves, suppresses fake alerts and escalates from Silent to Protection to Attack. Chat moderation scales from filters to context-aware AI.',
    f_defense_mode: 'Mode',
    f_defense_threshold: 'Threshold',
    f_cmd_k: 'Automation',
    f_cmd_t: 'Commands, timers and triggers',
    f_cmd_c: 'Unlimited custom commands with variables, cooldowns and timers on every plan.',
    f_an_k: 'Analytics',
    f_an_t: 'Know who shows up',
    f_an_c: 'Attendance, per-chatter activity and command usage, with up to 365 days of history.',
    f_tts_k: 'Voice & AI',
    f_tts_t: 'TTS and AI personality',
    f_tts_c: 'Every TTS provider on every plan, plus an AI personality that learns your chat.',
    guide: 'Read the guide',
    alsoIncluded: 'Also in the dashboard',
    allModules: 'All modules',
    mod_events: 'Chat Events',
    mod_clips: 'Clips',
    mod_redemptions: 'Redemptions',
    mod_triggers: 'Triggers',
    mod_memories: 'Memories',
    mod_summaries: 'Stream Summaries',
    mod_referrals: 'Referrals',
    mod_overlays: 'Overlay Studio',
    mod_dimafx: 'DimaFX extension',
    mod_ledger: 'Follow Ledger',
    mod_roulette: 'Roulette',
    beta: 'Beta',
    alpha: 'Alpha',
    premium: 'Premium',
    pro: 'Pro',
    howKicker: 'How it works',
    howTitle: 'Live on your channel in three steps',
    s1_t: 'Sign in with Twitch',
    s1_c: 'Your account starts on the Free plan. No card required.',
    s2_t: 'Authorize and join chat',
    s2_c: 'Approve the Twitch permissions and press Join Bot from your dashboard.',
    s3_t: 'Turn on modules',
    s3_c: 'Set up commands, moderation, TTS and overlays. Change anything mid-stream.',
    pricingKicker: 'Pricing',
    pricingTitle: 'Simple plans that scale with your channel',
    pricingCopy: 'Start free. Upgrade when your community needs more automation, history or AI.',
    perMonth: '/mo',
    plan_free: 'Free',
    plan_premium: 'Premium',
    plan_pro: 'Pro',
    desc_free: 'For streamers getting started with automation and moderation.',
    desc_premium: 'For growing communities that need smarter moderation and deeper data.',
    desc_pro: 'For established channels that need scale, retention and AI flexibility.',
    cta_free: 'Start free',
    cta_premium: 'Choose Premium',
    cta_pro: 'Choose Pro',
    popular: 'Most popular',
    b_cmds: 'Unlimited custom commands',
    b_tts: 'Every TTS provider',
    b_defense: 'Follow Defense',
    b_credits_free: '25k AI credits / month',
    b_analytics: 'Advanced analytics',
    b_smartmod: 'Smart chat moderation',
    b_tempvip: 'Temporary VIP and mod roles',
    b_credits_premium: '200k AI credits / month',
    b_aimod: 'AI chat moderation',
    b_retention: '365-day analytics history',
    b_cooldown: '1s minimum command cooldown',
    b_credits_pro: '800k AI credits / month',
    everythingIn: 'Everything in {plan}, plus:',
    compare: 'Compare all features',
    compareHide: 'Hide comparison',
    capability: 'Capability',
    m_moderation: 'Chat moderation',
    m_commands: 'Custom commands',
    m_analytics: 'Analytics',
    m_tempvip: 'Temporary VIP / Mod',
    m_variables: 'Variables',
    m_tts: 'TTS providers',
    m_personalities: 'AI personalities',
    m_credits: 'AI credits / month',
    m_cooldown: 'Min. command cooldown',
    m_retention: 'Analytics retention',
    m_memory: 'Chat memory retention',
    m_storage: 'Private storage',
    m_upload: 'Max upload size',
    m_support: 'Support',
    ctaTitle: 'Ready before your next stream.',
    ctaCopy: 'Setup takes a few minutes. Questions? Our team is on Discord.',
    ctaDiscord: 'Join Discord',
    footProduct: 'Product',
    footDocs: 'Documentation',
    footCommunity: 'Community',
    footGetting: 'Getting started',
    footCommands: 'Commands',
    footTts: 'TTS',
    footPlans: 'Plans',
    footLive: 'Live board',
    footRights: '© DomDimaBot. Not affiliated with Twitch.'
  },
  es: {
    nav_product: 'Producto',
    nav_how: 'Cómo funciona',
    nav_pricing: 'Precios',
    nav_docs: 'Docs',
    login: 'Iniciar sesión',
    getStarted: 'Empezar',
    themeLight: 'Cambiar a modo claro',
    themeDark: 'Cambiar a modo oscuro',
    lang: 'Switch to English',
    heroLive: '{n} canales en vivo con DomDimaBot',
    heroLiveOff: 'Conectando el tablero en vivo…',
    heroTitle: 'Gestiona tu canal de Twitch',
    heroTitleAccent: 'desde un solo panel.',
    heroCopy:
      'Moderación, comandos, analíticas, TTS y overlays en un solo dashboard. Hecho para streamers que gestionan su canal como un negocio.',
    heroPrimary: 'Empieza gratis',
    heroSecondary: 'Comparar planes',
    heroFine: 'Plan gratuito · Inicia con Twitch · Premium desde $6/mes',
    pvLabel: 'Vista del dashboard',
    pvSample: 'Datos de ejemplo',
    pvLive: 'En vivo',
    pvChatters: 'Chatters',
    pvMsgs: 'Msgs / min',
    pvCmds: 'Comandos',
    pvActivity: 'Actividad del chat',
    pvLog: 'Registro de automatización',
    pv1: 'Follow Defense pasó a Silencioso: 42 follows en 5s',
    pv2: 'Enlace eliminado de @free_followers_xyz',
    pv3: '!discord respondido 18 veces este stream',
    pv4: 'TTS leyó un cheer de $10 de LunaByte',
    now: 'ahora',
    proofKicker: 'Tablero en vivo',
    proofTitle: 'Funcionando en canales reales, ahora mismo',
    st_messages: 'Mensajes de chat procesados',
    st_commands: 'Comandos ejecutados',
    st_live: 'Canales en vivo ahora',
    st_viewers: 'Espectadores en esos streams',
    liveStrip: 'En vivo ahora',
    viewers: '{n} espectadores',
    liveEmpty: 'No hay canales en vivo en este momento. Las cifras siguen actualizándose en tiempo real.',
    productKicker: 'Producto',
    productTitle: 'Todo lo que tu canal necesita, en un solo lugar',
    productCopy: 'Activa lo que necesites desde el dashboard. Todos los módulos comparten ajustes, roles y analíticas.',
    f_defense_k: 'Moderación',
    f_defense_t: 'Follow Defense y moderación de chat',
    f_defense_c:
      'Detecta oleadas de follow-bots, silencia alertas falsas y escala de Silencioso a Protección y Ataque. La moderación va de filtros a IA con contexto.',
    f_defense_mode: 'Modo',
    f_defense_threshold: 'Umbral',
    f_cmd_k: 'Automatización',
    f_cmd_t: 'Comandos, timers y triggers',
    f_cmd_c: 'Comandos personalizados ilimitados con variables, cooldowns y timers en todos los planes.',
    f_an_k: 'Analíticas',
    f_an_t: 'Conoce a quién te ve',
    f_an_c: 'Asistencia, actividad por chatter y uso de comandos, con hasta 365 días de historial.',
    f_tts_k: 'Voz e IA',
    f_tts_t: 'TTS y personalidad IA',
    f_tts_c: 'Todos los proveedores de TTS en todos los planes, y una personalidad IA que aprende de tu chat.',
    guide: 'Ver la guía',
    alsoIncluded: 'También en el dashboard',
    allModules: 'Todos los módulos',
    mod_events: 'Eventos de chat',
    mod_clips: 'Clips',
    mod_redemptions: 'Canjes',
    mod_triggers: 'Triggers',
    mod_memories: 'Memorias',
    mod_summaries: 'Resúmenes de stream',
    mod_referrals: 'Referidos',
    mod_overlays: 'Overlay Studio',
    mod_dimafx: 'Extensión DimaFX',
    mod_ledger: 'Follow Ledger',
    mod_roulette: 'Ruleta',
    beta: 'Beta',
    alpha: 'Alpha',
    premium: 'Premium',
    pro: 'Pro',
    howKicker: 'Cómo funciona',
    howTitle: 'En tu canal en tres pasos',
    s1_t: 'Inicia sesión con Twitch',
    s1_c: 'Tu cuenta empieza en el plan gratuito. Sin tarjeta.',
    s2_t: 'Autoriza y únete al chat',
    s2_c: 'Aprueba los permisos de Twitch y pulsa Join Bot en tu dashboard.',
    s3_t: 'Activa módulos',
    s3_c: 'Configura comandos, moderación, TTS y overlays. Cambia lo que sea en pleno stream.',
    pricingKicker: 'Precios',
    pricingTitle: 'Planes simples que crecen con tu canal',
    pricingCopy: 'Empieza gratis. Mejora cuando tu comunidad necesite más automatización, historial o IA.',
    perMonth: '/mes',
    plan_free: 'Gratis',
    plan_premium: 'Premium',
    plan_pro: 'Pro',
    desc_free: 'Para streamers que empiezan con automatización y moderación.',
    desc_premium: 'Para comunidades en crecimiento que necesitan mejor moderación y más datos.',
    desc_pro: 'Para canales establecidos que necesitan escala, historial y flexibilidad de IA.',
    cta_free: 'Empieza gratis',
    cta_premium: 'Elegir Premium',
    cta_pro: 'Elegir Pro',
    popular: 'Más popular',
    b_cmds: 'Comandos personalizados ilimitados',
    b_tts: 'Todos los proveedores de TTS',
    b_defense: 'Follow Defense',
    b_credits_free: '25k créditos IA / mes',
    b_analytics: 'Analíticas avanzadas',
    b_smartmod: 'Moderación inteligente',
    b_tempvip: 'Roles VIP y mod temporales',
    b_credits_premium: '200k créditos IA / mes',
    b_aimod: 'Moderación con IA',
    b_retention: 'Historial de analíticas de 365 días',
    b_cooldown: 'Cooldown mínimo de 1s',
    b_credits_pro: '800k créditos IA / mes',
    everythingIn: 'Todo lo de {plan}, más:',
    compare: 'Comparar todas las funciones',
    compareHide: 'Ocultar comparación',
    capability: 'Función',
    m_moderation: 'Moderación de chat',
    m_commands: 'Comandos personalizados',
    m_analytics: 'Analíticas',
    m_tempvip: 'VIP / Mod temporal',
    m_variables: 'Variables',
    m_tts: 'Proveedores TTS',
    m_personalities: 'Personalidades IA',
    m_credits: 'Créditos IA / mes',
    m_cooldown: 'Cooldown mínimo',
    m_retention: 'Retención de analíticas',
    m_memory: 'Retención de memoria',
    m_storage: 'Almacenamiento privado',
    m_upload: 'Tamaño máx. de subida',
    m_support: 'Soporte',
    ctaTitle: 'Listo antes de tu próximo stream.',
    ctaCopy: 'La configuración toma unos minutos. ¿Dudas? Estamos en Discord.',
    ctaDiscord: 'Unirse a Discord',
    footProduct: 'Producto',
    footDocs: 'Documentación',
    footCommunity: 'Comunidad',
    footGetting: 'Primeros pasos',
    footCommands: 'Comandos',
    footTts: 'TTS',
    footPlans: 'Planes',
    footLive: 'Tablero en vivo',
    footRights: '© DomDimaBot. Sin afiliación con Twitch.'
  }
};

const VALUES_ES: Record<string, string> = {
  Basic: 'Básica',
  Smart: 'Inteligente',
  AI: 'IA',
  Unlimited: 'Ilimitados',
  Advanced: 'Avanzadas',
  Normal: 'Normal',
  Priority: 'Prioritario',
  'Priority+': 'Prioritario+'
};

// Sample chat-activity series for the preview sparkline (0–100).
const ACTIVITY = [18, 22, 20, 31, 28, 35, 42, 38, 47, 55, 50, 62, 58, 71, 66, 74, 69, 82, 77, 88, 80, 72, 79, 86];
// Sample follow bursts for the Follow Defense visual; 42 crosses the silent threshold.
const FOLLOWS = [2, 3, 1, 4, 2, 3, 42, 38, 6, 3, 2, 4];
const ATTENDANCE = [46, 58, 52, 67, 61, 74, 70];

@Component({
  selector: 'app-landing-b2b-mock',
  imports: [RouterLink, LucideAngularModule, BrandLogoComponent, CountUpDirective],
  templateUrl: './landing-b2b-mock.component.html',
  styleUrl: './landing-b2b-mock.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingB2bMockComponent implements OnInit {
  private readonly language = inject(LanguageService);
  private readonly theme = inject(ThemeService);
  private readonly site = inject(SiteAnalyticsService);
  readonly discordUrl = inject(LinksService).getDiscordUrl();

  readonly icons = {
    Activity,
    ArrowRight,
    BarChart3,
    Check,
    Clapperboard,
    Gift,
    LayoutTemplate,
    MessageSquareText,
    Minus,
    Moon,
    ShieldCheck,
    Sparkles,
    Sun,
    Terminal,
    Users,
    Volume2
  };

  readonly plans = PLANS;
  readonly matrix = MATRIX;
  readonly modules = MODULES;
  readonly planKeys: PlanKey[] = ['free', 'premium', 'pro'];
  readonly docs = DOCS;

  readonly stats = this.site.siteStats;
  readonly liveChannels = this.site.liveChannels;
  readonly connection = this.site.connectionStatus;
  readonly stripChannels = computed(() => this.liveChannels().slice(0, 12));

  readonly showMatrix = signal(false);
  readonly matrixPlan = signal<PlanKey>('premium');

  readonly lang = computed<Lang>(() => (this.language.currentLanguage() === 'es' ? 'es' : 'en'));
  readonly isDark = computed(() => this.theme.isDarkMode());
  readonly docsBase = computed(() => (this.lang() === 'es' ? `${DOCS}/es` : DOCS));

  readonly sparkPath = this.buildSpark(ACTIVITY, 320, 72);
  readonly sparkArea = `${this.sparkPath} L320,72 L0,72 Z`;
  readonly follows = FOLLOWS.map((v) => Math.min(100, (v / 50) * 100));
  readonly attendance = ATTENDANCE;
  readonly wave = [34, 52, 70, 46, 80, 62, 38, 58, 76, 50, 66, 42, 72, 56];

  readonly fallbackAvatar = 'https://static-cdn.jtvnw.net/jtv_user_pictures/xarth/404_user_70x70.png';

  ngOnInit(): void {
    this.site.start();
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

  previousPlan(key: PlanKey): string {
    return key === 'premium' ? this.t('plan_free') : key === 'pro' ? this.t('plan_premium') : '';
  }

  cell(row: MatrixRow, plan: PlanKey): string {
    const value = row[plan];
    return this.lang() === 'es' ? (VALUES_ES[value] ?? value) : value;
  }

  formatViewers(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
  }

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  toggleTheme(): void {
    this.theme.setTheme(this.isDark() ? 'light' : 'dark');
  }

  toggleLanguage(): void {
    this.language.toggleLanguage();
  }

  private buildSpark(values: number[], width: number, height: number): string {
    const step = width / (values.length - 1);
    return values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (v / 100) * (height - 6)).toFixed(1)}`)
      .join(' ');
  }
}
