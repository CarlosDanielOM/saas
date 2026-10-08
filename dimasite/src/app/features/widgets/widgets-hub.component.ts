import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { MODULE_TIER_REQUIREMENTS, isModuleAccessible } from '../modules/module-tier.model';

@Component({ selector: 'app-widgets-hub', imports: [RouterLink, LfIconComponent], templateUrl: './widgets-hub.component.html', styleUrl: './widgets-hub.component.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class WidgetsHubComponent {
  private readonly auth = inject(SessionAuthService);
  private readonly upgrade = inject(UpgradeService);
  readonly language = inject(LanguageService);
  readonly streamer = getRouteParam(inject(ActivatedRoute), 'streamer') ?? '';
  readonly premium = computed(() => isModuleAccessible(MODULE_TIER_REQUIREMENTS.widgets, this.auth.getPlanTierForStreamer(this.streamer)));

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('widgets.' + key, params); }
  promptUpgrade(): void { void this.upgrade.promptUpgradeForModule({ moduleId: 'widgets', source: 'widgets_hub' }); }
}
