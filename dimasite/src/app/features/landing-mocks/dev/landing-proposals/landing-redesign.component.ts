import { isPlatformBrowser, NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { ArrowRightLeft, Bot, Check, Clapperboard, FileText, LucideAngularModule, ShieldAlert, TerminalSquare } from 'lucide-angular';

import { LpChromeComponent, LpNavLink } from './lp-chrome.component';
import { LpCopy } from './lp-copy';
import { LpLiveStripComponent } from './lp-live-strip.component';
import { FREE_MODULES, LpLive, MODULES, PAID_MODULES, PlanKey } from './lp-live.service';
import { LpPlansComponent } from './lp-plans.component';
import { LpStageComponent } from './lp-stage.component';

type UseKey = 'commands' | 'moderation' | 'alerts' | 'tts' | 'sounds' | 'games' | 'bits';

interface Cover {
  /** A module id (name from the module copy) or a copy key for things that aren't modules. */
  module?: string;
  label?: string;
  plan: PlanKey;
}

/**
 * What replaces each tool a streamer already uses (module plans from the real catalog).
 * No tip page here: the tip page is not a working product yet, so it is not advertised.
 */
const COVERS: Record<UseKey, Cover[]> = {
  commands: [{ label: 'switch.coverCommands', plan: 'free' }],
  moderation: [{ module: 'moderation', plan: 'free' }],
  alerts: [{ module: 'overlays', plan: 'free' }, { module: 'chat-events', plan: 'free' }],
  tts: [{ module: 'tts', plan: 'free' }],
  sounds: [{ module: 'triggers', plan: 'free' }, { module: 'redemptions', plan: 'free' }],
  games: [{ module: 'roulette', plan: 'free' }, { module: 'widgets', plan: 'premium' }],
  bits: [{ module: 'dimafx', plan: 'free' }]
};

const USES = Object.keys(COVERS) as UseKey[];

/**
 * Landing redesign (Nov 2026): one page built from the three earlier proposals.
 * 1. See it: a stream with chat that plays every feature (real duel and roulette overlays).
 * 2. Why switch: tap the tools you use today, see what covers each one and on which plan.
 * 3. Beyond the basics: the four things most bots don't do.
 * 4. Get started: three steps next to the real dashboard on a phone.
 * 5. Plans with computed value cues, then the questions people ask before switching.
 */
@Component({
  selector: 'app-landing-redesign',
  imports: [NgOptimizedImage, LucideAngularModule, LpChromeComponent, LpStageComponent, LpPlansComponent, LpLiveStripComponent],
  templateUrl: './landing-redesign.component.html',
  styleUrls: ['./lp-ui.css', './lp-page.css', './landing-redesign.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingRedesignComponent {
  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
  readonly icons = { check: Check, bot: Bot, shield: ShieldAlert, clip: Clapperboard, recap: FileText, both: ArrowRightLeft, commands: TerminalSquare };
  readonly uses = USES;
  readonly picked = signal<UseKey[]>(['commands', 'moderation', 'alerts', 'tts']);
  readonly freeModules = FREE_MODULES;
  readonly totalModules = MODULES.length;
  readonly floodBars = [12, 16, 10, 14, 92, 100, 30, 12];
  readonly faq = [1, 2, 3, 4, 5];
  /** Phones: the "beyond the basics" cards scroll sideways, so the strip must be keyboard reachable. */
  readonly narrow = signal(false);

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID)) || typeof matchMedia !== 'function') return;
    const query = matchMedia('(max-width: 639.98px)');
    const sync = () => this.narrow.set(query.matches);
    sync();
    query.addEventListener('change', sync);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', sync));
  }

  readonly links = computed<LpNavLink[]>(() => [
    { id: 'see', label: this.c.t('nav.see') },
    { id: 'switch', label: this.c.t('nav.switch') },
    { id: 'start', label: this.c.t('nav.start') },
    { id: 'plans', label: this.c.t('nav.plans') }
  ]);

  readonly covered = computed(() => {
    this.c.lang();
    return this.picked().map((key) => ({
      key,
      label: this.c.t(`switch.uses.${key}`),
      covers: COVERS[key].map((cv) => ({
        name: cv.module ? this.c.pair(`modules.${cv.module}`)[0] : this.c.t(cv.label ?? ''),
        plan: cv.plan
      }))
    }));
  });

  readonly summary = computed(() => {
    const picked = this.picked();
    if (!picked.length) return this.c.t('switch.coverNone');
    const free = picked.filter((k) => COVERS[k].some((cv) => cv.plan === 'free')).length;
    return this.c.t('switch.coverAll', { n: picked.length, free });
  });

  readonly paidModules = computed(() => {
    this.c.lang();
    return PAID_MODULES.map((m) => ({ id: m.id, name: this.c.pair(`modules.${m.id}`)[0] }));
  });

  toggle(key: UseKey): void {
    this.picked.update((list) => (list.includes(key) ? list.filter((k) => k !== key) : USES.filter((k) => k === key || list.includes(k))));
  }

  isPicked(key: UseKey): boolean {
    return this.picked().includes(key);
  }
}
