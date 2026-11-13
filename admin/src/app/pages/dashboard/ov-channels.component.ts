import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminOverview } from '../../services/overview-api.service';
import { AvatarComponent } from '../../shared/avatar/avatar.component';
import { formatCredits, plural } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

/** The busiest channels of the last 24 hours; each row opens that channel's activity. */
@Component({
  selector: 'app-ov-channels',
  template: `
    <section class="lf-tile lf-tile--flush" aria-labelledby="ovc-heading" [attr.aria-busy]="!channels() || null">
      <div class="lf-tile__head">
        <h2 class="lf-h2" id="ovc-heading"><app-icon name="users" />Busiest channels</h2>
        <span class="lf-note">Last 24 hours</span>
      </div>
      @if (!channels()) {
        <div class="ovc-skel">
          @for (item of [1, 2, 3]; track item) {
            <app-skeleton height="2.75rem" />
          }
        </div>
      } @else if (rows().length) {
        <ul class="lf-rows">
          @for (row of rows(); track row.channelID) {
            <li>
              <a class="lf-row" [routerLink]="['/channels', row.channelID, 'activity']" data-busy-channel>
                <app-avatar [name]="row.name" [fetch]="false" />
                <span class="lf-row__main">
                  <span class="lf-row__title">{{ row.name }}</span>
                  <span class="lf-row__meta"
                    >{{ row.events }}
                    @if (row.problems) {
                      · <span class="ovc-problems">{{ row.problems }}</span>
                    }
                  </span>
                </span>
                <span class="lf-row__end">
                  <span class="ovc-credits">{{ row.credits }}</span>
                  <app-icon class="lf-row__chev" name="chevron" />
                </span>
              </a>
            </li>
          }
        </ul>
      } @else {
        <p class="lf-empty ovc-empty"><span>No channel has done anything in the last 24 hours yet.</span></p>
      }
    </section>
  `,
  styleUrl: './ov-channels.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AvatarComponent, IconComponent, SkeletonComponent],
})
export class OvChannelsComponent {
  /** Null while loading. */
  readonly channels = input<AdminOverview['topChannels'] | null>(null);

  readonly rows = computed(() =>
    (this.channels() ?? []).map((row) => ({
      channelID: row.channelID,
      name: row.channel || 'Channel without an account',
      events: plural(row.events, 'event'),
      problems: row.problems > 0 ? plural(row.problems, 'problem') : null,
      credits: row.credits > 0 ? formatCredits(row.credits, true) : 'No credits',
    })),
  );
}
