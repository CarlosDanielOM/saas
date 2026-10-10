import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { LanguageService } from '../../../../services/language.service';
import { COMBO_HEAL, DuelBattle, DuelSide, legacyBattle, otherSide } from '../../../widgets/duel/duel-battle';
import { DuelSvgFighterComponent } from './duel-svg-fighter.component';
import { baseX, clamp, ease, vectorFrame, VectorPose } from './duel-svg-motion';

@Component({
  selector: 'app-duel-svg-gpt-arena',
  imports: [DuelSvgFighterComponent],
  templateUrl: './duel-svg-arena.component.html',
  styleUrl: './duel-svg-arena.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DuelSvgArenaComponent {
  readonly names = input({ left: 'Dima', right: 'ChatChampion' });
  readonly battle = input<DuelBattle>(legacyBattle('left'));
  readonly elapsed = input(0);
  readonly started = input(false);
  readonly paused = input(false);
  readonly transparent = input(false);
  readonly locale = input<'en' | 'es'>('en');
  readonly reduced = signal(false);
  private readonly language = inject(LanguageService);
  readonly sides: DuelSide[] = ['left', 'right'];
  readonly particles = Array.from({ length: 24 }, (_, i) => i);
  readonly stars = Array.from({ length: 32 }, (_, i) => ({ x: 28 + (i * 137) % 910, y: 138 + (i * 71) % 192, r: i % 4 ? .8 : 1.8 }));
  readonly cuts = [-27, 20, -58, 7, 43, -12];
  readonly frame = computed(() => vectorFrame(this.battle(), this.elapsed(), this.started(), this.reduced()));
  readonly actor = computed(() => this.frame().ultimate?.attacker ?? this.frame().turn?.attacker ?? 'left');
  readonly target = computed(() => otherSide(this.actor()));
  readonly ultimateClass = computed(() => this.frame().ultimate ? this.battle().fighters[this.actor()] : null);
  readonly age = computed(() => this.frame().ultimate ? this.elapsed() - this.frame().ultimate!.at : 0);
  readonly hitAge = computed(() => this.frame().turn ? this.elapsed() - this.frame().turn!.hitAt : -1);
  readonly ultHitAge = computed(() => this.frame().ultimate ? this.elapsed() - this.frame().ultimate!.hitAt : -1);
  readonly hpMax = computed(() => this.battle().maxHp ?? 100);
  readonly charges = computed(() => Array.from({ length: this.battle().healCharges ?? 5 }, (_, i) => i));
  readonly block = computed(() => !!this.frame().turn?.defended && this.frame().turn?.move !== 'special');
  readonly combo = computed(() => { const turn = this.frame().turn; return turn?.comboHeal && this.elapsed() >= turn.hitAt + COMBO_HEAL.delay && this.elapsed() < turn.hitAt + COMBO_HEAL.delay + 700 ? turn : null; });
  readonly effectScale = computed(() => this.reduced() ? 0 : ease((this.age() - 400) / 1000) * (1 - ease(this.ultHitAge() / 850)));
  readonly countdown = computed(() => Math.max(1, 3 - Math.floor((this.elapsed() - 1300) / 700)));
  readonly healOpacity = computed(() => Math.sin(clamp(this.frame().age / 1500) * Math.PI));
  readonly camera = computed(() => {
    const f = this.frame();
    if (this.reduced()) return '';
    const zoom = f.ultimate ? 1 + Math.sin(f.charge * Math.PI) * .045 : 1;
    const impact = f.impact * (this.block() || f.turn?.move === 'heal' ? 0 : f.turn?.move === 'ultimate' ? 4 : 1.6);
    const x = Math.sin(this.hitAge() / 22) * impact, y = Math.cos(this.hitAge() / 31) * impact * .4;
    return `translate(${x.toFixed(2)} ${y.toFixed(2)}) translate(480 300) scale(${zoom.toFixed(4)}) translate(-480 -300)`;
  });

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const query = matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => this.reduced.set(query.matches); update();
      query.addEventListener('change', update); destroy.onDestroy(() => query.removeEventListener('change', update));
    });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('duelMock.' + key, params, this.locale()); }
  x(side: DuelSide): number { return baseX(side); }
  poseTransform(side: DuelSide): string {
    const p = this.frame().poses[side], direction = side === 'left' ? 1 : -1;
    return `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) rotate(${p.rotation.toFixed(2)}) scale(${(p.sx * direction * .9).toFixed(4)} ${(p.sy * .9).toFixed(4)}) translate(-108 -300)`;
  }
  bodyOpacity(side: DuelSide): number { return this.frame().poses[side].opacity; }
  splitTransform(pose: VectorPose, half: 'top' | 'bottom'): string { return half === 'top' ? `translate(${pose.split * 16} ${pose.split * -8}) rotate(${pose.split * 12} 108 200)` : `translate(${-pose.split * 9} ${pose.split * 7})`; }
  slashOpacity(): number { return this.reduced() ? 0 : ease((this.hitAge() + 80) / 60) * (1 - ease(this.hitAge() / 240)); }
  projectileX(): number {
    const turn = this.frame().turn; if (!turn) return 480;
    const travel = ease((this.elapsed() - turn.hitAt + 210) / 210);
    return this.x(turn.attacker) + (this.x(otherSide(turn.attacker)) - this.x(turn.attacker)) * travel;
  }
  bladeY(): number { return -250 + 90 * ease((this.age() - 600) / 500) + 390 * ease((this.ultHitAge() + 240) / 240); }
  shockScale(): number { return 1 + ease(this.ultHitAge() / 900) * 6; }
  debris(n: number): string {
    const a = n * 2.399 + this.age() / 220, ring = 60 + (n % 4) * 26;
    const pull = 1 - ease((this.age() - 1700) / 1100), x = Math.cos(a) * ring * pull, y = Math.sin(a) * ring * .7 * pull;
    return `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${n * 43 + this.age() / 6})`;
  }
  ash(n: number): string {
    const p = ease((this.ultHitAge() - n * 12) / 1100), x = (n % 6 - 2.5) * 18 + Math.sin(n * 4) * p * 60;
    return `translate(${x.toFixed(2)} ${(-20 - Math.floor(n / 6) * 37 - p * 130).toFixed(2)}) rotate(${n * 31 + p * 130})`;
  }
  cutOpacity(n: number): number {
    const age = this.age() - (1350 + n * 145);
    return this.reduced() ? 0 : ease(age / 35) * (1 - ease((age - 50) / 240));
  }
  ghostTransform(n: number): string {
    const d = this.actor() === 'left' ? 1 : -1;
    return `translate(${this.x(this.target()) - d * (180 - n * 120)} ${430 - n * 12}) scale(${d * .9} .9) translate(-108 -300)`;
  }
  moveLabel(): string {
    const turn = this.frame().turn; if (!turn) return this.t('phase.' + this.frame().phase);
    return this.t(turn.move === 'ultimate' ? 'ultimate.' + this.battle().fighters[turn.attacker] : turn.move === 'heal' ? 'heal.' + this.battle().fighters[turn.attacker] : turn.move === 'special' ? 'special.' + this.battle().fighters[turn.attacker] : 'move.' + turn.move);
  }
  impactText(): string {
    const turn = this.frame().turn; if (!turn) return '';
    return turn.move === 'heal' ? `+${turn.heal ?? 0}` : turn.damage === 0 ? this.t('defenseResult.' + this.battle().fighters[this.target()]) : `−${turn.damage}`;
  }
  clamp = clamp;
  ease = ease;
}
