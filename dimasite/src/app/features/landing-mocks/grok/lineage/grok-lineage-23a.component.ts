import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Shield, Zap, BarChart3, Volume2 } from 'lucide-angular';
import { CountUpDirective } from '../../../../shared/directives/count-up.directive';
import { LandingAnalyticsService } from '../../landing-analytics.service';
import { LinksService } from '../../../../services/links.service';

@Component({
  selector: 'app-grok-lineage-23a',
  imports: [LucideAngularModule, RouterLink, CountUpDirective],
  templateUrl: './grok-lineage-23a.component.html',
  styleUrl: './grok-lineage-23a.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GrokLineage23aComponent {
  private readonly router = inject(Router);
  private readonly analytics = inject(LandingAnalyticsService);
  private readonly links = inject(LinksService);
  readonly siteStats = this.analytics.siteStats;
  readonly liveChannels = this.analytics.liveChannels;
  readonly shieldIcon = Shield;
  readonly zapIcon = Zap;
  readonly chartIcon = BarChart3;
  readonly volumeIcon = Volume2;
  onLogin(): void { void this.router.navigate(['/login']); }
  onDiscord(): void { window.open(this.links.getDiscordUrl(), '_blank', 'noopener,noreferrer'); }
  scrollTo(id: string): void { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }
}
