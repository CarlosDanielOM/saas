import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Activity,
  BarChart3,
  MessageCircle,
  Shield,
  Tv,
  Users,
  Volume2,
  Zap
} from 'lucide-angular';

import { CountUpDirective } from '../../../../../shared/directives/count-up.directive';
import { LinksService } from '../../../../../services/links.service';
import { LandingAnalyticsService } from '../../../landing-analytics.service';

@Component({
  selector: 'app-opencode-23b',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './opencode-23b.component.html',
  styleUrl: './opencode-23b.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Opencode23bComponent {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly links = inject(LinksService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly connectionStatus = this.analytics.connectionStatus;

  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;
  readonly usersIcon = Users;
  readonly tvIcon = Tv;
  readonly activityIcon = Activity;
  readonly messageIcon = MessageCircle;

  readonly nodes = [
    { x: 18, y: 28, size: 18, delay: 0, hub: true },
    { x: 38, y: 14, size: 8, delay: 0.4 },
    { x: 52, y: 32, size: 10, delay: 0.9 },
    { x: 70, y: 22, size: 7, delay: 1.2 },
    { x: 82, y: 42, size: 9, delay: 0.6 },
    { x: 62, y: 58, size: 8, delay: 1.5 },
    { x: 32, y: 62, size: 6, delay: 1.8 },
    { x: 88, y: 70, size: 7, delay: 0.2 },
    { x: 48, y: 78, size: 5, delay: 2.1 },
    { x: 12, y: 50, size: 5, delay: 1.7 }
  ];

  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return 'Live';
      case 'reconnecting':
        return 'Reconnecting';
      default:
        return 'Offline';
    }
  });

  readonly features = [
    {
      title: 'AI-Powered Moderation',
      copy: 'Scale from basic filtering to smart, context-aware moderation for fast chats.',
      icon: this.shieldIcon
    },
    {
      title: 'Commands & Automation',
      copy: 'Unlimited commands, variables, and advanced trigger flows for your channel.',
      icon: this.zapIcon
    },
    {
      title: 'Advanced Analytics',
      copy: 'Track user activity, command usage, and engagement with deeper retention.',
      icon: this.chartIcon
    },
    {
      title: 'TTS & Voice',
      copy: 'From basic TTS to human-like voices and pro-level voice capabilities.',
      icon: this.volumeIcon
    }
  ];

  readonly tiers = [
    {
      key: 'free',
      label: 'Free',
      price: '$0',
      desc: 'Perfect for streamers getting started with automation and moderation.',
      cta: 'Get Started',
      hot: false
    },
    {
      key: 'premium',
      label: 'Premium',
      price: '$6',
      desc: 'Best for growing communities that need smarter moderation and deeper controls.',
      cta: 'Choose Premium',
      hot: true
    },
    {
      key: 'pro',
      label: 'Pro',
      price: '$15',
      desc: 'Built for serious creators with higher scale, quality, and AI flexibility.',
      cta: 'Choose Pro',
      hot: false
    }
  ];

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
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(n);
  }
}
