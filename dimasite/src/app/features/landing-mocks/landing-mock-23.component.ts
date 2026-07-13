import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Shield, Zap, BarChart3, Volume2, Sun, Moon } from 'lucide-angular';

import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from './landing-analytics.service';
import { ThemeService } from '../../services/theme.service';

interface ConstellationNode {
  x: number;
  y: number;
  size: number;
  delay: number;
  label?: string;
  highlight?: boolean;
}

@Component({
  selector: 'app-landing-mock-23',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './landing-mock-23.component.html',
  styleUrl: './landing-mock-23.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingMock23Component {
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
  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  // A pre-drawn network of pulsing nodes. The "hub" sits left; live channels
  // (real data) become highlighted nodes.
  readonly nodes: ConstellationNode[] = [
    { x: 18, y: 28, size: 22, delay: 0, highlight: true },
    { x: 38, y: 14, size: 8, delay: 0.4 },
    { x: 52, y: 32, size: 10, delay: 0.9 },
    { x: 70, y: 22, size: 7, delay: 1.2 },
    { x: 82, y: 42, size: 9, delay: 0.6 },
    { x: 62, y: 58, size: 8, delay: 1.5 },
    { x: 32, y: 62, size: 6, delay: 1.8 },
    { x: 88, y: 70, size: 7, delay: 0.2 },
    { x: 48, y: 78, size: 5, delay: 2.1 },
    { x: 12, y: 50, size: 5, delay: 1.7 },
    { x: 24, y: 84, size: 4, delay: 2.3 },
    { x: 76, y: 86, size: 4, delay: 1.1 }
  ];

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
