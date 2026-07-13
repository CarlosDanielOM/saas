import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, MessageCircle, Heart, Zap, Users, Star, ArrowRight } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';

@Component({
  selector: 'app-landing-mock-4',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-4.component.html',
  styleUrl: './landing-mock-4.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock4Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly chatIcon = MessageCircle;
  readonly heartIcon = Heart;
  readonly zapIcon = Zap;
  readonly usersIcon = Users;
  readonly starIcon = Star;
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
