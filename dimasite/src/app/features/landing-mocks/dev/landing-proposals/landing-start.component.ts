import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Bell, Bot, Dices, Gem, LucideAngularModule, LucideIconData, Shield, Volume2 } from 'lucide-angular';

import { LpChromeComponent, LpNavLink } from './lp-chrome.component';
import { LpCopy } from './lp-copy';
import { LpLiveStripComponent } from './lp-live-strip.component';
import { LpLive, MODULES, PlanKey } from './lp-live.service';
import { LpPlansComponent } from './lp-plans.component';
import { LpStageComponent, SceneId } from './lp-stage.component';

type GoalKey = 'safe' | 'tts' | 'alerts' | 'fun' | 'earn' | 'ai';
type AiUse = 'a' | 'b' | 'c';

const GOALS: { key: GoalKey; icon: LucideIconData; scene: SceneId; minutes: number }[] = [
  { key: 'safe', icon: Shield, scene: 'moderation', minutes: 2 },
  { key: 'tts', icon: Volume2, scene: 'tts', minutes: 3 },
  { key: 'alerts', icon: Bell, scene: 'alerts', minutes: 2 },
  { key: 'fun', icon: Dices, scene: 'roulette', minutes: 4 },
  { key: 'earn', icon: Gem, scene: 'dimafx', minutes: 5 },
  { key: 'ai', icon: Bot, scene: 'ai', minutes: 4 }
];

/** Login 1 min, permissions 1 min, bot on 30 s, test 1 min. */
const BASE_SECONDS = 60 + 60 + 30 + 60;

/**
 * Proposal C · "Get set up fast": pick what you want first, get the exact steps with times and
 * a preview of what viewers will see; a three-question plan finder; every module, its plan and
 * status. Live board: only real live channels, next to the last call to action.
 */
@Component({
  selector: 'app-landing-start',
  imports: [LucideAngularModule, LpChromeComponent, LpStageComponent, LpPlansComponent, LpLiveStripComponent],
  templateUrl: './landing-start.component.html',
  styleUrls: ['./lp-ui.css', './lp-page.css', './landing-start.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LandingStartComponent {
  readonly c = inject(LpCopy);
  readonly live = inject(LpLive);
  readonly goals = GOALS;

  /** Desktop shows every module group open; phones open only the first. */
  readonly wide = typeof matchMedia === 'function' && matchMedia('(min-width: 960px)').matches;

  readonly goal = signal<GoalKey>('safe');
  readonly current = computed(() => GOALS.find((g) => g.key === this.goal())!);

  readonly wantsGames = signal(false);
  readonly wantsAnalytics = signal(false);
  readonly aiUse = signal<AiUse>('a');

  readonly links = computed<LpNavLink[]>(() => [
    { id: 'goal', label: this.c.t('nav.start') },
    { id: 'finder', label: this.c.t('nav.plans') },
    { id: 'later', label: this.c.t('nav.see') }
  ]);

  readonly steps = computed(() => {
    const c = this.c;
    const g = this.current();
    const [stepTitle, stepCopy] = c.pair(`start.step.${g.key}`);
    const [testTitle, testCopy] = c.pair(`start.test.${g.key}`);
    return [
      { title: c.t('start.s1'), copy: c.t('start.s1Copy'), time: c.t('start.min', { n: 1 }) },
      { title: c.t('start.s2'), copy: c.t('start.s2Copy'), time: c.t('start.min', { n: 1 }) },
      { title: c.t('start.s3'), copy: c.t('start.s3Copy'), time: c.t('start.sec', { n: 30 }) },
      { title: stepTitle, copy: stepCopy, time: c.t('start.min', { n: g.minutes }), goal: true },
      { title: testTitle, copy: testCopy, time: c.t('start.min', { n: 1 }), goal: true }
    ];
  });

  readonly total = computed(() => {
    const min = Math.ceil((BASE_SECONDS + this.current().minutes * 60) / 60);
    return this.c.t(this.goal() === 'fun' ? 'start.planTotalPaid' : 'start.planTotal', { min });
  });

  readonly recommended = computed<PlanKey>(() => {
    if (this.aiUse() === 'c') return 'pro';
    if (this.wantsGames() || this.wantsAnalytics() || this.aiUse() === 'b') return 'premium';
    return 'free';
  });

  readonly result = computed(() => {
    const c = this.c;
    const plan = this.recommended();
    if (plan === 'free') return c.t('start.resultFree');
    const why = [
      this.wantsGames() ? c.t('start.whyGames') : '',
      this.wantsAnalytics() ? c.t('start.whyAnalytics') : '',
      this.aiUse() === 'c' ? c.t('start.whyAiPro') : this.aiUse() === 'b' ? c.t('start.whyAi') : ''
    ].filter(Boolean);
    return c.t(plan === 'pro' ? 'start.resultPro' : 'start.resultPremium', { why: why.join(', ') });
  });

  readonly groups = computed(() => {
    const c = this.c;
    c.lang();
    return (['engagement', 'automation', 'content'] as const).map((cat) => {
      const rows = MODULES.filter((m) => m.category === cat).map((m) => {
        const [name, copy] = c.pair(`modules.${m.id}`);
        return { ...m, name, copy };
      });
      return { cat, label: c.t(`start.groups.${cat}`), count: c.t('start.modulesCount', { n: rows.length }), rows };
    });
  });
}
