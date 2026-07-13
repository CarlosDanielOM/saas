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
  selector: 'app-opencode-mock-3a',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './opencode-mock-3a.component.html',
  styleUrl: './opencode-mock-3a.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OpencodeMock3aComponent {
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
        return 'Feed online';
      case 'reconnecting':
        return 'Reconnecting';
      default:
        return 'Feed offline';
    }
  });

  readonly metrics = computed(() => {
    const s = this.siteStats();
    return [
      { label: 'Registered', value: s.registeredUsers, icon: this.usersIcon },
      { label: 'Live users', value: s.liveUsers, icon: this.tvIcon },
      { label: 'Bots active', value: s.botActiveAccounts, icon: this.activityIcon },
      { label: 'Messages', value: s.messagesReceived, icon: this.messageIcon },
      { label: 'Commands', value: s.totalCommands, icon: this.zapIcon },
      { label: 'Viewers', value: s.totalLiveViewer, icon: this.tvIcon }
    ];
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
      copy: 'Scale from basic filtering to smart, context-aware moderation for fast chats.'
    },
    {
      badge: 'AUTO',
      title: 'Commands & Automation',
      copy: 'Unlimited commands, variables, and advanced trigger flows for your channel.'
    },
    {
      badge: 'DATA',
      title: 'Advanced Analytics',
      copy: 'Track user activity, command usage, and engagement with deeper retention.'
    },
    {
      badge: 'VOICE',
      title: 'TTS & Voice',
      copy: 'From basic TTS to human-like voices and pro-level voice capabilities.'
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
