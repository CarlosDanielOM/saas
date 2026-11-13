import { ChangeDetectionStrategy, Component, OnInit, computed, input, output, signal } from '@angular/core';

import type { DecisionSummary } from '../../services/decisions-api.service';
import { DayBarsComponent, type DayBar } from '../day-bars/day-bars.component';
import { formatCreditValue, formatCredits, formatDuration, formatNumber, formatUSD, plural } from '../format';
import { IconComponent } from '../icon/icon.component';
import { modelName } from './decision-format';

/**
 * "Numbers for this range": reviews per day, per model and the busiest channels. Collapsed on phones so
 * the list stays first; open beside the list on desktop.
 */
@Component({
  selector: 'app-decisions-numbers',
  template: `
    <details class="lf-tile lf-tile--flush lf-more dn" [open]="startOpen()" data-decisions-numbers>
      <summary><span>Numbers for this range</span><app-icon name="down" /></summary>
      <div class="dn__body">
        <dl class="lf-dl dn__totals" data-numbers-totals>
          <div><dt>AI reviews</dt><dd>{{ count(summary().aiReviews) }}</dd></div>
          <div><dt>Rule hits</dt><dd>{{ count(summary().ruleHits) }}</dd></div>
          <div><dt>Provider cost</dt><dd>{{ formatUSD(summary().providerUSD) }}</dd></div>
          <div><dt>Charged to channels</dt><dd>{{ summary().credits > 0 ? formatCredits(summary().credits) + ' ' + formatCreditValue(summary().credits) : 'Nothing' }}</dd></div>
          @if (summary().latencyP95Ms > 0) {
            <div><dt>Slow reviews (1 in 20 took longer)</dt><dd>{{ formatDuration(summary().latencyP95Ms) }}</dd></div>
          }
        </dl>
        <section aria-labelledby="dn-days">
          <h3 id="dn-days" class="dn__h">Reviews per day <small>ban verdicts in colour · UTC days</small></h3>
          <app-day-bars [days]="days()" label="Messages reviewed per day" partLabel="ban verdicts" [format]="count" />
        </section>
        @if (summary().byModel.length) {
          <section aria-labelledby="dn-models">
            <h3 id="dn-models" class="dn__h">By model</h3>
            <ul class="lf-bars dn__list">
              @for (row of summary().byModel; track row.model) {
                <li class="lf-bars__row">
                  <span class="lf-bars__name">{{ modelName(row.model) }}<small>{{ modelLine(row) }}</small></span>
                  <span class="lf-bars__value">{{ formatUSD(row.providerUSD) }}<small>provider cost</small></span>
                </li>
              }
            </ul>
          </section>
        }
        @if (!fixed() && summary().byChannel.length) {
          <section aria-labelledby="dn-channels">
            <h3 id="dn-channels" class="dn__h">Busiest channels</h3>
            <ul class="lf-bars dn__list">
              @for (row of summary().byChannel; track row.channelID) {
                <li>
                  <button type="button" class="lf-bars__row dn__pick" (click)="channel.emit(row)" [attr.aria-label]="'Show only ' + (row.channel || 'this channel')" data-numbers-channel>
                    <span class="lf-bars__name">{{ row.channel || 'Unnamed channel' }}<small>{{ plural(row.reviews, 'review') }} · {{ plural(row.violations, 'ban verdict') }}</small></span>
                    <span class="lf-bars__value">{{ formatUSD(row.providerUSD) }}</span>
                    <span class="lf-bar" aria-hidden="true"><span [style.width.%]="share(row.reviews)"></span></span>
                  </button>
                </li>
              }
            </ul>
          </section>
        }
      </div>
    </details>
  `,
  styles: [
    `
      :host { display: block; min-width: 0; }
      .dn > summary { min-height: 3rem; padding-inline: 1rem; color: var(--fg); }
      .dn__body { display: grid; gap: 1rem; padding: 0 0 0.75rem; }
      .dn__totals { padding: 0 1rem; }
      .dn__body > section > app-day-bars { display: block; padding: 0 1rem; }
      .dn__h { margin: 0 0 0.35rem; padding: 0 1rem; font-size: 0.85rem; font-weight: 800; }
      .dn__h small { color: var(--muted); font-size: 0.74rem; font-weight: 600; }
      .dn__list { border-top: 1px solid var(--line); }
      .dn__pick { width: 100%; border: 0; border-top: 1px solid var(--line); background: none; font: inherit; text-align: left; cursor: pointer; }
      .dn__list > li:first-child > .dn__pick { border-top: 0; }
      .dn__pick:hover { background: var(--tile-2); }
      @media (min-width: 640px) {
        .dn > summary, .dn__h, .dn__totals, .dn__body > section > app-day-bars { padding-inline: 1.25rem; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DayBarsComponent, IconComponent],
})
export class DecisionsNumbersComponent implements OnInit {
  readonly summary = input.required<DecisionSummary>();
  readonly fixed = input(false);
  readonly channel = output<{ channelID: string; channel: string | null }>();

  readonly startOpen = signal(false);
  readonly modelName = modelName;
  readonly formatUSD = formatUSD;
  readonly formatCredits = formatCredits;
  readonly formatCreditValue = formatCreditValue;
  readonly formatDuration = formatDuration;
  readonly plural = plural;
  readonly count = (value: number) => formatNumber(value);

  readonly days = computed<DayBar[]>(() => this.summary().daily.map((day) => ({ date: day.date, value: day.reviews, part: day.violations })));
  private readonly busiest = computed(() => Math.max(1, ...this.summary().byChannel.map((row) => row.reviews)));

  ngOnInit(): void {
    // Open beside the list on desktop; on phones it stays one tap away so the list comes first.
    this.startOpen.set(typeof matchMedia === 'function' && matchMedia('(min-width: 960px)').matches);
  }

  share(reviews: number): number {
    return (reviews / this.busiest()) * 100;
  }

  modelLine(row: DecisionSummary['byModel'][number]): string {
    const parts = [plural(row.reviews, 'review'), plural(row.bans, 'ban')];
    if (row.notReviewed) parts.push(`${formatNumber(row.notReviewed)} not reviewed`);
    if (row.latencyP50Ms > 0) parts.push(`typical ${formatDuration(row.latencyP50Ms)}`);
    return parts.join(' · ');
  }
}
