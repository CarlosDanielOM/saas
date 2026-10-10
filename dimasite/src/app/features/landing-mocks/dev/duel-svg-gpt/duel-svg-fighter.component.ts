import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DuelCharacter, DuelSide } from '../../../widgets/duel/duel-battle';
import { VectorPose } from './duel-svg-motion';

/** Original ink illustrations; every joint is posed by the shared battle time. */
@Component({
  selector: 'g[duel-svg-fighter]',
  templateUrl: './duel-svg-fighter.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-class]': 'character()', '[attr.data-side]': 'side()' },
})
export class DuelSvgFighterComponent {
  readonly character = input.required<DuelCharacter>();
  readonly side = input.required<DuelSide>();
  readonly pose = input.required<VectorPose>();
  readonly enraged = input(false);
  joint(angle: number, x: number, y: number): string { return `rotate(${angle.toFixed(2)} ${x} ${y})`; }
  shieldArm(): string { const q = this.pose().guard; return `M78 140L${55+q*90} ${172-q*25} ${64+q*117} ${191-q*24}`; }
  shieldTransform(): string { const q = this.pose().guard; return `translate(${q*120} ${-q*24})`; }
}
