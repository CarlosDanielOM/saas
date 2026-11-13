import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { AdminOverview } from '../../services/overview-api.service';
import { DayBar, DayBarsComponent } from '../../shared/day-bars/day-bars.component';
import { formatCredits, formatNumber } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';

/** "Last 14 days": what Dima did per day (problems inside each bar) and the credits charged per day. */
@Component({
  selector: 'app-ov-trend',
  template: `
    <section class="lf-tile ovt" aria-labelledby="ovt-heading" [attr.aria-busy]="!daily() || null">
      <h2 class="lf-h2" id="ovt-heading"><app-icon name="chart" />Last 14 days</h2>
      @if (daily()) {
        <div class="ovt-charts">
          <div class="ovt-chart" data-trend="activity">
            <h3 class="ovt-h3">Activity <span class="ovt-key"><i></i>didn't go as planned</span></h3>
            <app-day-bars [days]="events()" label="Things Dima did per day" partLabel="didn't go as planned" [format]="number" />
          </div>
          <div class="ovt-chart" data-trend="spend">
            <h3 class="ovt-h3">Credits charged</h3>
            <app-day-bars [days]="credits()" label="Credits charged per day" [format]="creditsLabel" />
          </div>
        </div>
      } @else {
        <app-skeleton height="6rem" /><app-skeleton height="6rem" />
      }
    </section>
  `,
  styleUrl: './ov-trend.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DayBarsComponent, IconComponent, SkeletonComponent],
})
export class OvTrendComponent {
  /** Null while loading. Oldest first. */
  readonly daily = input<AdminOverview['daily'] | null>(null);

  readonly events = computed<DayBar[]>(() => (this.daily() ?? []).map((day) => ({ date: day.date, value: day.events, part: day.problems })));
  readonly credits = computed<DayBar[]>(() => (this.daily() ?? []).map((day) => ({ date: day.date, value: day.credits })));

  readonly number = (value: number) => formatNumber(value);
  readonly creditsLabel = (value: number) => formatCredits(value, true);
}
