import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { LanguageService } from '../../../services/language.service';

export type AverageMode = 'day' | 'stream';

@Component({
  selector: 'app-average-toggle',
  template: `
    <div class="lf-mini-range" role="group" [attr.aria-label]="t('dashboard.kpis.averageModeLabel')">
      <button
        type="button"
        class="lf-mini-range__btn"
        [class.lf-mini-range__btn--active]="mode() === 'day'"
        [attr.aria-pressed]="mode() === 'day'"
        [attr.aria-label]="t('dashboard.kpis.averageModeDay')"
        (click)="modeChange.emit('day')"
      >
        {{ t('dashboard.kpis.averageModeDayShort') }}
      </button>
      <button
        type="button"
        class="lf-mini-range__btn"
        [class.lf-mini-range__btn--active]="mode() === 'stream'"
        [attr.aria-pressed]="mode() === 'stream'"
        [attr.aria-label]="t('dashboard.kpis.averageModeStream')"
        (click)="modeChange.emit('stream')"
      >
        {{ t('dashboard.kpis.averageModeStreamShort') }}
      </button>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        margin-top: auto;
        padding-top: 0.7rem;
      }

      .lf-mini-range {
        display: inline-flex;
        border: 1px solid var(--line);
        border-radius: 999px;
        overflow: hidden;
      }

      .lf-mini-range__btn {
        border: 0;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        padding: 0.34rem 0.6rem;
        min-height: 32px;
        cursor: pointer;
      }

      .lf-mini-range__btn--active {
        color: var(--fg);
        background: var(--accent-soft);
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AverageToggleComponent {
  readonly mode = input.required<AverageMode>();
  readonly modeChange = output<AverageMode>();

  private readonly languageService = inject(LanguageService);

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
