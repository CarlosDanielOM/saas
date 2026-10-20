import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Check, HeartHandshake, LayoutDashboard, LucideAngularModule, Sparkles } from 'lucide-angular';

import { LpChromeComponent, LpNavLink } from './lp-chrome.component';
import { LpCopy } from './lp-copy';
import { LpLive } from './lp-live.service';
import { LpPlansComponent } from './lp-plans.component';
import { LpStageComponent } from './lp-stage.component';
import { LpLiveStripComponent } from './lp-live-strip.component';

/**
 * Proposal A · "See what it does": the hero is a stream with chat that plays every feature,
 * using the real duel and roulette overlays. Live board: only real live channels when there
 * are any, plus one big honest number.
 */
@Component({
  selector: 'app-landing-showcase',
  imports: [LucideAngularModule, LpChromeComponent, LpStageComponent, LpPlansComponent, LpLiveStripComponent],
  templateUrl: './landing-showcase.component.html',
  styleUrls: ['./lp-ui.css', './lp-page.css', './landing-showcase.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingShowcaseComponent {
  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
  readonly icons = { check: Check, one: LayoutDashboard, extra: Sparkles, tips: HeartHandshake };

  readonly links = computed<LpNavLink[]>(() => [
    { id: 'see', label: this.c.t('nav.see') },
    { id: 'why', label: this.c.t('nav.switch') },
    { id: 'start', label: this.c.t('nav.start') },
    { id: 'plans', label: this.c.t('nav.plans') }
  ]);

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
