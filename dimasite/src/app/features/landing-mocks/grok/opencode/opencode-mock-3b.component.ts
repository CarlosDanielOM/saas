import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Activity,
  MessageCircle,
  Tv,
  Users,
  Zap
} from 'lucide-angular';

import { CountUpDirective } from '../../../../shared/directives/count-up.directive';
import { LinksService } from '../../../../services/links.service';
import { LandingAnalyticsService } from '../../landing-analytics.service';

type PlanKey = 'free' | 'premium' | 'pro';

@Component({
  selector: 'app-opencode-mock-3b',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './opencode-mock-3b.component.html',
  styleUrl: './opencode-mock-3b.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OpencodeMock3bComponent {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly links = inject(LinksService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly connectionStatus = this.analytics.connectionStatus;

  readonly usersIcon = Users;
  readonly tvIcon = Tv;
  readonly activityIcon = Activity;
  readonly messageIcon = MessageCircle;
  readonly zapIcon = Zap;

  readonly selectedPlan = signal<PlanKey>('premium');

  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return 'Live & synced';
      case 'reconnecting':
        return 'Catching up…';
      default:
        return 'Offline';
    }
  });

  readonly tiers = [
    {
      key: 'free' as const,
      label: 'Free',
      price: '$0',
      description: 'Perfect for streamers getting started with automation and moderation.',
      cta: 'Get Started'
    },
    {
      key: 'premium' as const,
      label: 'Premium',
      price: '$6',
      description: 'Best for growing communities that need smarter moderation and deeper controls.',
      cta: 'Choose Premium',
      highlighted: true
    },
    {
      key: 'pro' as const,
      label: 'Pro',
      price: '$15',
      description: 'Built for serious creators with higher scale, quality, and AI flexibility.',
      cta: 'Choose Pro'
    }
  ];

  readonly features = [
    {
      badge: 'AI',
      title: 'AI-Powered Moderation',
      copy: 'Scale from basic filtering to smart, context-aware moderation for fast chats.',
      icon: 'message' as const,
      tone: 'peach' as const
    },
    {
      badge: 'Automation',
      title: 'Commands & Automation',
      copy: 'Unlimited commands, variables, and advanced trigger flows for your channel.',
      icon: 'zap' as const,
      tone: 'mint' as const
    },
    {
      badge: 'Insights',
      title: 'Advanced Analytics',
      copy: 'Track user activity, command usage, and engagement with deeper retention.',
      icon: 'activity' as const,
      tone: 'lilac' as const
    },
    {
      badge: 'Voice',
      title: 'TTS & Voice',
      copy: 'From basic TTS to human-like voices and pro-level voice capabilities.',
      icon: 'tv' as const,
      tone: 'butter' as const
    }
  ];

  readonly capabilityRows = [
    { label: 'Chat moderation', free: 'Basic', premium: 'Smart', pro: 'AI' },
    { label: 'Custom commands', free: 'Unlimited', premium: 'Unlimited', pro: 'Unlimited' },
    { label: 'TTS', free: 'Basic', premium: 'Human-like', pro: 'Voice cloning' },
    { label: 'AI personalities', free: '1', premium: '2', pro: '3' },
    { label: 'AI credits / mo', free: '25k', premium: '125k', pro: '500k' },
    { label: 'Analytics retention', free: '30d', premium: '180d', pro: '365d' }
  ];

  iconFor(name: 'message' | 'zap' | 'activity' | 'tv') {
    switch (name) {
      case 'message':
        return this.messageIcon;
      case 'zap':
        return this.zapIcon;
      case 'activity':
        return this.activityIcon;
      case 'tv':
        return this.tvIcon;
    }
  }

  selectPlan(key: PlanKey): void {
    this.selectedPlan.set(key);
  }

  login(): void {
    void this.router.navigate(['/login']);
  }

  openDiscord(): void {
    window.open(this.links.getDiscordUrl(), '_blank', 'noopener,noreferrer');
  }

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  formatViewers(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  }
}
