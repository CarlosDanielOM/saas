import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Shield, Zap, BarChart3, Volume2, Square, Hash } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';

@Component({
  selector: 'app-landing-mock-21',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-21.component.html',
  styleUrl: './landing-mock-21.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock21Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;
  readonly squareIcon = Square;
  readonly hashIcon = Hash;

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
