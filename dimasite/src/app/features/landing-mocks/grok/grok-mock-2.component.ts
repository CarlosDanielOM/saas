import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Activity,
  Check,
  MessageCircle,
  Tv,
  Users,
  Zap
} from 'lucide-angular';

import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import { LinksService } from '../../../services/links.service';
import { LandingAnalyticsService } from '../landing-analytics.service';

type PlanKey = 'free' | 'premium' | 'pro';

@Component({
  selector: 'app-grok-mock-2',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './grok-mock-2.component.html',
  styleUrl: './grok-mock-2.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GrokMock2Component {
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

  readonly activeTier = signal<PlanKey>('premium');
  readonly showAllRows = signal(false);

  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return 'SIGNAL LOCKED';
      case 'reconnecting':
        return 'RESYNC…';
      default:
        return 'NO SIGNAL';
    }
  });

  readonly tiers = [
    {
      key: 'free' as const,
      label: 'Free',
      price: '$0',
      blurb: 'Start with automation and basic moderation.',
      cta: 'Get Started'
    },
    {
      key: 'premium' as const,
      label: 'Premium',
      price: '$6',
      blurb: 'Smarter moderation and deeper controls for growing chats.',
      cta: 'Choose Premium'
    },
    {
      key: 'pro' as const,
      label: 'Pro',
      price: '$15',
      blurb: 'Higher scale, quality, and AI flexibility for serious creators.',
      cta: 'Choose Pro'
    }
  ];

  readonly featureRows = [
    {
      num: '01',
      title: 'AI-Powered Moderation',
      copy: 'Scale from basic filtering to smart, context-aware moderation for fast chats.',
      tag: 'AI'
    },
    {
      num: '02',
      title: 'Commands & Automation',
      copy: 'Run unlimited commands, variables, and advanced trigger flows for your channel.',
      tag: 'Automation'
    },
    {
      num: '03',
      title: 'Advanced Analytics',
      copy: 'Track user activity, command usage, and engagement trends with deeper retention.',
      tag: 'Insights'
    },
    {
      num: '04',
      title: 'TTS & Voice Features',
      copy: 'From basic TTS to premium human-like voices and pro-level voice capabilities.',
      tag: 'Voice'
    }
  ];

  readonly matrixRows = [
    { label: 'Chat moderation', free: 'Basic', premium: 'Smart', pro: 'AI' },
    { label: 'Support', free: 'Normal', premium: 'Priority', pro: 'Priority+' },
    { label: 'Custom commands', free: 'Unlimited', premium: 'Unlimited', pro: 'Unlimited' },
    { label: 'Analytics', free: 'Basic', premium: 'Advanced', pro: 'Advanced' },
    { label: 'TTS', free: 'Basic', premium: 'Human-like', pro: 'Voice cloning' },
    { label: 'AI personalities', free: '1', premium: '2', pro: '3' },
    { label: 'AI credits / month', free: '25,000', premium: '125,000', pro: '500,000' },
    { label: 'Stream analytics retention', free: '30d', premium: '180d', pro: '365d' },
    { label: 'Chat memory retention', free: '15d', premium: '45d', pro: '120d' },
    { label: 'Max upload size', free: '5MB', premium: '25MB', pro: '100MB' }
  ];

  readonly visibleRows = computed(() =>
    this.showAllRows() ? this.matrixRows : this.matrixRows.slice(0, 5)
  );

  setTier(key: PlanKey): void {
    this.activeTier.set(key);
  }

  toggleRows(): void {
    this.showAllRows.update((v) => !v);
  }

  cell(row: { free: string; premium: string; pro: string }, key: PlanKey): string {
    return row[key];
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
