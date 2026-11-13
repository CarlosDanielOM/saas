import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { UsageTotals } from '../../services/usage-api.service';
import { formatCreditValue, formatCredits, formatNumber, formatShare, formatUSD } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';

export interface BreakdownRow {
  id: string;
  name: string;
  sub: string;
  chip?: string | null;
  chipClass?: string;
  /** A raw id shown small under the name (a viewer without a name). */
  mono?: string | null;
  /** The name itself is code-like (a model). */
  monoName?: boolean;
  totals: UsageTotals;
  /** This row is the active filter. */
  active: boolean;
}

export interface BreakdownLink {
  label: string;
  icon: string;
  link: string;
  query?: Record<string, string>;
}

/** Biggest-first rows with a share-of-credits bar. Tapping a row narrows the page to it. */
@Component({
  selector: 'app-usage-breakdown',
  template: `
    <ul class="lf-bars ub" [attr.aria-label]="label()">
      @for (row of view(); track row.id) {
        <li class="ub__item" [class.is-active]="row.active" data-usage-row>
          <button type="button" class="lf-bars__row ub__row" [attr.aria-pressed]="row.active" (click)="pick.emit(row)" [disabled]="!row.id">
            <span class="lf-bars__name">
              <span [class.ub__mono]="row.monoName">{{ row.name }}</span>
              @if (row.chip) {<span [class]="row.chipClass + ' ub__chip'">{{ row.chip }}</span>}
              <small>{{ row.sub }} · {{ row.share }} of credits@if (row.totals.providerKnown > 0) {<span class="ub__provider"> · {{ usd(row.totals.providerUSD) }} provider cost@if (row.totals.providerKnown < row.totals.count) {<span> ({{ num(row.totals.providerKnown) }} {{ row.totals.providerKnown === 1 ? 'call' : 'calls' }})</span>}</span>}@if (row.mono) {<span class="ub__id"> · {{ row.mono }}</span>}</small>
            </span>
            <span class="lf-bars__value">
              {{ credits(row.totals.credits) }}
              <small>{{ value(row.totals.credits) }}</small>
            </span>
            <span class="lf-bar" aria-hidden="true"><span [style.width.%]="row.width"></span></span>
            <span class="sr-only">{{ row.active ? 'Showing only this one; tap to show all.' : 'Tap to show only this one.' }}</span>
          </button>
          @if (row.active && activeLink(); as link) {
            <a class="ub__link" [routerLink]="link.link" [queryParams]="link.query ?? null" data-usage-row-link>
              <app-icon [name]="link.icon" />{{ link.label }}<app-icon name="chevron" />
            </a>
          }
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host { display: block; }
      .ub__item { border-top: 1px solid var(--line); }
      .ub__item:first-child { border-top: 0; }
      .ub__row { width: 100%; min-height: 3.5rem; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
      .ub__row:hover:not(:disabled), .ub__row:focus-visible { background: var(--tile-2); }
      .ub__row:disabled { cursor: default; }
      .is-active .ub__row { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
      .ub__mono { font-family: var(--mono); font-size: 0.86rem; }
      .ub__chip { min-height: 1.35rem; margin-left: 0.4rem; font-size: 0.68rem; vertical-align: 0.1em; }
      .ub__id { font-family: var(--mono); }
      .ub__provider { white-space: nowrap; }
      .ub__link { display: flex; align-items: center; gap: 0.45rem; min-height: 2.75rem; padding: 0 1rem; background: var(--accent-soft); color: var(--accent); font-size: 0.88rem; font-weight: 700; }
      .ub__link app-icon { width: 1.05rem; height: 1.05rem; }
      .ub__link app-icon:last-child { margin-left: auto; }
      @media (min-width: 640px) { .ub__link { padding-inline: 1.25rem; } }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
})
export class UsageBreakdownComponent {
  readonly rows = input.required<BreakdownRow[]>();
  /** Credits in the whole range: the bar is each row's share of it. */
  readonly totalCredits = input.required<number>();
  readonly label = input.required<string>();
  /** Where the active row leads ("Open channel"). */
  readonly activeLink = input<BreakdownLink | null>(null);
  readonly pick = output<BreakdownRow>();

  readonly credits = formatCredits;
  readonly value = formatCreditValue;
  readonly usd = formatUSD;
  readonly num = formatNumber;

  readonly view = computed(() => {
    const total = this.totalCredits();
    return this.rows().map((row) => ({
      ...row,
      share: formatShare(row.totals.credits, total),
      width: total > 0 ? Math.max(0.5, Math.min(100, (row.totals.credits / total) * 100)) : 0,
    }));
  });
}
