import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../../../services/language.service';
import { DuelFighterComponent } from './duel-fighter.component';
type Side = 'left' | 'right';
type Phase = 'ready' | 'entrance' | 'countdown' | 'fight' | 'knockout' | 'winner';
interface Hit { at: number; attacker: Side; damage: number }
const END = 11400;
@Component({selector:'app-duel-arena', imports:[DuelFighterComponent], templateUrl:'./duel-arena.component.html', styleUrl:'./duel-arena.component.css', changeDetection:ChangeDetectionStrategy.OnPush})
export class DuelArenaComponent {
  readonly language = inject(LanguageService);
  readonly names = input({left:'Dima',right:'ChatChampion'});
  readonly chosenWinner = input<Side>('left');
  readonly elapsed = input(0);
  readonly started = input(false);
  readonly paused = input(false);
  readonly transparent = input(false);
  readonly locale = input<'en'|'es'>('en');
  readonly sides: Side[] = ['left','right'];
  readonly phase = computed<Phase>(() => {
    const time = this.elapsed();
    if (!this.started()) return 'ready';
    if (time < 1300) return 'entrance';
    if (time < 3400) return 'countdown';
    if (time < 9500) return 'fight';
    if (time < END) return 'knockout';
    return 'winner';
  });
  readonly active = computed(() => this.started() && this.elapsed() < END);
  readonly countdown = computed(() => Math.max(1, 3 - Math.floor((this.elapsed() - 1300) / 700)));
  readonly hits = computed<Hit[]>(() => {
    const winner = this.chosenWinner();
    const loser: Side = winner === 'left' ? 'right' : 'left';
    return [
      { at: 3600, attacker: winner, damage: 18 },
      { at: 4650, attacker: loser, damage: 22 },
      { at: 5700, attacker: winner, damage: 24 },
      { at: 6750, attacker: loser, damage: 19 },
      { at: 7800, attacker: winner, damage: 26 },
      { at: 9050, attacker: winner, damage: 32 }
    ];
  });
  readonly currentHit = computed(() => this.hits().find(hit => this.elapsed() >= hit.at && this.elapsed() < hit.at + 700));
  readonly impact = computed(() => {
    const hit = this.currentHit();
    return hit && this.elapsed() >= hit.at + 280 && this.elapsed() < hit.at + 620 ? hit : null;
  });
  readonly health = computed(() => {
    const health = { left: 100, right: 100 };
    if (this.started()) for (const hit of this.hits()) {
      if (this.elapsed() >= hit.at + 280) health[hit.attacker === 'left' ? 'right' : 'left'] -= hit.damage;
    }
    return health;
  });
  readonly winnerName = computed(() => this.names()[this.chosenWinner()]);
  readonly progress = computed(() => this.elapsed() / END * 100);

  t(key:string, params?:Record<string,string|number>):string { return this.language.translate('duelMock.'+key,params,this.locale()); }
  action(side: Side): string {
    if (!this.started()) return 'idle';
    if (this.health()[side] === 0) return 'defeated';
    if (this.phase() === 'winner' && side === this.chosenWinner()) return 'victory';
    const hit = this.currentHit();
    if (!hit) return 'idle';
    if (hit.attacker === side) return 'attack';
    return this.elapsed() >= hit.at + 280 ? 'hit' : 'idle';
  }

}
