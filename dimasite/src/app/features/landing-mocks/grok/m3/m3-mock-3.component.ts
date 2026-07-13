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
  Disc3,
  Headphones,
  MessageCircle,
  Play,
  Radio,
  Sparkles,
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
  label: string;
  price: string;
  cycle: string;
  track: string;
  description: string;
  cta: string;
  flagged?: boolean;
}

interface FeatureTrack {
  duration: string;
  number: string;
  title: string;
  artist: string;
  copy: string;
  tag: string;
}

@Component({
  selector: 'app-m3-mock-3',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './m3-mock-3.component.html',
  styleUrl: './m3-mock-3.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class M3Mock3Component {
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
  readonly discIcon = Disc3;
  readonly headphonesIcon = Headphones;
  readonly playIcon = Play;
  readonly radioIcon = Radio;
  readonly sparklesIcon = Sparkles;

  readonly selectedPlan = signal<PlanKey>('premium');

  readonly connectionLabel = computed(() => {
    switch (this.connectionStatus()) {
      case 'connected':
        return 'Streaming · live feed';
      case 'reconnecting':
        return 'Reconnecting…';
      default:
        return 'Cached · last sync';
    }
  });

  readonly nowPlaying = computed(() => {
    const s = this.siteStats();
    const total = s.botActiveAccounts || 1;
    return {
      channel: 'domdimabot.session',
      track: 'twitch.chat · live broadcast',
      artist: `${total.toLocaleString()} channels & counting`,
      listeners: s.totalLiveViewer,
      duration: `${Math.floor((s.messagesReceived || 0) / 1000)}:${String((s.messagesReceived || 0) % 1000).padStart(3, '0').slice(0, 2)}`,
      explicit: false
    };
  });

  readonly featureTracks: FeatureTrack[] = [
    {
      duration: '04:12',
      number: '01',
      title: 'AI Moderation',
      artist: 'Context-aware filtering for fast chats.',
      copy: 'From basic filters to a moderation that reads the room. Three modes, one engine.',
      tag: 'Moderation'
    },
    {
      duration: '03:48',
      number: '02',
      title: 'Commands & Automation',
      artist: 'Unlimited commands. Real variables.',
      copy: 'Build the loops your stream runs on — every !command, every reaction, every trigger.',
      tag: 'Automation'
    },
    {
      duration: '06:21',
      number: '03',
      title: 'Advanced Analytics',
      artist: 'Retention up to 365 days.',
      copy: 'Engagement, command usage, attendance. The kind of charts worth reading twice.',
      tag: 'Insights'
    },
    {
      duration: '05:04',
      number: '04',
      title: 'TTS & Voice',
      artist: 'Neural voices. Voice cloning on Pro.',
      copy: 'From basic synthesis to a bot that sounds like your channel already does.',
      tag: 'Voice'
    }
  ];

  readonly tiers: PricingTier[] = [
    {
      key: 'free',
      label: 'Free',
      price: '$0',
      cycle: '/mo',
      track: 'Side A',
      description: 'Start the session. Basic moderation, unlimited commands.',
      cta: 'Play Free'
    },
    {
      key: 'premium',
      label: 'Premium',
      price: '$6',
      cycle: '/mo',
      track: 'Side B · recommended',
      description: 'Smart moderation, advanced analytics, neural TTS.',
      cta: 'Play Premium',
      flagged: true
    },
    {
      key: 'pro',
      label: 'Pro',
      price: '$15',
      cycle: '/mo',
      track: 'Side C',
      description: 'Voice cloning, unlimited bandwidth, AI tuned on your stream.',
      cta: 'Play Pro'
    }
  ];

  readonly capabilityRows = [
    { label: 'Chat moderation', values: { free: 'Basic', premium: 'Smart', pro: 'AI' } },
    { label: 'Custom commands', values: { free: 'Unlimited', premium: 'Unlimited', pro: 'Unlimited' } },
    { label: 'TTS', values: { free: 'Basic', premium: 'Neural', pro: 'Clone' } },
    { label: 'AI personalities', values: { free: '1', premium: '2', pro: '3' } },
    { label: 'AI credits / mo', values: { free: '25k', premium: '125k', pro: '500k' } },
    { label: 'Memory', values: { free: 'Off', premium: 'From chat', pro: 'Chat + summaries' } },
    { label: 'Retention', values: { free: '30d', premium: '180d', pro: '365d' } },
    { label: 'Support', values: { free: 'Standard', premium: 'Priority', pro: 'Priority +' } }
  ];

  readonly leadStats = computed(() => {
    const s = this.siteStats();
    return [
      { label: 'Streamers', value: s.registeredUsers },
      { label: 'Live now', value: s.liveUsers },
      { label: 'Bots active', value: s.botActiveAccounts },
      { label: 'Listeners', value: s.totalLiveViewer }
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
