import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DuelCharacter, DuelMove } from '../duel-battle';
let fighterId = 0;
/** Mock-owned HD redraw of the original articulated vector cast. */
@Component({
  selector: 'app-duel-astra-fighter',
  templateUrl: './duel-astra-fighter.component.html',
  styleUrl: './duel-astra-fighter.component.css',
  host: { '[attr.data-side]': 'side()', '[attr.data-character]': 'character()', '[attr.data-action]': 'action()', '[attr.data-move]': 'move()', '[attr.data-low]': 'low()', '[attr.data-enraged]': 'enraged()', '[attr.data-paused]': 'paused()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelAstraFighterComponent {
  readonly uid = `astra-fighter-${fighterId++}`;
  readonly side = input.required<'left' | 'right'>();
  readonly character = input<DuelCharacter>('knight');
  readonly action = input('idle');
  readonly move = input<DuelMove | 'ultimate'>('normal');
  readonly low = input(false);
  readonly enraged = input(false);
  readonly paused = input(false);
  paint(name: string): string { return `url(#${this.uid}-${name})`; }
}
