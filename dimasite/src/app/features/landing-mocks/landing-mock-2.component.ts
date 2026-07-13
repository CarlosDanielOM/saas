import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Zap, Users, BarChart3, Mic2, ArrowRight, Check } from 'lucide-angular';

import { LandingAnalyticsService, LiveChannelBoardEntry } from './landing-analytics.service';
import { CountUpDirective } from '../../shared/directives/count-up.directive';

@Component({
  selector: 'app-landing-mock-2',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-2.component.html',
  styleUrl: './landing-mock-2.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock2Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;

  readonly zapIcon = Zap;
  readonly usersIcon = Users;
  readonly chartIcon = BarChart3;
  readonly micIcon = Mic2;
  readonly arrowIcon = ArrowRight;
  readonly checkIcon = Check;

  readonly activePlan = signal<'free' | 'premium' | 'pro'>('premium');

  onLogin(): void {
    void this.router.navigate(['/login']);
  }

  onDiscord(): void {
    window.open('https://discord.gg/', '_blank');
  }

  setPlan(plan: 'free' | 'premium' | 'pro'): void {
    this.activePlan.set(plan);
  }

  scrollToSection(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }
}
