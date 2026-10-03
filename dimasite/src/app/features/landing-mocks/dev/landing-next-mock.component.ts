import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { LandingPageComponent } from '../../landing/landing-page.component';
import { BrandLogoComponent } from '../../../shared/brand-logo/brand-logo.component';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import type { LiveChannelBoardEntry } from '../../../services/site-analytics.service';
import { LanguageService } from '../../../services/language.service';

type PlanKey = 'free' | 'premium' | 'pro';

interface FeatureCard {
  key: string;
  chip: string;
  path: string;
}

/** Docs pages that exist in dimadocs (en + es). */
const FEATURES: readonly FeatureCard[] = [
  { key: 'moderation', chip: 'AI', path: '/moderation/' },
  { key: 'commands', chip: 'AUTO', path: '/commands/' },
  { key: 'tts', chip: 'VOICE', path: '/tts/' },
  { key: 'triggers', chip: 'OBS', path: '/triggers/' },
  { key: 'defense', chip: 'SAFE', path: '/follow-defense/' },
  { key: 'personality', chip: 'AI', path: '/ai-personality/' },
  { key: 'clips', chip: 'AI', path: '/clip-recommendations/' },
  { key: 'analytics', chip: 'DATA', path: '/analytics/' }
];

const AI_CREDITS: Record<PlanKey, number> = { free: 25000, premium: 200000, pro: 800000 };
const PRICE: Record<PlanKey, number> = { free: 0, premium: 6, pro: 15 };

/** Demo channels so the "someone is live" layout can be reviewed at any time. */
const DEMO_CHANNELS: LiveChannelBoardEntry[] = [
  { channelID: 'd1', channel: 'NovaPlays', viewers: 1840, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'pro' },
  { channelID: 'd2', channel: 'lunatica_v', viewers: 412, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'premium' },
  { channelID: 'd3', channel: 'TacoTactics', viewers: 96, profileImageUrl: '', botPlatforms: ['twitch', 'kick'], planTier: 'free' },
  { channelID: 'd4', channel: 'pixel_pancho', viewers: 31, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'free' }
] as LiveChannelBoardEntry[];

/**
 * Landing proposal: same page, data and actions as production (it extends the
 * production component), with an honest empty live tile, a chat demo, more
 * features, a three-step start and value cues computed from the plans.
 */
@Component({
  selector: 'app-landing-next-mock',
  imports: [LucideAngularModule, CountUpDirective, BrandLogoComponent],
  templateUrl: './landing-next-mock.component.html',
  styleUrls: ['../../landing/landing-page.component.css', './landing-next-mock.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:scroll)': 'onWindowScroll()' }
})
export class LandingNextMockComponent extends LandingPageComponent {
  private readonly lang = inject(LanguageService);
  readonly simulate = signal<'real' | 'live'>('real');

  readonly channels = computed(() => (this.simulate() === 'live' ? DEMO_CHANNELS : this.liveChannels()));
  readonly featured = computed(() => this.channels()[0] ?? null);
  readonly others = computed(() => this.channels().slice(1, 5));
  readonly liveViewers = computed(() => this.channels().reduce((sum, c) => sum + (Number(c.viewers) || 0), 0));

  readonly features = computed(() => {
    const prefix = this.currentLang() === 'es' ? '/es' : '';
    return FEATURES.map((f) => ({ ...f, href: `https://docs.domdimabot.com${prefix}${f.path}` }));
  });

  readonly planKeys: PlanKey[] = ['free', 'premium', 'pro'];

  /** Honest, computed value cue per plan instead of a "most popular" badge. */
  planCue(plan: PlanKey): string {
    if (plan === 'free') return this.t('devMocks.landingNext.plans.cueFree');
    const times = Math.round(AI_CREDITS[plan] / AI_CREDITS.free);
    const perDollar = Math.round(AI_CREDITS[plan] / PRICE[plan] / 1000);
    return this.tp('devMocks.landingNext.plans.cuePaid', { times, perDollar });
  }

  bestValue(plan: PlanKey): boolean {
    return plan === 'pro';
  }

  credits(plan: PlanKey): string {
    return AI_CREDITS[plan].toLocaleString(this.currentLang() === 'es' ? 'es' : 'en');
  }

  price(plan: PlanKey): string {
    return `$${PRICE[plan]}`;
  }

  tp(key: string, params: Record<string, string | number>): string {
    return this.lang.translate(key, params);
  }

  initial(name: string): string {
    return (name || '?').charAt(0).toUpperCase();
  }

  private currentLang(): string {
    return this.lang.currentLanguage();
  }
}
