import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Shield, Zap, BarChart3, Volume2, Sparkles, Sun, Moon } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-landing-mock-20',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-20.component.html',
  styleUrl: './landing-mock-20.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock20Component {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly themeService = inject(ThemeService);

  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly theme = this.themeService.theme;
  readonly isDarkMode = this.themeService.isDarkMode;

  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;
  readonly sparklesIcon = Sparkles;
  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

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
