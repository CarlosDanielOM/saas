import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../../../services/language.service';
import { DuelFighterComponent } from './duel-fighter.component';
import { DuelBattle, DuelMove, DuelSide, DuelTurn, MAX_HP, MOVES, legacyBattle, otherSide } from './duel-battle';
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
    return turn && this.elapsed() < turn.at + MOVES[turn.move].duration ? turn : null;
  });
  readonly impact = computed(() => {
    const turn = this.currentTurn(), time = this.elapsed();
    return turn && time >= turn.hitAt && time < turn.hitAt + IMPACT_MS ? turn : null;
  });
  readonly health = computed(() => {
    const health = { left: MAX_HP, right: MAX_HP };
    if (this.started()) for (const turn of this.battle().turns) {
      if (this.elapsed() >= turn.hitAt) health[otherSide(turn.attacker)] = Math.max(0, health[otherSide(turn.attacker)] - turn.damage);
    }
    return health;
  });
  readonly winnerName = computed(() => this.names()[this.winner()]);

  t(key:string, params?:Record<string,string|number>):string { return this.language.translate('duelMock.'+key,params,this.locale()); }
  action(side: DuelSide): string {
    if (!this.started()) return 'idle';
    if (this.health()[side] === 0) return 'defeated';
    if (this.phase() === 'winner' && side === this.winner()) return 'victory';
    const turn = this.currentTurn();
    if (!turn) return 'idle';
    if (turn.attacker === side) return 'attack';
    return this.elapsed() >= turn.hitAt ? 'hit' : 'idle';
  }
  /** Changes whenever a one-shot animation must restart (e.g. two attacks in a row). */
  actionKey(side: DuelSide): string {
    const action = this.action(side);
    return action === 'attack' || action === 'hit' ? `${action}-${this.turnIndex()}` : action;
  }
  move(side: DuelSide): DuelMove {
    // An attacker shows its own move; a defender reacts to the incoming one.
    return this.currentTurn()?.move ?? (this.health()[side] === 0 ? this.battle().turns.at(-1)?.move ?? 'normal' : 'normal');
  }
  low(side: DuelSide): boolean { return this.started() && this.health()[side] > 0 && this.health()[side] <= 30; }
  attacking(side: DuelSide): boolean { return this.phase() === 'fight' && this.currentTurn()?.attacker === side; }
  target(turn: DuelTurn): DuelSide { return otherSide(turn.attacker); }
  /** Callout for heavy and special moves; specials are named per character. */
  moveName(turn: DuelTurn): string {
    return turn.move === 'special' ? this.t('special.' + this.battle().fighters[turn.attacker]) : this.t('move.' + turn.move);
  }
}
