import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { AssistantMascotComponent } from './mascot/assistant-mascot.component';
import { AssistantPanelComponent } from './panel/assistant-panel.component';

/**
 * Mounted once by the logged-in layout. The panel loads `GET /agent/:channelID/status` and turns
 * the assistant on through AssistantPresenceService; the mascot stays hidden until then.
 */
@Component({
  selector: 'app-assistant-root',
  imports: [AssistantMascotComponent, AssistantPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-assistant-panel [streamer]="streamer()" />
    <app-assistant-mascot />
  `,
  styles: `:host { display: contents; }`,
})
export class AssistantRootComponent {
  /** Login from the URL (`/:streamer/...`). */
  readonly streamer = input.required<string>();
}
