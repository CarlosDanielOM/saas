import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Activity,
  Check,
  MessageCircle,
  Sparkles,
  Tv,
  Users,
  Zap
} from 'lucide-angular';

import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import { LinksService } from '../../../services/links.service';
import { LandingAnalyticsService } from '../landing-analytics.service';

type PlanKey = 'free' | 'premium' | 'pro';

@Component({
  selector: 'app-grok-mock-3',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './grok-mock-3.component.html',
  styleUrl: './grok-mock-3.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GrokMock3Component {
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
  readonly checkIcon = Check;
  readonly sparklesIcon = Sparkles;

  readonly openPlan = signal<PlanKey>('premium');

  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return 'Connected';
      case 'reconnecting':
        return 'Reconnecting';
      default:
        return 'Offline';
    }
  });

  readonly stats = [
    { key: 'registeredUsers' as const, label: 'Registered users', icon: 'users' as const },
    { key: 'liveUsers' as const, label: 'Live users', icon: 'tv' as const },
    { key: 'botActiveAccounts' as const, label: 'Bots active', icon: 'activity' as const },
    { key: 'messagesReceived' as const, label: 'Messages', icon: 'message' as const },
    { key: 'totalCommands' as const, label: 'Commands', icon: 'zap' as const },
    { key: 'totalLiveViewer' as const, label: 'Live viewers', icon: 'tv' as const }
  ];

  readonly features = [
    {
      title: 'AI-Powered Moderation',
      copy: 'Scale from basic filtering to smart, context-aware moderation for fast chats.',
      tone: 'lilac' as const,
      icon: 'message' as const,
      badge: 'AI'
    },
    {
      title: 'Commands & Automation',
      copy: 'Run unlimited commands, variables, and advanced trigger flows for your channel.',
      tone: 'peach' as const,
      icon: 'zap' as const,
      badge: 'Automation'
    },
    {
      title: 'Advanced Analytics',
      copy: 'Track user activity, command usage, and engagement trends with deeper retention.',
      tone: 'mint' as const,
      icon: 'activity' as const,
      badge: 'Insights'
    },
    {
      title: 'TTS & Voice Features',
      copy: 'From basic TTS to premium human-like voices and pro-level voice capabilities.',
      tone: 'sky' as const,
      icon: 'tv' as const,
      badge: 'Voice'
    }
  ];

  readonly plans = [
    {
      key: 'free' as const,
      label: 'Free',
      price: '$0',
      description: 'Perfect for streamers getting started with automation and moderation.',
      cta: 'Get Started',
      highlights: [
        'Basic chat moderation',
        'Unlimited custom commands',
        'Basic analytics (30d)',
        '25,000 AI credits / mo',
        'Basic TTS'
      ]
    },
    {
      key: 'premium' as const,
      label: 'Premium',
      price: '$6',
      description: 'Best for growing communities that need smarter moderation and deeper controls.',
      cta: 'Choose Premium',
      highlights: [
        'Smart moderation',
        'Human-like TTS',
        '2 AI personalities',
        '125,000 AI credits / mo',
        'Advanced analytics (180d)'
      ]
    },
    {
      key: 'pro' as const,
      label: 'Pro',
      price: '$15',
      description: 'Built for serious creators with higher scale, quality, and AI flexibility.',
      cta: 'Choose Pro',
      highlights: [
        'AI moderation',
        'Voice cloning TTS',
        '3 AI personalities',
        '500,000 AI credits / mo',
        'Analytics retention 365d'
      ]
    }
  ];

  iconFor(name: 'users' | 'tv' | 'activity' | 'message' | 'zap') {
    switch (name) {
      case 'users':
        return this.usersIcon;
      case 'tv':
        return this.tvIcon;
      case 'activity':
        return this.activityIcon;
      case 'message':
        return this.messageIcon;
      case 'zap':
        return this.zapIcon;
    }
  }

  statValue(key: (typeof this.stats)[number]['key']): number {
    return this.siteStats()[key];
  }

  setPlan(key: PlanKey): void {
    this.openPlan.set(key);
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
}
