import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, linkedSignal, signal } from '@angular/core';
import { DuelArenaComponent } from '../duel-arena.component';
import { COMBO_HEAL, DuelSide, DuelTurn } from '../duel-battle';
import { DuelClaudeClockDirective } from './duel-claude-clock.directive';
import { DuelClaudeFighterComponent } from './duel-claude-fighter.component';

/** Time between seeded scenery particles so the backdrop never repeats visibly. */
const EMBERS = Array.from({ length: 18 }, (_, n) => ({ n, x: (n * 53) % 100, size: .35 + (n * 7 % 5) * .12, speed: 7 + (n * 11 % 6) }));
const STARS = Array.from({ length: 46 }, (_, n) => ({ x: (n * 137.5) % 1600, y: (n * 71.3) % 430, r: n % 7 ? .9 + (n % 3) * .35 : 2.1, d: (n * 377) % 3000 }));

/**
 * Claude's SVG entry: the original duel arena re-staged in higher detail. It keeps the
 * original battle model and turn logic (inherited), so every fight plays out exactly like
 * the live widget, and redraws the fighters, scenery, HUD, combat effects and ultimates.
 *
 * Every animated element is created through `duelClock`, so pausing and scrubbing always
 * show the exact frame for the battle time instead of restarting animations.
 */
@Component({
  selector: 'app-duel-claude-arena',
  imports: [DuelClaudeFighterComponent, DuelClaudeClockDirective],
  templateUrl: './duel-claude-arena.component.html',
  styleUrls: ['./duel-claude-arena.component.css', './duel-claude-ultimates.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelClaudeArenaComponent extends DuelArenaComponent {
  readonly embers = EMBERS;
  readonly stars = STARS;
  readonly rays = Array.from({ length: 12 }, (_, n) => n);
  readonly sparks = Array.from({ length: 10 }, (_, n) => n);
  readonly debris = Array.from({ length: 16 }, (_, n) => n);
  readonly petals = Array.from({ length: 14 }, (_, n) => n);
  /** Thousand Cuts: angle, offset and length (% of the cut box) of each brush stroke. */
  readonly brushCuts = [[-28, -6, 100], [22, 8, 92], [-66, 4, 80], [58, -10, 86], [4, 14, 96], [-46, -14, 78], [80, 2, 70], [-12, -2, 104], [38, 12, 84], [-84, -8, 72], [14, -16, 88], [-38, 18, 82]];
  readonly reduced = signal(false);

  /**
   * Bumps whenever the battle clock jumps (seek, replay, any change while paused), so keyed
   * elements are re-created and pick up the new time; normal ticks keep their animations.
   */
  readonly epoch = linkedSignal<{ time: number; paused: boolean }, number>({
    source: () => ({ time: this.elapsed(), paused: this.paused() }),
    computation: (now, previous) => {
      if (!previous) return 0;
      const before = previous.source.time, jumped = now.time < before || now.time - before > 150 || (now.paused && previous.source.paused && now.time !== before);
      return jumped ? previous.value + 1 : previous.value;
    }
  });

  /** Battle time at which the current pose of `side` started. */
  actionStart(side: DuelSide): number {
    const action = this.action(side), turn = this.currentTurn();
    if (action === 'attack' || action === 'heal') return turn?.at ?? 0;
    if (action === 'defend') return turn ? turn.at + (turn.hitAt - turn.at) * .4 : 0;
    if (action === 'hit') return turn?.hitAt ?? 0;
    if (action === 'defeated') return this.finalHit();
    if (action === 'victory') return this.battle().duration;
    return 0;
  }
  /** Re-created with the pose and on every clock jump. */
  poseKey(side: DuelSide): string { return `${this.actionKey(side)}/${this.epoch()}`; }
  key(name: string | number): string { return `${name}/${this.epoch()}`; }
  age(from: number): number { return this.elapsed() - from; }

  /** The final turn when it is an ultimate and the knockout phase still shows it. */
  readonly finisher = computed(() => this.phase() !== 'winner' ? this.ultimate() : null);
  readonly countdownStart = computed(() => 1300 + (3 - this.countdown()) * 700);
  readonly comboAt = computed(() => { const combo = this.comboImpact(); return combo ? combo.hitAt + COMBO_HEAL.delay : 0; });
  /** The HUD steps back for an ultimate's cinematic and returns as the blow lands. */
  readonly hudOpacity = computed(() => {
    const ult = this.finisher();
    if (!ult || this.reduced()) return 1;
    const since = this.elapsed() - ult.at, hit = ult.hitAt - ult.at;
    return since < 380 ? 1 - .85 * since / 380 : since < hit ? .15 : Math.min(1, .15 + .85 * (since - hit) / 380);
  });

  /**
   * Camera: a decaying shake and a punch-in toward the defender on heavy hits, a slow push
   * during an ultimate's windup and the knockout zoom. Computed from battle time so pauses
   * and seeks stay exact.
   */
  readonly camera = computed(() => {
    if (this.reduced() || !this.started()) return { transform: 'none', origin: '50% 60%' };
    const time = this.elapsed(), turn = this.currentTurn(), finisher = this.ultimate(), spread = this.spread();
    let x = 0, y = 0, zoom = 1, focus = 50;
    if (turn && turn.move !== 'heal' && turn.move !== 'ultimate' && !this.held(turn)) {
      const since = time - turn.hitAt, power = turn.crit ? 1.5 : turn.move === 'special' ? 1.3 : turn.move === 'heavy' ? .8 : .3;
      focus = 50 + (turn.attacker === 'left' ? spread : -spread);
      if (since >= 0 && since < 520) {
        const decay = (1 - since / 520) ** 2;
        x = Math.sin(since / 15) * power * decay; y = Math.cos(since / 21) * power * .6 * decay;
        zoom = 1 + (turn.move === 'normal' && !turn.crit ? .012 : .045) * decay;
      } else if (since < 0 && turn.move === 'special') zoom = 1 + .025 * Math.min(1, (time - turn.at) / (turn.hitAt - turn.at));
    }
    if (finisher) {
      const since = time - finisher.at, windup = finisher.hitAt - finisher.at, hit = time - finisher.hitAt;
      focus = 50 + (finisher.attacker === 'left' ? spread : -spread);
      zoom = 1 + .07 * Math.min(1, Math.max(0, since / windup));
      if (hit >= 0) {
        const decay = Math.max(0, 1 - hit / 900) ** 2;
        x = Math.sin(hit / 13) * 2.4 * decay; y = Math.cos(hit / 17) * 1.6 * decay;
        zoom = 1 + .07 * Math.max(0, 1 - hit / 1400);
      }
    } else if (this.phase() === 'knockout') {
      const since = time - this.finalHit();
      zoom = since < 500 ? 1.08 : 1 + .08 * Math.max(0, 1 - (since - 500) / 1400);
      focus = 50 + (this.winner() === 'left' ? this.spread() : -this.spread());
    }
    return { transform: `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%) scale(${zoom.toFixed(4)})`, origin: `${focus.toFixed(1)}% 62%` };
  });

  /** Fighter offset from the center, as % of the arena width (matches --fight-spread). */
  private readonly wide = signal(true);
  private spread(): number { return this.wide() ? 13 : 15; }

  constructor() {
    super();
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const motion = matchMedia('(prefers-reduced-motion: reduce)'), wide = matchMedia('(min-width: 640px)');
      const update = () => { this.reduced.set(motion.matches); this.wide.set(wide.matches); };
      update();
      motion.addEventListener('change', update); wide.addEventListener('change', update);
      destroy.onDestroy(() => { motion.removeEventListener('change', update); wide.removeEventListener('change', update); });
    });
  }

  /** Short class-specific name for a normal/heavy attack, shown with the damage. */
  attackName(turn: DuelTurn): string { return turn.move === 'normal' || turn.move === 'heavy' ? this.t(`svgClaude.moves.${this.battle().fighters[turn.attacker]}.${turn.move}`) : ''; }
  /** Heavy moves are named per class; specials and heals keep their original names. */
  calloutName(turn: DuelTurn): string { return turn.move === 'heavy' ? this.attackName(turn) : this.moveName(turn); }
  sigil(side: DuelSide): string { const character = this.battle().fighters[side]; return character === 'knight' ? 'M12 2v20M5 9h14' : character === 'mage' ? 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z' : 'M4 20L20 4M7 4l13 13'; }
}
