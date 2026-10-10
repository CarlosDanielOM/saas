import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { COMBO_HEAL, DuelBattle, DuelSide, otherSide } from '../../../widgets/duel/duel-battle';
import { DuelSvgFighterComponent } from './duel-svg-fighter.component';
import { baseX, clamp, ease, staffTip, vectorFrame, VectorFrame, VectorPose } from './duel-svg-motion';

/** Ordinary combat shares the arena's 30 Hz clock, including particles and spell travel. */
@Component({
  selector: 'g[duel-svg-combat]',
  imports: [DuelSvgFighterComponent],
  templateUrl: './duel-svg-combat.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DuelSvgCombatComponent {
  readonly frame = input.required<VectorFrame>();
  readonly battle = input.required<DuelBattle>();
  readonly reduced = input(false);
  readonly layer = input<'back' | 'front'>('front');
  readonly seeds = Array.from({ length: 12 }, (_, i) => i);
  readonly sides: DuelSide[] = ['left', 'right'];
  readonly turn = computed(() => this.frame().turn);
  readonly actor = computed(() => this.turn()?.attacker ?? 'left');
  readonly target = computed(() => otherSide(this.actor()));
  readonly character = computed(() => this.battle().fighters[this.actor()]);
  readonly dir = computed(() => this.actor() === 'left' ? 1 : -1);
  readonly hit = computed(() => this.turn() ? this.frame().time - this.turn()!.hitAt : -1);
  readonly contact = computed(() => ({ x: baseX(this.target()) - this.dir() * 58, y: 329 }));
  readonly color = computed(() => this.character() === 'knight' ? '#f2d5a0' : this.character() === 'mage' ? '#c5a6ff' : '#f199ad');
  readonly travel = computed(() => this.turn()?.move === 'special' ? 400 : this.turn()?.move === 'heavy' ? 240 : 180);
  readonly origin = computed(() => {
    const t = this.turn();
    return t ? staffTip(vectorFrame(this.battle(), t.hitAt - this.travel(), true).poses[t.attacker], t.attacker) : { x: 480, y: 250 };
  });
  readonly bolt = computed(() => {
    const progress = clamp((this.hit() + this.travel()) / this.travel()), origin = this.origin(), contact = this.contact();
    const meteor = this.turn()?.move === 'special';
    const from = meteor ? { x: contact.x - this.dir() * 165, y: 75 } : origin;
    return { x: from.x + (contact.x - from.x) * progress, y: from.y + (contact.y - from.y) * progress,
      angle: Math.atan2(contact.y - from.y, contact.x - from.x) * 180 / Math.PI };
  });
  readonly boltOpacity = computed(() => this.hit() < -this.travel() ? 0 : (1 - ease(this.hit() / 110)));
  readonly cutOpacity = computed(() => ease((this.hit() + 65) / 65) * (1 - ease((this.hit() - 35) / 300)));
  readonly charge = computed(() => {
    const t = this.turn(); return t ? ease(this.frame().age / (t.hitAt - t.at)) * (1 - ease(this.hit() / 100)) : 0;
  });
  readonly healer = computed<DuelSide | null>(() => {
    const t = this.turn(); if (!t) return null;
    if (t.move === 'heal') return t.attacker;
    return t.comboHeal && this.hit() >= COMBO_HEAL.delay - 150 && this.hit() < COMBO_HEAL.delay + 700 ? otherSide(t.attacker) : null;
  });
  readonly healAge = computed(() => this.turn()?.move === 'heal' ? this.frame().age : (this.hit() - COMBO_HEAL.delay + 150) / 850 * 1500);
  readonly healing = computed(() => ease(this.healAge() / 240) * (1 - ease((this.healAge() - 1050) / 450)));
  readonly renewal = computed(() => ease((this.healAge() - 750) / 150) * (1 - ease((this.healAge() - 900) / 450)));
  readonly healCharacter = computed(() => this.healer() ? this.battle().fighters[this.healer()!] : 'knight');

  position(side: DuelSide, y = 329): string { return `translate(${this.frame().poses[side].x.toFixed(2)} ${y})`; }
  transform(p: VectorPose, side: DuelSide): string { return `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) rotate(${p.rotation.toFixed(2)}) scale(${side === 'left' ? .9 : -.9} .9) translate(-108 -300)`; }
  ghostPose(side: DuelSide, n: number): VectorPose { const p = this.frame().poses[side]; return { ...p, x: baseX(side) - (side === 'left' ? 1 : -1) * n * 32, opacity: 1, guard: 0 }; }
  dashGhost(n: number): VectorPose {
    const t = this.turn()!, p = vectorFrame(this.battle(), Math.max(t.at, this.frame().time - (n + 1) * 38), true).poses[t.attacker];
    return { ...p, opacity: 1 };
  }
  spark(n: number): string {
    const t = clamp(this.hit() / 500), angle = n * 2.399, distance = 12 + t * (32 + n % 4 * 13);
    return `translate(${(Math.cos(angle) * distance).toFixed(2)} ${(Math.sin(angle) * distance * .8 + t * t * 32).toFixed(2)}) rotate(${angle * 180 / Math.PI}) scale(${1 - t})`;
  }
  mote(n: number): string {
    const p = clamp((this.healAge() - n * 24) / 1200), angle = n * 2.399 + p * 2.5;
    const radius = (this.healCharacter() === 'mage' ? 83 * (1 - p) : 55) + n % 3 * 9;
    return `translate(${(Math.cos(angle) * radius).toFixed(2)} ${(-15 - p * 135 + Math.sin(angle) * 15).toFixed(2)}) rotate(${n * 30})`;
  }
  fragment(n: number): string {
    const q = ease(this.hit() / 550), angle = n * Math.PI / 3;
    return `translate(${(Math.cos(angle) * (86 + q * 65)).toFixed(2)} ${(Math.sin(angle) * (86 + q * 65) + q * q * 35).toFixed(2)}) rotate(${n * 60 + q * 110})`;
  }
  baseTargetX(): number { return baseX(this.target()); }
  readonly Math = Math;
  clamp = clamp;
  ease = ease;
  staffTip = staffTip;
}
