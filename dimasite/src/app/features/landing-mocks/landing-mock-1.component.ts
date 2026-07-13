import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Check, ArrowRight } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService, LiveChannelBoardEntry } from './landing-analytics.service';

@Component({
  selector: 'app-landing-mock-1',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-1.component.html',
  styleUrl: './landing-mock-1.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'onScroll()'
  }
})
export class LandingMock1Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly connectionStatus = this.analytics.connectionStatus;

  readonly checkIcon = Check;
  readonly arrowIcon = ArrowRight;

  onLogin(): void {
    void this.router.navigate(['/login']);
  }

  onDiscord(): void {
    window.open('https://discord.gg/', '_blank');
  }

  onScroll(): void {
    const navbar = document.querySelector('.mock1-navbar');
    if (navbar) {
      navbar.classList.toggle('scrolled', window.scrollY > 20);
    }
  }

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
