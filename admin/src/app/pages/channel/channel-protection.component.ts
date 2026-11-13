import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { DecisionsExplorerComponent } from '../../shared/decisions/decisions-explorer.component';

/**
 * A channel's Protection tab: the decisions explorer with this channel fixed. The channel frame (header and
 * tabs) belongs to the parent, so this renders only its own content and no page heading.
 */
@Component({
  selector: 'app-channel-protection',
  template: `
    <div class="lf-main cp">
      @for (id of [channelID()]; track id) {
        @if (id) {
          <app-decisions-explorer [channelID]="id" />
        }
      }
    </div>
  `,
  styles: [':host { display: block; } .cp { padding-top: 0.75rem; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecisionsExplorerComponent],
})
export class ChannelProtectionComponent {
  private readonly route = inject(ActivatedRoute);
  /** Re-creating the explorer per channel keeps one channel's list and sheet from showing under another. */
  readonly channelID = toSignal(this.route.paramMap.pipe(map((params) => params.get('channelID'))), { initialValue: null });
}
