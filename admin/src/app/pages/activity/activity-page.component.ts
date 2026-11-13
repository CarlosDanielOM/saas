import { ChangeDetectionStrategy, Component } from '@angular/core';

import { FeedExplorerComponent } from '../../shared/feed/feed-explorer.component';

/** "What just happened?": everything the bot did and heard, for every channel, one streamer or one viewer. */
@Component({
  selector: 'app-activity-page',
  templateUrl: './activity-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FeedExplorerComponent],
})
export class ActivityPageComponent {}
