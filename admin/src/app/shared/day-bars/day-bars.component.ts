import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { shortDay } from '../format';

export interface DayBar {
  /** `YYYY-MM-DD` (a UTC day from the API). */
  date: string;
  value: number;
  /** A second, smaller number drawn inside the bar in the warning colour (e.g. problems out of events). */
  part?: number;
}

/**
 * A small bar per day. Tap or focus a bar to read its day and value; with nothing picked it shows the
 * newest day. For "how did this move over the last weeks", not for exact comparison: lists do that.
 */
@Component({
  selector: 'app-day-bars',
  template: `
    <figure class="days" [attr.aria-label]="label() + ': ' + summary()">
      <figcaption class="days__read" aria-live="polite">
        <b>{{ format()(shown().value) }}</b>
        @if (shown().part && partLabel()) {
          <span class="days__part">{{ format()(shown().part!) }} {{ partLabel() }}</span>
        }
        <span>{{ day(shown().date) }}</span>
      </figcaption>
      <div class="days__bars" role="list">
        @for (bar of bars(); track bar.date) {
          <button
            type="button"
            role="listitem"
            class="days__bar"
            [class.is-picked]="bar.date === shown().date"
            [attr.aria-label]="day(bar.date) + ': ' + format()(bar.value)"
            (click)="picked.set(bar.date)"
            (focus)="picked.set(bar.date)"
          >
            <span class="days__fill" [style.height.%]="bar.height"><span class="days__warn" [style.height.%]="bar.partHeight"></span></span>
          </button>
        }
      </div>
      <div class="days__axis" aria-hidden="true">
        <span>{{ first() }}</span><span>{{ last() }}</span>
      </div>
    </figure>
  `,
  styleUrl: './day-bars.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DayBarsComponent {
  /** Oldest first. */
  readonly days = input.required<DayBar[]>();
  /** What the bars count, for screen readers: "AI cost per day". */
  readonly label = input.required<string>();
  readonly format = input<(value: number) => string>((value) => String(Math.round(value)));
  /** Name of `part`, e.g. "problems". */
  readonly partLabel = input('');

  readonly picked = signal<string | null>(null);
  readonly bars = computed(() => {
    const max = Math.max(0, ...this.days().map((bar) => bar.value));
    return this.days().map((bar) => ({
      ...bar,
      // An empty day keeps a hairline so the row of days still reads as a timeline.
      height: max > 0 ? Math.max(bar.value > 0 ? 4 : 1.5, (bar.value / max) * 100) : 1.5,
      partHeight: bar.value > 0 && bar.part ? Math.min(100, (bar.part / bar.value) * 100) : 0,
    }));
  });
  readonly shown = computed<DayBar>(() => {
    const days = this.days();
    return days.find((bar) => bar.date === this.picked()) ?? days[days.length - 1] ?? { date: '', value: 0 };
  });
  readonly first = computed(() => this.day(this.days()[0]?.date ?? ''));
  readonly last = computed(() => this.day(this.days()[this.days().length - 1]?.date ?? ''));
  readonly summary = computed(() => {
    const days = this.days();
    if (!days.length) return 'no data';
    const total = days.reduce((sum, bar) => sum + bar.value, 0);
    return `${days.length} days from ${this.first()} to ${this.last()}, ${this.format()(total)} in total`;
  });

  day(date: string): string {
    return date ? shortDay(date) : '';
  }
}
