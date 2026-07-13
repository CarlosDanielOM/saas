import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, ArrowRight } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';

interface MockVariant {
  id: string;
  title: string;
  description: string;
  vibe: string;
}

@Component({
  selector: 'app-landing-mock-index',
  imports: [RouterLink, LucideAngularModule, CountUpDirective],
  templateUrl: './landing-mock-index.component.html',
  styleUrl: './landing-mock-index.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMockIndexComponent {
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly arrowIcon = ArrowRight;

  readonly variants: MockVariant[] = [
    {
      id: '1',
      title: 'Pure Minimal',
      description: 'Clean, spacious, Swiss-inspired. Maximum clarity and breathing room.',
      vibe: 'Minimal'
    },
    {
      id: '2',
      title: 'Gradient Pop',
      description: 'Bold gradients, energetic cards, and vibrant motion. High visual impact.',
      vibe: 'Vibrant'
    },
    {
      id: '3',
      title: 'Neon Console',
      description: 'Dark tech aesthetic with grid overlays and precise, terminal-like sections.',
      vibe: 'Tech'
    },
    // New streamer-focused redesigns
    {
      id: '4',
      title: 'Twitch Energy',
      description: 'Playful, high-energy chat vibes. Feels like your stream exploded with fun.',
      vibe: 'Energetic'
    },
    {
      id: '5',
      title: 'Squad Glow',
      description: 'Community-first. Big avatars, live hype, and growth-focused energy.',
      vibe: 'Community'
    },
    {
      id: '6',
      title: 'Stream Glow',
      description: 'Modern streamer aesthetic. Premium glows, bold presence, chat is the hero.',
      vibe: 'Streamer'
    },
    // Variations based on Twitch Energy (Mock 4)
    {
      id: '7',
      title: 'Neon Riot',
      description: 'Explosive chat energy with hot pink, electric cyan & lime. Maximum hype.',
      vibe: 'Riot'
    },
    {
      id: '8',
      title: 'Sunset Hype',
      description: 'Warm sunset tones + bold coral. Cozy but chaotic streamer energy.',
      vibe: 'Warm'
    },
    {
      id: '9',
      title: 'Cosmic Pulse',
      description: 'Deep space vibes with lime & hot pink pulses. Premium but fun.',
      vibe: 'Cosmic'
    },
    // Variations based on Neon Console (Mock 3)
    {
      id: '10',
      title: 'Grid Terminal',
      description: 'Electric green matrix console with clean tech grid. Streamer terminal vibe.',
      vibe: 'Grid'
    },
    {
      id: '11',
      title: 'Synth Console',
      description: 'Synthwave pink & cyan. Retro-futuristic terminal for your stream.',
      vibe: 'Synth'
    },
    {
      id: '12',
      title: 'Abyss Terminal',
      description: 'Deep teal and indigo void. Dark, immersive console for serious creators.',
      vibe: 'Void'
    },
    // Refined v3 lineage — clean product aesthetic, no gradients, less dev
    {
      id: '13',
      title: 'Refined Dark',
      description: 'Clean modern SaaS. Professional surfaces and calm typography.',
      vibe: 'Refined'
    },
    {
      id: '14',
      title: 'Quiet Control',
      description: 'Sophisticated and minimal. Excellent whitespace and focus.',
      vibe: 'Calm'
    },
    {
      id: '15',
      title: 'Operational Clarity',
      description: 'Dashboard-forward and operational. Metrics-first product feel.',
      vibe: 'Clear'
    },
    // New hero-focused SaaS number variations (based on 13)
    {
      id: '16',
      title: 'Platform Pulse',
      description: 'Big clean platform stats. Active bots, users, messages — global view.',
      vibe: 'Pulse'
    },
    {
      id: '17',
      title: 'Live Network',
      description: 'Emphasizes active channels and live viewers using real SaaS numbers.',
      vibe: 'Network'
    },
    {
      id: '18',
      title: 'Global Metrics',
      description: 'Command-center style with key platform KPIs. No per-channel info.',
      vibe: 'Metrics'
    },
    // New creative explorations
    {
      id: '19',
      title: 'Editorial Spread',
      description: 'High-contrast magazine layout. Bold serif, oversized type, dense hierarchy.',
      vibe: 'Editorial'
    },
    {
      id: '20',
      title: 'Aurora Stream',
      description: 'Soft mesh gradient hero. Calm pastels melt into a confident product story.',
      vibe: 'Aurora'
    },
    {
      id: '21',
      title: 'Brutalist Mesh',
      description: 'Dense, raw, monospace-driven. Borders, labels, and structure front and center.',
      vibe: 'Brutalist'
    },
    // Command-center variations (based on Mock 18 — Global Metrics)
    {
      id: '22',
      title: 'Signal Ticker',
      description: 'Financial / news ticker vibe. KPIs scroll as if they were market data.',
      vibe: 'Ticker'
    },
    {
      id: '23',
      title: 'Constellation',
      description: 'Network map of live channels and pulses. Platform activity as a starfield.',
      vibe: 'Constellation'
    },
    {
      id: '24',
      title: 'Mission Control',
      description: 'Big-screen ops center. Oversized KPIs, status rails, telemetry-style chrome.',
      vibe: 'Ops'
    },
    // Dashboard mocks — same design languages applied to a dashboard shell
    {
      id: 'dashboard-23',
      title: 'Dashboard · Constellation',
      description: 'Sidebar + KPI grid + star-chart + system telemetry. Same constellation DNA.',
      vibe: 'Dashboard'
    }
  ];
}
