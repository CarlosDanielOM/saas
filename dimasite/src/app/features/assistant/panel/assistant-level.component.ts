import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { UpgradeService } from '../../../services/upgrade.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { AssistantStore } from '../assistant.store';
import type { LevelOption } from '../assistant.types';

/**
 * Standard / Expert for the next message. Expert is the stronger mode and uses more of the day's messages
 * (Premium/Pro); on Free it shows locked with a Premium chip and opens the plans. Model names never appear.
 */
@Component({
  selector: 'app-assistant-level',
  imports: [ThrottleClickDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (level(); as lv) {
      <div class="lv" role="group" [attr.aria-label]="t('assistant.level.label')" data-assistant-level>
        @for (opt of lv.options; track opt.id) {
          <button type="button" class="lv__opt" [class.lv__opt--locked]="!opt.available"
            [attr.aria-pressed]="opt.id === lv.current" [attr.data-level]="opt.id"
            [attr.aria-label]="label(opt)" [title]="t('assistant.level.' + opt.id + 'Hint')"
            [disabled]="saving()" (appThrottleClick)="pick(opt)">
            {{ t('assistant.level.' + opt.id) }}
            @if (cost(opt) > 1) { <span class="lv__cost" aria-hidden="true">×{{ cost(opt) }}</span> }
            @if (!opt.available) { <span class="lv__chip" aria-hidden="true">Premium</span> }
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host { display: inline-flex; }
    .lv {
      display: inline-flex; gap: 0.15rem; padding: 0.15rem; border-radius: 999px;
      background: var(--btn); border: 1px solid var(--btn-border);
    }
    .lv__opt {
      display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2.25rem; padding: 0 0.75rem;
      border: 0; border-radius: 999px; background: transparent; color: var(--fg);
      font: inherit; font-size: 0.78rem; font-weight: 750; cursor: pointer; white-space: nowrap;
    }
    .lv__opt:hover:not([aria-pressed='true']):not(:disabled) { background: var(--accent-soft); }
    /* Selected: solid fill in both themes (a lighter card on a grey track disappears in dark mode). */
    .lv__opt[aria-pressed='true'] { background: #7c3aed; color: #fff; }
    .lv__opt:disabled { cursor: progress; }
    .lv__opt:focus-visible { outline: 2px solid var(--kicker); outline-offset: 2px; }
    .lv__opt--locked { color: var(--muted); }
    .lv__cost {
      padding: 0 0.3rem; border-radius: 999px; font-size: 0.68rem; font-weight: 800; font-variant-numeric: tabular-nums;
      background: var(--accent-soft); color: var(--kicker);
    }
    .lv__opt[aria-pressed='true'] .lv__cost { background: rgba(255, 255, 255, 0.22); color: #fff; }
    .lv__chip {
      padding: 0.02rem 0.4rem; border-radius: 999px; font-size: 0.64rem; font-weight: 800; letter-spacing: 0.02em;
      color: var(--gold); background: var(--gold-soft); border: 1px solid var(--gold-soft);
    }
  `,
})
export class AssistantLevelComponent {
  readonly store = inject(AssistantStore);
  private readonly language = inject(LanguageService);
  private readonly upgradeService = inject(UpgradeService);

  readonly level = computed(() => this.store.level());
  readonly saving = signal(false);

  async pick(option: LevelOption): Promise<void> {
    if (!option.available) {
      void this.upgradeService.promptUpgradeForAnyPlan('site_assistant_expert');
      return;
    }
    if (option.id === this.level()?.current) return;
    this.saving.set(true);
    await this.store.setLevel(option.id);
    this.saving.set(false);
  }

  /** Messages the next message would use at this level in the open chat (moving the chat costs more). */
  cost(option: LevelOption): number {
    return this.store.levelCosts()[option.id]?.total ?? option.cost;
  }

  label(option: LevelOption): string {
    const name = this.t(`assistant.level.${option.id}`);
    if (!option.available) return this.t('assistant.level.lockedLabel', { name });
    const cost = this.cost(option);
    return cost > 1 ? this.t('assistant.level.costLabel', { name, cost }) : name;
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }
}
