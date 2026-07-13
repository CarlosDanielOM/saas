import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule,
  Activity,
  Check,
  ChevronRight,
  CornerDownLeft,
  MessageCircle,
  TerminalSquare,
  Tv,
  Users,
  Zap
} from 'lucide-angular';

import { CountUpDirective } from '../../../../shared/directives/count-up.directive';
import { LinksService } from '../../../../services/links.service';
import { LandingAnalyticsService } from '../../landing-analytics.service';

type PlanKey = 'free' | 'premium' | 'pro';

interface PricingTier {
  key: PlanKey;
  code: string;
  label: string;
  price: string;
  cycle: string;
  description: string;
  cta: string;
  flagged?: boolean;
}

interface CapabilityRow {
  label: string;
  values: Record<PlanKey, string>;
  note?: string;
}

@Component({
  selector: 'app-m3-mock-1',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './m3-mock-1.component.html',
  styleUrl: './m3-mock-1.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class M3Mock1Component {
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
  readonly terminalIcon = TerminalSquare;
  readonly chevronIcon = ChevronRight;
  readonly enterIcon = CornerDownLeft;

  readonly selectedPlan = signal<PlanKey>('premium');

  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return '[ok] uplink stable';
      case 'reconnecting':
        return '[..] reconnecting';
      default:
        return '[!!] uplink offline';
    }
  });

  readonly tiers: PricingTier[] = [
    {
      key: 'free',
      code: 'TIER.01',
      label: 'Free',
      price: '$0',
      cycle: '/mo',
      description: 'Spin up a session. Basic moderation, unlimited commands.',
      cta: 'session start'
    },
    {
      key: 'premium',
      code: 'TIER.02',
      label: 'Premium',
      price: '$6',
      cycle: '/mo',
      description: 'Smart moderation, advanced analytics, voice synthesis.',
      cta: 'choose premium',
      flagged: true
    },
    {
      key: 'pro',
      code: 'TIER.03',
      label: 'Pro',
      price: '$15',
      cycle: '/mo',
      description: 'Pro-grade AI tuning, voice cloning, and unlimited bandwidth.',
      cta: 'choose pro'
    }
  ];

  readonly capabilityRows: CapabilityRow[] = [
    { label: 'chat.moderation', values: { free: 'basic', premium: 'smart', pro: 'ai' } },
    { label: 'commands.count', values: { free: 'inf', premium: 'inf', pro: 'inf' } },
    {
      label: 'analytics.retention',
      values: { free: '30d', premium: '180d', pro: '365d' }
    },
    {
      label: 'tts.quality',
      values: { free: 'basic', premium: 'human', pro: 'clone' },
      note: 'human = neural; clone = voice cloning on Pro'
    },
    {
      label: 'ai.personalities',
      values: { free: '01', premium: '02', pro: '03' }
    },
    {
      label: 'ai.credits',
      values: { free: '25k', premium: '125k', pro: '500k' },
      note: 'credits are non-rollover'
    },
    {
      label: 'memory.learn',
      values: { free: 'off', premium: 'chat', pro: 'chat+stream' }
    },
    {
      label: 'support.level',
      values: { free: 'normal', premium: 'priority', pro: 'priority+' }
    }
  ];

  readonly features = [
    {
      idx: '01',
      tag: 'moderation',
      title: 'AI-Powered Moderation',
      copy: 'Scale from basic filtering to context-aware moderation for fast chats.',
      status: 'armed'
    },
    {
      idx: '02',
      tag: 'automation',
      title: 'Commands & Automation',
      copy: 'Unlimited commands, variables, and trigger flows for your channel.',
      status: 'armed'
    },
    {
      idx: '03',
      tag: 'analytics',
      title: 'Advanced Analytics',
      copy: 'Track users, command usage, and engagement trends with deeper retention.',
      status: 'armed'
    },
    {
      idx: '04',
      tag: 'voice',
      title: 'TTS & Voice Features',
      copy: 'From basic TTS to human-like voices and pro voice cloning.',
      status: 'armed'
    }
  ];

  readonly marqueeItems = computed(() => {
    const s = this.siteStats();
    return [
      `${s.registeredUsers.toLocaleString()} registered`,
      `${s.liveUsers.toLocaleString()} live users`,
      `${s.botActiveAccounts.toLocaleString()} bots active`,
      `${s.messagesReceived.toLocaleString()} messages`,
      `${s.totalCommands.toLocaleString()} commands`,
      `${s.totalLiveViewer.toLocaleString()} live viewers`
    ];
  });

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
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(n);
  }
}
