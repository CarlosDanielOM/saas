import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Shield, Zap, BarChart3, Volume2, TrendingUp, TrendingDown } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';

@Component({
  selector: 'app-landing-mock-22',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-22.component.html',
  styleUrl: './landing-mock-22.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock22Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;
  readonly upIcon = TrendingUp;
  readonly downIcon = TrendingDown;

  // Synthetic "previous close" so we can show a delta. Real product has nothing to
  // anchor to, so this is just a stable visual gimmick that always looks live.
  readonly deltas = {
    bots: 8.4,
    viewers: 12.7,
    creators: 4.2,
    messages: 18.9,
    commands: 6.1
  } as const;

  readonly deltasUp = computed(() => true);

  onLogin(): void {
    void this.router.navigate(['/login']);
  }

  onDiscord(): void {
    window.open('https://discord.gg/', '_blank');
  }

  scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }
}
