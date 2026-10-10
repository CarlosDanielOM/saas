import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../../../services/language.service';
import { DuelFighterComponent } from './duel-fighter.component';
import type { DuelRecord } from './duel-api.service';
import { COMBO_HEAL, DuelBattle, DuelMove, DuelSide, DuelTurn, HEAL, MAX_HP, legacyBattle, otherSide, turnLength } from './duel-battle';
type Phase = 'ready' | 'entrance' | 'countdown' | 'fight' | 'knockout' | 'winner';
/** How long the damage number, sparks and screen shake stay after a hit lands. */
const IMPACT_MS = 650;
@Component({selector:'app-duel-arena', imports:[DuelFighterComponent], templateUrl:'./duel-arena.component.html', styleUrl:'./duel-arena.component.css', changeDetection:ChangeDetectionStrategy.OnPush})
export class DuelArenaComponent {
  readonly language = inject(LanguageService);
  readonly names = input({left:'Dima',right:'ChatChampion'});
  readonly battle = input<DuelBattle>(legacyBattle('left'));
  readonly elapsed = input(0);
  readonly started = input(false);
  readonly paused = input(false);
  readonly transparent = input(false);
  readonly locale = input<'en'|'es'>('en');
  /** Head-to-head wins before this fight; only tracked overlay duels have one. */
  readonly record = input<DuelRecord | null>(null);
  readonly sides: DuelSide[] = ['left','right'];
  readonly winner = computed(() => this.battle().winner);
  readonly finalHit = computed(() => this.battle().turns.at(-1)?.hitAt ?? 0);
  readonly phase = computed<Phase>(() => {
    const time = this.elapsed();
    if (!this.started()) return 'ready';
    if (time < 1300) return 'entrance';
    if (time < 3400) return 'countdown';
    if (time < this.finalHit()) return 'fight';
    if (time < this.battle().duration) return 'knockout';
    return 'winner';
  });
  readonly countdown = computed(() => Math.max(1, 3 - Math.floor((this.elapsed() - 1300) / 700)));
  /** Index of the latest turn that has started, or -1 before the first one. */
  readonly turnIndex = computed(() => {
    if (!this.started()) return -1;
    const time = this.elapsed(), turns = this.battle().turns;
    let index = -1;
    while (index + 1 < turns.length && turns[index + 1].at <= time) index++;
    return index;
  });
  /** The turn being animated, until its attacker has recovered. */
  readonly currentTurn = computed<DuelTurn | null>(() => {
    const turn = this.battle().turns[this.turnIndex()];
    return turn && this.elapsed() < turn.at + turnLength(turn) ? turn : null;
  });
  readonly impact = computed(() => {
    const turn = this.currentTurn(), time = this.elapsed();
    return turn && time >= turn.hitAt && time < turn.hitAt + IMPACT_MS ? turn : null;
  });
  /** A block that chains into a heal: shown right after the block lands. */
  readonly comboImpact = computed(() => {
    const turn = this.currentTurn(), time = this.elapsed(), at = turn ? turn.hitAt + COMBO_HEAL.delay : 0;
    return turn?.comboHeal && time >= at && time < at + COMBO_HEAL.extra + 200 ? turn : null;
  });
  readonly health = computed(() => {
    const health = { left: MAX_HP, right: MAX_HP };
    if (this.started()) for (const turn of this.battle().turns) {
      if (this.elapsed() < turn.hitAt) break;
      if (turn.move === 'heal') health[turn.attacker] = Math.min(MAX_HP, health[turn.attacker] + (turn.heal ?? 0));
      else {
        const defender = otherSide(turn.attacker);
        health[defender] = Math.max(0, health[defender] - turn.damage);
        if (turn.comboHeal && this.elapsed() >= turn.hitAt + COMBO_HEAL.delay) health[defender] = Math.min(MAX_HP, health[defender] + turn.comboHeal);
      }
    }
    return health;
  });
  readonly charges = Array.from({ length: HEAL.perFighter }, (_, index) => index);
  /** A heal charge is spent as soon as the fighter starts healing, or when its block chains into a heal. */
  readonly healsLeft = computed(() => {
    const left = { left: HEAL.perFighter, right: HEAL.perFighter }, time = this.elapsed();
    if (this.started()) for (const turn of this.battle().turns) {
      if (turn.move === 'heal' && turn.at <= time) left[turn.attacker]--;
      if (turn.comboHeal && turn.hitAt <= time) left[otherSide(turn.attacker)]--;
    }
    return left;
  });
  readonly winnerName = computed(() => this.names()[this.winner()]);
  /** Big over the floor while the fighters walk in, then it flies between the health bars. */
  readonly rivalryStage = computed(() => this.phase() === 'entrance' || this.phase() === 'countdown' ? 'intro' : 'hud');
  /** The record counts this fight once the winner is revealed. */
  readonly score = computed<DuelRecord>(() => {
    const record = this.record() ?? { left: 0, right: 0 }, winner = this.winner();
    return this.phase() === 'winner' ? { ...record, [winner]: record[winner] + 1 } : record;
  });
  readonly rivalryLine = computed(() => {
    const score = this.score(), names = this.names(), winner = this.winner();
    if (score.left === score.right) return this.t('rivalryTied', { a: score.left, b: score.right });
    const leader: DuelSide = score.left > score.right ? 'left' : 'right';
    return this.t(leader === winner ? 'rivalryLeads' : 'rivalryStillLeads', { name: names[leader], a: score[leader], b: score[otherSide(leader)] });
  });

  t(key:string, params?:Record<string,string|number>):string { return this.language.translate('duelMock.'+key,params,this.locale()); }
  action(side: DuelSide): string {
    if (!this.started()) return 'idle';
    if (this.health()[side] === 0) return 'defeated';
    if (this.phase() === 'winner' && side === this.winner()) return 'victory';
    const turn = this.currentTurn();
    if (!turn) return 'idle';
    if (turn.attacker === side) return turn.move === 'heal' ? 'heal' : 'attack';
    if (turn.move === 'heal') return 'idle';
    // A defender with a skill reacts during the attacker's windup; a special
    // breaks through, so the defender is hit when it lands.
    if (turn.defended && this.elapsed() >= turn.at + (turn.hitAt - turn.at) * .4 && (turn.move !== 'special' || this.elapsed() < turn.hitAt)) return 'defend';
    return this.elapsed() >= turn.hitAt ? 'hit' : 'idle';
  }
  /** Changes whenever a one-shot animation must restart (e.g. two attacks in a row). */
  actionKey(side: DuelSide): string {
    const action = this.action(side);
    return action === 'attack' || action === 'hit' || action === 'defend' || action === 'heal' ? `${action}-${this.turnIndex()}` : action;
  }
  move(side: DuelSide): DuelMove | 'ultimate' {
    // An attacker shows its own move; a defender reacts to the incoming one.
    const move = this.currentTurn()?.move ?? (this.health()[side] === 0 ? this.battle().turns.at(-1)?.move ?? 'normal' : 'normal');
    return move === 'heal' ? 'normal' : move;
  }
  low(side: DuelSide): boolean { return this.started() && this.health()[side] > 0 && this.health()[side] <= 30; }
  attacking(side: DuelSide): boolean { return this.phase() === 'fight' && this.currentTurn()?.attacker === side; }
  target(turn: DuelTurn): DuelSide { return otherSide(turn.attacker); }
  /** Defended normal hits shake nothing; everything else shakes by move weight. */
  readonly shake = computed(() => { const hit = this.impact(); return !hit || this.held(hit) || hit.move === 'heal' ? null : hit.crit ? 'crit' : hit.move; });
  /** The final turn when it is an ultimate: its cinematic runs on through the knockout. */
  readonly ultimate = computed(() => {
    const turn = this.battle().turns.at(-1);
    return turn?.move === 'ultimate' && this.started() && this.elapsed() >= turn.at ? turn : null;
  });
  /** The fighter an ultimate destroys, named by the attacker's character. */
  doom(side: DuelSide): string | null { const turn = this.ultimate(); return turn && this.target(turn) === side ? this.battle().fighters[turn.attacker] : null; }
  /** The Ronin's ultimate cuts the defender in two once the blow lands. */
  split(side: DuelSide): boolean { const turn = this.ultimate(); return this.doom(side) === 'ronin' && !!turn && this.elapsed() >= turn.hitAt; }
  /** Angles of the Ronin's Thousand Cuts. */
  readonly cuts = [-32, 18, -70, 55, 5, -48, 78, -12, 36, -84];
  /** The defender's skill held (normal/heavy); against a special it shatters instead. */
  held(turn: DuelTurn): boolean { return !!turn.defended && turn.move !== 'special'; }
  shattered(turn: DuelTurn): boolean { return !!turn.defended && turn.move === 'special'; }
  brokenResult(turn: DuelTurn): string { return this.t('skillBroken.' + this.battle().fighters[this.target(turn)]); }
  /** The streamer's side fights enraged (doubled odds, flames, red eyes). */
  enraged(side: DuelSide): boolean { return this.battle().enraged === side; }
  comboOn(side: DuelSide): boolean { const combo = this.comboImpact(); return !!combo && this.target(combo) === side; }
  /** Green flash on the HP bar of a fighter that has just healed. */
  healing(side: DuelSide): boolean {
    const turn = this.impact();
    return turn?.move === 'heal' && turn.attacker === side || this.comboOn(side);
  }
  skillName(turn: DuelTurn): string { return this.t('skill.' + this.battle().fighters[this.target(turn)]); }
  defenseResult(turn: DuelTurn): string { return this.t('defenseResult.' + this.battle().fighters[this.target(turn)]); }
  /** Healing signs rising around the fighter: runes for the Mage, crosses otherwise. */
  glyphs(turn: DuelTurn): string[] { return this.battle().fighters[turn.attacker] === 'mage' ? ['ᚱ','✚','ᛉ','✚','ᛟ','✚'] : ['✚','✚','✚','✚','✚','✚']; }
  /** Callout for heavy and special moves; specials are named per character. */
  moveName(turn: DuelTurn): string {
    const character = this.battle().fighters[turn.attacker];
    return turn.move === 'special' ? this.t('special.' + character) : turn.move === 'heal' ? this.t('heal.' + character) : this.t('move.' + turn.move);
  }
}
