import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { FeedExplorerComponent } from '../../shared/feed/feed-explorer.component';
import { IconComponent } from '../../shared/icon/icon.component';

/**
 * A channel's Activity tab: the same feed as `/activity`, fixed to this channel. The channel workspace
 * draws the header and tabs; this starts at the answer line.
 */
@Component({
  selector: 'app-channel-activity',
  template: `
    @if (channelID(); as channelID) {
      <div class="lf-main">
        <app-feed-explorer [channelID]="channelID">
          <a feedTools class="ca-tools" routerLink="/observability" [queryParams]="{ channel: channelID, tab: 'logs' }" data-channel-logs
            ><app-icon name="pulse" />Errors and slow calls for this channel<app-icon name="chevron"
          /></a>
        </app-feed-explorer>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        /* The workspace's tab strip sticks under the top bar: the filter bar sticks under both. */
        --fx-sticky-top: calc(var(--nav-h) + var(--ws-bar-h, 2.75rem + 1px));
      }
      .ca-tools { display: inline-flex; flex: 0 1 auto; align-items: center; gap: 0.4rem; min-height: 2.75rem; min-width: 0; line-height: 1.3; color: var(--accent); font-size: 0.88rem; font-weight: 700; }
      .ca-tools:hover { text-decoration: underline; text-underline-offset: 3px; }
      .ca-tools app-icon { flex-shrink: 0; width: 1rem; height: 1rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FeedExplorerComponent, IconComponent, RouterLink],
})
export class ChannelActivityComponent {
  readonly channelID = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('channelID'))), { initialValue: null });
}
