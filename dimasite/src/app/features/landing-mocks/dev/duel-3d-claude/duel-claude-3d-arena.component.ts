import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { DuelBattle, DuelSide, COMBO_HEAL, legacyBattle, otherSide, turnLength } from '../../../widgets/duel/duel-battle';
import { LanguageService } from '../../../../services/language.service';
import { DuelClaude3dScene, DuelSceneStats, healthAt } from './duel-claude-3d-scene';

const clamp = (x: number) => Math.min(1, Math.max(0, x));

@Component({
  selector: 'app-duel-claude-3d-arena',
  templateUrl: './duel-claude-3d-arena.component.html',
  styleUrl: './duel-claude-3d-arena.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DuelClaude3dArenaComponent {
  readonly names = input({ left: 'Dima', right: 'ChatChampion' });
  readonly battle = input<DuelBattle>(legacyBattle('left'));
  readonly elapsed = input(0);
  readonly started = input(false);
  readonly paused = input(false);
  readonly transparent = input(false);
  readonly locale = input<'en' | 'es'>('en');
  readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly unavailable = signal(false);
  readonly stats = signal<DuelSceneStats>({ fps: 0, calls: 0, triangles: 0 });
  private readonly language = inject(LanguageService);
  readonly sides: DuelSide[] = ['left', 'right'];
  readonly Math = Math;
  readonly otherSide = otherSide;
  readonly gems = [0, 1, 2, 3, 4];
  readonly health = computed(() => healthAt(this.battle(), this.elapsed(), this.started()));
  /** Trailing "chip" damage: the bar remembers HP from a moment ago, then drains. */
  readonly chip = computed(() => {
    const before = healthAt(this.battle(), Math.max(0, this.elapsed() - 650), this.started()), now = this.health();
    return { left: Math.max(now.left, before.left), right: Math.max(now.right, before.right) };
  });
  readonly phase = computed(() => !this.started() ? 'ready' : this.elapsed() < 1300 ? 'entrance' : this.elapsed() < 3400 ? 'countdown' : this.elapsed() < (this.battle().turns.at(-1)?.hitAt ?? 0) ? 'fight' : this.elapsed() < this.battle().duration ? 'knockout' : 'winner');
  readonly turnIndex = computed(() => {
    if (!this.started()) return -1;
    const turns = this.battle().turns; let index = -1;
    while (index + 1 < turns.length && turns[index + 1].at <= this.elapsed()) index++;
    return index;
  });
  readonly current = computed(() => { const turn = this.battle().turns[this.turnIndex()]; return turn && this.elapsed() < turn.at + (turn.move === 'ultimate' ? 5000 : turnLength(turn)) ? turn : null; });
  readonly ultimate = computed(() => this.current()?.move === 'ultimate' && this.phase() !== 'winner' ? this.current() : null);
  readonly impact = computed(() => { const turn = this.current(); return turn && turn.move !== 'ultimate' && this.elapsed() >= turn.hitAt && this.elapsed() < turn.hitAt + 900 ? turn : null; });
  readonly impactAge = computed(() => { const turn = this.impact(); return turn ? (this.elapsed() - turn.hitAt) / 900 : 0; });
  readonly comboAge = computed(() => { const turn = this.current(); if (!turn?.comboHeal) return -1; const age = this.elapsed() - turn.hitAt - COMBO_HEAL.delay; return age >= 0 && age < 900 ? age / 900 : -1; });
  readonly countdown = computed(() => Math.max(1, 3 - Math.floor((this.elapsed() - 1300) / 700)));
  readonly countdownPop = computed(() => ((this.elapsed() - 1300) % 700) / 700);
  readonly ultimateProgress = computed(() => { const turn = this.ultimate(); return turn ? clamp((this.elapsed() - turn.at) / (turn.hitAt - turn.at)) : 0; });
  readonly ultimateAge = computed(() => { const turn = this.ultimate(); return turn ? (this.elapsed() - turn.at) / 1000 : 0; });
  readonly damageSide = computed(() => { const hit = this.impact(); return !hit ? null : hit.move === 'heal' ? hit.attacker : otherSide(hit.attacker); });
  readonly knockoutAge = computed(() => (this.elapsed() - (this.battle().turns.at(-1)?.hitAt ?? 0)) / 1000);
  readonly charges = computed(() => {
    const max = this.battle().healCharges ?? 5, left = { left: max, right: max };
    if (this.started()) for (const turn of this.battle().turns) { if (turn.at > this.elapsed()) break; if (turn.move === 'heal') left[turn.attacker]--; if (turn.comboHeal && this.elapsed() >= turn.hitAt + COMBO_HEAL.delay) left[otherSide(turn.attacker)]--; }
    return left;
  });
  /** Ultimate title card: letters sweep in, then the kicker beat changes with the cinematic. */
  readonly beat = computed(() => { const age = this.ultimateAge(); return age < .9 ? 'a' : age < 2.0 ? 'b' : 'c'; });

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      let scene: DuelClaude3dScene | undefined;
      try {
        scene = new DuelClaude3dScene(this.canvas().nativeElement, () => ({ battle: this.battle(), elapsed: this.elapsed(), started: this.started(), paused: this.paused(), transparent: this.transparent() }), stats => this.stats.set(stats), () => this.unavailable.set(true));
      } catch { this.unavailable.set(true); }
      destroy.onDestroy(() => scene?.dispose());
    });
  }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('duelMock.' + key, params, this.locale()); }
  percent(value: number): number { return value / (this.battle().maxHp ?? 100) * 100; }
  /** 0 → 1 → settle: a punchy scale-in for cues, computed from the battle clock. */
  pop(k: number): number { return k < .18 ? 1.6 - k / .18 * .7 : k < .3 ? .9 + (k - .18) / .12 * .1 : 1; }
  fade(k: number, end = .8): number { return k < .08 ? k / .08 : k > end ? Math.max(0, 1 - (k - end) / (1 - end)) : 1; }
  turnLabel(): string {
    const turn = this.current(); if (!turn) return this.t('phase.' + this.phase());
    const character = this.battle().fighters[turn.attacker];
    return this.t(turn.move === 'ultimate' ? 'ultimate.' + character : turn.move === 'heal' ? 'heal.' + character : turn.move === 'special' ? 'special.' + character : 'move.' + turn.move);
  }
  hitText(): string {
    const hit = this.impact()!; const side = this.damageSide()!;
    if (hit.move === 'heal') return '+' + hit.heal;
    if (hit.defended && hit.move === 'special') return '−' + hit.damage;
    return hit.damage ? '−' + hit.damage : this.t('defenseResult.' + this.battle().fighters[side]);
  }
}
