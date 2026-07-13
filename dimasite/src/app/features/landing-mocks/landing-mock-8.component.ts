import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Sun, Heart, Zap, Users, ArrowRight } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';

@Component({
  selector: 'app-landing-mock-8',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-8.component.html',
  styleUrl: './landing-mock-8.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock8Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly sunIcon = Sun;
  readonly heartIcon = Heart;
  readonly zapIcon = Zap;
  readonly usersIcon = Users;
  readonly arrowIcon = ArrowRight;

  onLogin(): void {
    void this.router.navigate(['/login']);
  }

  onDiscord(): void {
    window.open('https://discord.gg/', '_blank');
  }

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }
}
