import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  Bell,
  Bot,
  Dices,
  Gem,
  Heart,
  LucideAngularModule,
  LucideIconData,
  MessageSquareText,
  Pause,
  Play,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Star,
  Swords,
  Volume2
} from 'lucide-angular';

import { DuelStageComponent } from '../../../widgets/duel/duel-stage.component';
import { DuelBattle, simulateBattle } from '../../../widgets/duel/duel-battle';
import { RouletteDisplayComponent } from '../../../roulette/roulette-display.component';
import { Roulette, RouletteDraw, slotsFor } from '../../../roulette/roulette-api.service';
import { LpCopy } from './lp-copy';
import { PlanKey } from './lp-live.service';

export type SceneId = 'alerts' | 'tts' | 'dimafx' | 'duel' | 'roulette' | 'ai' | 'moderation' | 'defense';

interface Line {
  key: string;
  who: string;
  kind: 'viewer' | 'bot' | 'event';
  at: number;
  /** Moderation: the message is removed at this time. */
  removedAt?: number;
}

interface Scene {
  icon: LucideIconData;
  plan: PlanKey;
  credits?: boolean;
  docs: string;
  duration: number;
  lines: Line[];
}

const BOT = 'DomDimaBot';
const DUEL_START = 3800;
const SPIN_AT = 1200;
const SPIN_MS = 5000;

export const SCENES: Record<SceneId, Scene> = {
  alerts: {
    icon: Bell,
    plan: 'free',
    docs: '/chat-events/',
    duration: 9500,
    lines: [
      { key: 'e1', who: '', kind: 'event', at: 500 },
      { key: 'b1', who: BOT, kind: 'bot', at: 1300 },
      { key: 'v1', who: 'taco_fan', kind: 'viewer', at: 2400 },
      { key: 'e2', who: '', kind: 'event', at: 5000 },
      { key: 'b2', who: BOT, kind: 'bot', at: 5800 }
    ]
  },
  tts: {
    icon: Volume2,
    plan: 'free',
    credits: true,
    docs: '/tts/',
    duration: 8500,
    lines: [
      { key: 'e1', who: '', kind: 'event', at: 400 },
      { key: 'v1', who: 'taco_fan', kind: 'viewer', at: 500 },
      { key: 'b1', who: BOT, kind: 'bot', at: 1200 },
      { key: 'v2', who: 'lunatica_v', kind: 'viewer', at: 4200 }
    ]
  },
  dimafx: {
    icon: Gem,
    plan: 'free',
    docs: '/dimafx/',
    duration: 8500,
    lines: [
      { key: 'v1', who: 'lunatica_v', kind: 'viewer', at: 400 },
      { key: 'e1', who: '', kind: 'event', at: 2000 },
      { key: 'v2', who: 'NovaPlays', kind: 'viewer', at: 3000 },
      { key: 'v3', who: 'taco_fan', kind: 'viewer', at: 4200 }
    ]
  },
  duel: {
    icon: Swords,
    plan: 'premium',
    docs: '/modules/',
    duration: 0,
    lines: [
      { key: 'v1', who: 'taco_fan', kind: 'viewer', at: 300 },
      { key: 'b1', who: BOT, kind: 'bot', at: 1100 },
      { key: 'v2', who: 'lunatica_v', kind: 'viewer', at: 2600 },
      { key: 'b2', who: BOT, kind: 'bot', at: 3300 }
    ]
  },
  roulette: {
    icon: Dices,
    plan: 'free',
    docs: '/roulette/',
    duration: SPIN_AT + SPIN_MS + 2600,
    lines: [
      { key: 'v1', who: 'NovaPlays', kind: 'viewer', at: 300 },
      { key: 'b1', who: BOT, kind: 'bot', at: SPIN_AT - 300 },
      { key: 'v2', who: 'pixel_pancho', kind: 'viewer', at: 2600 }
    ]
  },
  ai: {
    icon: Bot,
    plan: 'free',
    credits: true,
    docs: '/ai-personality/',
    duration: 10500,
    lines: [
      { key: 'v1', who: 'pixel_pancho', kind: 'viewer', at: 400 },
      { key: 'b1', who: BOT, kind: 'bot', at: 1800 },
      { key: 'v2', who: 'pixel_pancho', kind: 'viewer', at: 4600 },
      { key: 'b2', who: BOT, kind: 'bot', at: 5800 }
    ]
  },
  moderation: {
    icon: Shield,
    plan: 'free',
    docs: '/moderation/',
    duration: 8000,
    lines: [
      { key: 'v1', who: 'xx_promo_77', kind: 'viewer', at: 400, removedAt: 1500 },
      { key: 'e1', who: '', kind: 'event', at: 1500 },
      { key: 'v2', who: 'lunatica_v', kind: 'viewer', at: 3000 },
      { key: 'v3', who: 'taco_fan', kind: 'viewer', at: 4200 }
    ]
  },
  defense: {
    icon: ShieldAlert,
    plan: 'free',
    docs: '/follow-defense/',
    duration: 9500,
    lines: [
      { key: 'e1', who: '', kind: 'event', at: 2400 },
      { key: 'e2', who: '', kind: 'event', at: 2700 },
      { key: 'v1', who: 'taco_fan', kind: 'viewer', at: 4000 },
      { key: 'e3', who: '', kind: 'event', at: 6600 }
    ]
  }
};

export const SCENE_ORDER: SceneId[] = ['alerts', 'tts', 'dimafx', 'duel', 'roulette', 'ai', 'moderation', 'defense'];

const NAME_TONES = ['n1', 'n2', 'n3', 'n4'];
const PRIZE_COLORS = ['#cbbaff', '#f4c968', '#ec9baf', '#8fd3c7', '#9cc3ff', '#f6a96b'];

/**
 * A fake stream (game scene, webcam, overlay) with its chat, playing one feature at a time.
 * Duels and roulette use the real overlay components, fed with a simulated battle / draw.
 */
@Component({
  selector: 'app-lp-stage',
  imports: [LucideAngularModule, DuelStageComponent, RouletteDisplayComponent],
  templateUrl: './lp-stage.component.html',
  styleUrls: ['./lp-ui.css', './lp-stage.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LpStageComponent {
  /** Scenes offered as tabs; one scene and no tabs for an embedded preview. */
  readonly scenes = input<SceneId[]>(SCENE_ORDER);
  readonly fixed = input<SceneId | null>(null, { alias: 'scene' });
  readonly compact = input(false);
  readonly autoplay = input(true);
  readonly sceneChange = output<SceneId>();

  readonly c = inject(LpCopy);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly reduced =
    this.browser && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  readonly icons = { pause: Pause, play: Play, replay: RotateCcw, heart: Heart, star: Star, shield: ShieldCheck, alert: ShieldAlert, gem: Gem, bot: Bot, speech: MessageSquareText, volume: Volume2 };
  readonly SCENES = SCENES;
  readonly DUEL_START_MS = DUEL_START;

  readonly current = signal<SceneId>('alerts');
  readonly playing = signal(true);
  /** Bumps on every (re)start so overlay animations replay. */
  readonly run = signal(0);
  private startedAt = 0;
  readonly t = signal(0);

  readonly battle = signal<DuelBattle>(simulateBattle());
  readonly duelNames = { left: 'taco_fan', right: 'lunatica_v' };
  readonly roulette = computed<Roulette>(() => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    return {
      id: 'demo',
      alias: 'next',
      name: this.c.t('stage.roulette.name'),
      design: 'wheel',
      cardSize: 'medium',
      colors: PRIZE_COLORS,
      durationSeconds: SPIN_MS / 1000,
      items: ids.map((id) => ({ id, label: this.c.t(`stage.roulette.${id}`), multiplier: 1, weight: 1, copies: [`${id}-1`] })),
      order: ids.map((id) => `${id}-1`),
      settings: { insertion: 'append', duplicate: 'separate', shuffleBeforeDraw: false, showOnStart: true, hideAfterSeconds: null, winnerAction: 'keep' }
    };
  });
  readonly draw = signal<RouletteDraw | null>(null);
  readonly drawTime = signal(0);

  readonly def = computed(() => SCENES[this.current()]);
  readonly duration = computed(() =>
    this.current() === 'duel' ? DUEL_START + this.battle().duration + 2600 : this.def().duration
  );
  readonly duelElapsed = computed(() => Math.max(0, Math.min(this.battle().duration, this.t() - DUEL_START)));
  readonly winner = computed(() => {
    const b = this.battle();
    return { name: this.duelNames[b.winner], loser: this.duelNames[b.winner === 'left' ? 'right' : 'left'] };
  });

  readonly lines = computed(() => {
    const id = this.current();
    const t = this.t();
    const base = this.def().lines.map((l) => ({
      ...l,
      text: this.c.t(`stage.chat.${id}.${l.key}`),
      removed: l.removedAt !== undefined && t >= l.removedAt
    }));
    if (id === 'duel') {
      base.push({ key: 'win', who: BOT, kind: 'bot', at: DUEL_START + this.battle().duration + 300, text: this.c.t('stage.chat.duel.win', this.winner()), removed: false });
    }
    if (id === 'roulette') {
      const prize = this.draw()?.winner.label ?? '';
      base.push({ key: 'win', who: BOT, kind: 'bot', at: SPIN_AT + SPIN_MS + 300, text: this.c.t('stage.chat.roulette.win', { prize }), removed: false });
    }
    return base.filter((l) => l.at <= t);
  });

  readonly defenseCount = computed(() => Math.round(38 * Math.min(1, Math.max(0, (this.t() - 400) / 2400))));

  constructor() {
    effect(() => {
      const fixed = this.fixed();
      if (fixed) this.begin(fixed);
    });
    effect(() => {
      if (!this.autoplay() || this.reduced) this.playing.set(false);
    });
    if (!this.browser) return;
    const timer = setInterval(() => this.tick(), 50);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    queueMicrotask(() => this.begin(this.fixed() ?? this.scenes()[0] ?? 'alerts'));
  }

  pick(id: SceneId): void {
    this.playing.set(false);
    this.begin(id);
    this.sceneChange.emit(id);
  }

  replay(): void {
    this.begin(this.current());
  }

  togglePlay(): void {
    const next = !this.playing();
    this.playing.set(next);
    if (next && this.t() >= this.duration()) this.advance();
  }

  tone(name: string): string {
    if (name === BOT) return 'bot';
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return NAME_TONES[h % NAME_TONES.length];
  }

  private begin(id: SceneId): void {
    this.current.set(id);
    this.run.update((n) => n + 1);
    this.startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    this.draw.set(null);
    if (id === 'duel') {
      let b = simulateBattle();
      for (let i = 0; i < 25 && b.duration > 18000; i++) b = simulateBattle();
      this.battle.set(b);
    }
    // Reduced motion: show the finished scene instead of animating it.
    this.t.set(this.reduced ? 1e9 : 0);
    if (id === 'roulette' && this.reduced) this.spin();
  }

  private tick(): void {
    if (this.reduced) return;
    const t = performance.now() - this.startedAt;
    this.t.set(t);
    if (this.current() === 'roulette' && !this.draw() && t >= SPIN_AT) this.spin();
    if (t < this.duration()) return;
    const fixed = this.fixed();
    if (fixed && this.autoplay()) this.begin(fixed);
    else if (!fixed && this.playing()) this.advance();
  }

  private advance(): void {
    const list = this.scenes();
    const next = list[(list.indexOf(this.current()) + 1) % list.length];
    this.begin(next);
  }

  private spin(): void {
    const roulette = this.roulette();
    const slots = slotsFor(roulette);
    const winner = slots[Math.floor(Math.random() * slots.length)];
    const now = Date.now();
    this.drawTime.set(now);
    this.draw.set({
      id: `demo-${this.run()}`,
      rouletteId: roulette.id,
      startedAt: now,
      endsAt: now + SPIN_MS,
      completedAt: null,
      winner,
      slots,
      design: 'wheel',
      cardSize: 'medium',
      colors: roulette.colors
    });
  }
}
