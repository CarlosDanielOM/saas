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
  ArrowRight,
  Check,
  ChevronRight,
  MessageCircle,
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
  tagline: string;
  description: string;
  cta: string;
  flagged?: boolean;
}

interface CapabilityRow {
  label: string;
  values: Record<PlanKey, string>;
  footnote?: string;
}

@Component({
  selector: 'app-m3-mock-2',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './m3-mock-2.component.html',
  styleUrl: './m3-mock-2.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class M3Mock2Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly links = inject(LinksService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly usersIcon = Users;
  readonly tvIcon = Tv;
  readonly zapIcon = Zap;
  readonly messageIcon = MessageCircle;
  readonly checkIcon = Check;
  readonly arrowIcon = ArrowRight;
  readonly chevronIcon = ChevronRight;

  readonly selectedPlan = signal<PlanKey>('premium');

  readonly tiers: PricingTier[] = [
    {
      key: 'free',
      label: 'Comp',
      price: 'Free',
      cycle: 'forever',
      tagline: 'A starting issue',
      description:
        'For new streamers. Basic moderation, unlimited commands, and a working newsroom from day one.',
      cta: 'Begin'
    },
    {
      key: 'premium',
      label: 'Subscriber',
      price: '$6',
      cycle: '/ month',
      tagline: 'The standard rate',
      description:
        'For growing channels. Smart moderation, advanced analytics, and neural text-to-speech.',
      cta: 'Subscribe',
      flagged: true
    },
    {
      key: 'pro',
      label: 'Patron',
      price: '$15',
      cycle: '/ month',
      tagline: 'The deep print run',
      description:
        'For serious creators. Voice cloning, unlimited bandwidth, and AI tuned on your stream.',
      cta: 'Become a patron'
    }
  ];

  readonly capabilityRows: CapabilityRow[] = [
    { label: 'Chat moderation', values: { free: 'Basic', premium: 'Smart', pro: 'AI' } },
    { label: 'Custom commands', values: { free: 'Unlimited', premium: 'Unlimited', pro: 'Unlimited' } },
    {
      label: 'Analytics retention',
      values: { free: '30 days', premium: '180 days', pro: '365 days' }
    },
    {
      label: 'Text-to-speech',
      values: { free: 'Basic', premium: 'Neural', pro: 'Voice cloning' }
    },
    {
      label: 'AI personalities',
      values: { free: 'One', premium: 'Two', pro: 'Three' }
    },
    {
      label: 'AI credits',
      values: { free: '25,000', premium: '125,000', pro: '500,000' },
      footnote: 'Credits do not roll over month to month.'
    },
    {
      label: 'Memory from chat',
      values: { free: '—', premium: 'From chat', pro: 'Chat + summaries' }
    },
    {
      label: 'Support',
      values: { free: 'Standard', premium: 'Priority', pro: 'Priority plus' }
    }
  ];

  readonly features = [
    {
      chapter: 'I',
      kicker: 'On Moderation',
      title: 'A measured hand on the chat.',
      copy: 'Filtering at scale, then smart, then aware. Three readings of the same conversation — pick the one your stream needs.',
      pull: '"It learns the rhythm of your room before it ever steps in."'
    },
    {
      chapter: 'II',
      kicker: 'On Automation',
      title: 'A command for every occasion.',
      copy: 'Variables, triggers, and the kind of flow that makes a regular viewer feel like a regular at your bar.',
      pull: '"It runs the room so you can run the show."'
    },
    {
      chapter: 'III',
      kicker: 'On Insight',
      title: 'The figures, plainly told.',
      copy: 'Engagement, command usage, and attendance trends — the kind of numbers worth reading in full.',
      pull: '"The dashboard reads like a Sunday paper."'
    },
    {
      chapter: 'IV',
      kicker: 'On Voice',
      title: 'Speech, in your channel\u2019s voice.',
      copy: 'From standard synthesis to neural voices to a clone of the voice you already use. Hear your bot before you hear it read.',
      pull: '"For the first time, the bot sounds like it belongs."'
    }
  ];

  readonly leadStats = computed(() => {
    const s = this.siteStats();
    return [
      { label: 'Streamers', value: s.registeredUsers, footnote: 'on the platform' },
      { label: 'Live now', value: s.liveUsers, footnote: 'across Twitch and Kick' },
      { label: 'Bots active', value: s.botActiveAccounts, footnote: 'this minute' },
      { label: 'Messages', value: s.messagesReceived, footnote: 'and counting' }
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
