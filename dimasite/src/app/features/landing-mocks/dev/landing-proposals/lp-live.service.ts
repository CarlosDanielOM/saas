import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { CheckoutIntentService } from '../../../../services/checkout-intent.service';
import { SessionAuthService } from '../../../../services/session-auth.service';
import { LiveChannelBoardEntry, SiteAnalyticsService } from '../../../../services/site-analytics.service';
import { MODULE_TIER_REQUIREMENTS, ModuleId } from '../../../modules/module-tier.model';

export type PlanKey = 'free' | 'premium' | 'pro';

export const PLAN_PRICE: Record<PlanKey, number> = { free: 0, premium: 6, pro: 15 };
export const PLAN_CREDITS: Record<PlanKey, number> = { free: 25000, premium: 200000, pro: 800000 };

/** Demo channels so the "someone is live" layout can be reviewed at any time. */
const DEMO_CHANNELS: LiveChannelBoardEntry[] = [
  { channelID: 'd1', channel: 'NovaPlays', viewers: 1840, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'pro' },
  { channelID: 'd2', channel: 'lunatica_v', viewers: 412, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'premium' },
  { channelID: 'd3', channel: 'TacoTactics', viewers: 96, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'free' },
  { channelID: 'd4', channel: 'pixel_pancho', viewers: 31, profileImageUrl: '', botPlatforms: ['twitch'], planTier: 'free' }
];

export interface ModuleRow {
  id: ModuleId;
  plan: PlanKey;
  status: string;
  category: 'engagement' | 'automation' | 'content';
  priority: number;
}

/** Every module and its minimum plan, straight from the real module catalog. */
export const MODULES: ModuleRow[] = Object.values(MODULE_TIER_REQUIREMENTS)
  .map((m) => ({ id: m.id, plan: m.minTier, status: m.defaultStatus, category: m.category, priority: m.priority }))
  .sort((a, b) => a.priority - b.priority);

export const FREE_MODULES = MODULES.filter((m) => m.plan === 'free').length;
export const PAID_MODULES = MODULES.filter((m) => m.plan !== 'free');

/** Real live board + login actions shared by the three proposals. */
@Injectable({ providedIn: 'root' })
export class LpLive {
  private readonly site = inject(SiteAnalyticsService);
  private readonly session = inject(SessionAuthService);
  private readonly checkout = inject(CheckoutIntentService);
  private readonly router = inject(Router);

  readonly simulate = signal(false);
  readonly stats = this.site.siteStats;
  readonly channels = computed(() => (this.simulate() ? DEMO_CHANNELS : this.site.liveChannels()));
  readonly viewers = computed(() => this.channels().reduce((sum, c) => sum + (Number(c.viewers) || 0), 0));

  connect(): void {
    this.site.start();
  }

  /** Same flow as the production landing (without its analytics events). */
  start(plan: PlanKey = 'free'): void {
    if (plan === 'free') this.checkout.clearPendingPlan();
    else this.checkout.setPendingPlan(plan);
    if (this.session.hasValidSession()) {
      void this.router.navigate(['/login']);
      return;
    }
    this.session.startTwitchLogin();
  }
}
