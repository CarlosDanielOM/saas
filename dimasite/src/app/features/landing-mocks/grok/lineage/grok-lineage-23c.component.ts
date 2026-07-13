import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Shield, Zap, BarChart3, Volume2 } from 'lucide-angular';
import { CountUpDirective } from '../../../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from '../../landing-analytics.service';
import { LinksService } from '../../../../services/links.service';

@Component({
  selector: 'app-grok-lineage-23c',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './grok-lineage-23c.component.html',
  styleUrl: './grok-lineage-23c.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GrokLineage23cComponent {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly links = inject(LinksService);
  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;

  readonly nodes = [
    { x: 50, y: 50, size: 28, hub: true },
    { x: 28, y: 30, size: 10 }, { x: 72, y: 28, size: 8 },
    { x: 22, y: 58, size: 9 }, { x: 78, y: 55, size: 11 },
    { x: 40, y: 78, size: 7 }, { x: 62, y: 76, size: 8 },
    { x: 50, y: 18, size: 6 }, { x: 15, y: 42, size: 5 },
    { x: 85, y: 40, size: 6 }, { x: 35, y: 45, size: 5 }
  ];

  onLogin(): void { void this.router.navigate(['/login']); }
  onDiscord(): void { window.open(this.links.getDiscordUrl(), '_blank', 'noopener,noreferrer'); }
  scrollTo(id: string): void { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }
}
