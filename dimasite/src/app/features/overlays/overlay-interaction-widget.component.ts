import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OverlayInteractionComponent } from './overlay-interaction.component';
import { interactionDesign, type InteractionState } from './overlay-interaction.model';
import type { WidgetRenderContext } from './overlay-widget-module';

@Component({
  selector: 'app-overlay-interaction-widget',
  imports: [OverlayInteractionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: ':host { display:block; width:100%; height:100% }',
  template: `<app-overlay-interaction [state]="state()" [design]="design()" [preview]="context().preview" [clockOffset]="context().clockOffset" />`
})
export class OverlayInteractionWidgetComponent {
  readonly context = input.required<WidgetRenderContext>();
  readonly design = computed(() => interactionDesign(this.context().widget));
  readonly state = computed(() => {
    const state = this.context().state;
    // An unavailable or incompatible adapter must leave its placement empty.
    return isInteractionState(state, this.context().widget.kind) ? state : null;
  });
}
function isInteractionState(state: unknown, kind: string): state is InteractionState {
  if (!state || typeof state !== 'object') return false;
  const value = state as Partial<InteractionState>;
  return value.kind === kind && typeof value.title === 'string' && typeof value.phase === 'string'
    && Array.isArray(value.choices) && value.choices.every(choice => choice && typeof choice.id === 'string'
      && typeof choice.title === 'string' && Number.isFinite(choice.votes) && Number.isFinite(choice.points) && Number.isFinite(choice.users));
}
