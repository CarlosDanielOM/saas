import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  ArrowRightLeft,
  Bot,
  Check,
  Clapperboard,
  FileText,
  Link2,
  LucideAngularModule,
  ShieldAlert,
  TerminalSquare,
  Users
} from 'lucide-angular';

import { LpChromeComponent, LpNavLink } from './lp-chrome.component';
import { LpCopy } from './lp-copy';
import { LpLiveStripComponent } from './lp-live-strip.component';
import { FREE_MODULES, LpLive, MODULES, PAID_MODULES, PlanKey } from './lp-live.service';
import { LpPlansComponent } from './lp-plans.component';

type UseKey = 'commands' | 'moderation' | 'alerts' | 'tts' | 'tips' | 'sounds' | 'games' | 'bits';

interface Cover {
  /** A module id (name from the module copy) or a copy key for things that aren't modules. */
  module?: string;
  label?: string;
  plan: PlanKey;
}

/** What replaces each tool a streamer already uses (module plans from the real catalog). */
const COVERS: Record<UseKey, Cover[]> = {
  commands: [{ label: 'switch.coverCommands', plan: 'free' }],
  moderation: [{ module: 'moderation', plan: 'free' }],
  alerts: [{ module: 'overlays', plan: 'free' }, { module: 'chat-events', plan: 'free' }],
  tts: [{ module: 'tts', plan: 'free' }],
  tips: [{ label: 'switch.coverTips', plan: 'free' }],
  sounds: [{ module: 'triggers', plan: 'free' }, { module: 'redemptions', plan: 'free' }],
  games: [{ module: 'roulette', plan: 'free' }, { module: 'widgets', plan: 'premium' }],
  bits: [{ module: 'dimafx', plan: 'free' }]
};

const USES = Object.keys(COVERS) as UseKey[];

/**
 * Proposal B · "Why switch": the visitor taps the tools they use today and sees what covers
 * each one here, then what they'd gain, and an honest "moving over" checklist.
 * Live board: a proof band with only the strong totals, plus real live channels.
 */
@Component({
  selector: 'app-landing-switch',
  imports: [LucideAngularModule, LpChromeComponent, LpPlansComponent, LpLiveStripComponent],
  templateUrl: './landing-switch.component.html',
  styleUrls: ['./lp-ui.css', './lp-page.css', './landing-switch.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingSwitchComponent {
  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
  readonly icons = { check: Check, bot: Bot, shield: ShieldAlert, clip: Clapperboard, recap: FileText, both: ArrowRightLeft, commands: TerminalSquare, link: Link2, mods: Users };
  readonly uses = USES;
  readonly picked = signal<UseKey[]>(['commands', 'moderation', 'alerts', 'tts']);
  readonly freeModules = FREE_MODULES;
  readonly totalModules = MODULES.length;

  readonly links = computed<LpNavLink[]>(() => [
    { id: 'tools', label: this.c.t('nav.switch') },
    { id: 'beyond', label: this.c.t('nav.see') },
    { id: 'move', label: this.c.t('nav.start') },
    { id: 'plans', label: this.c.t('nav.plans') }
  ]);

  readonly covered = computed(() => {
    this.c.lang();
    return this.picked().map((key) => ({
      key,
      label: this.c.t(`switch.uses.${key}`),
      covers: COVERS[key].map((cv) => ({
        name: cv.module ? this.c.pair(`modules.${cv.module}`)[0] : this.c.t(cv.label!),
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

  readonly proof = computed(() => {
    const s = this.live.stats();
    return [
      { n: s.messagesReceived, label: this.c.t('common.messages') },
      { n: s.totalCommands, label: this.c.t('common.commands') },
      { n: s.botActiveAccounts, label: this.c.t('common.channels') }
    ].filter((p) => p.n > 0);
  });

  toggle(key: UseKey): void {
    this.picked.update((list) => (list.includes(key) ? list.filter((k) => k !== key) : USES.filter((k) => k === key || list.includes(k))));
  }

  isPicked(key: UseKey): boolean {
    return this.picked().includes(key);
  }
}
