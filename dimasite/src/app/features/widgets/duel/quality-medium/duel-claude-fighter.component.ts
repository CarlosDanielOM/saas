import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DuelCharacter, DuelMove } from '../duel-battle';

let nextId = 0;

/**
 * High-detail redraw of the original duel fighters on the same 220×240 rig and pivots,
 * with shaded gradients, rim light and separate legs/upper body so attacks can wind up,
 * hold on contact and follow through. Gradient ids are per instance because both
 * fighters may be the same class in different colors.
 */
@Component({
  selector: 'app-duel-claude-fighter',
  templateUrl: './duel-claude-fighter.component.html',
  styleUrl: './duel-claude-fighter.component.css',
  host: { '[attr.data-side]': 'side()', '[attr.data-character]': 'character()', '[attr.data-action]': 'action()', '[attr.data-move]': 'move()', '[attr.data-low]': 'low()', '[attr.data-enraged]': 'enraged()', '[attr.data-paused]': 'paused()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DuelClaudeFighterComponent {
  readonly side = input.required<'left' | 'right'>();
  readonly character = input<DuelCharacter>('knight');
  readonly action = input('idle');
  readonly move = input<DuelMove | 'ultimate'>('normal');
  readonly low = input(false);
  readonly enraged = input(false);
  readonly paused = input(false);
  readonly id = `dcf${++nextId}`;
  u(name: string): string { return `url(#${this.id}-${name})`; }
}
