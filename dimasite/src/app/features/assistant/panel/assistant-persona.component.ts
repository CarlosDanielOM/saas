import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { UpgradeService } from '../../../services/upgrade.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { AssistantStore } from '../assistant.store';

/**
 * "Answer in my bot's personality": the assistant keeps its rules and facts but takes the tone of the
 * channel's active AI Personality profile. Premium/Pro; Free sees it locked with an upgrade link.
 */
@Component({
  selector: 'app-assistant-persona',
  imports: [ThrottleClickDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (persona(); as p) {
      <div class="pt" [class.pt--locked]="!p.available">
        <div class="pt__copy">
          <p class="pt__title" id="assistant-persona-title">
            {{ t('assistant.persona.title') }}
            @if (!p.available) { <span class="pt__chip">Premium</span> }
          </p>
          <p class="pt__hint">
            @if (!p.available) {
              {{ t('assistant.persona.locked') }}
            } @else if (p.name) {
              {{ t('assistant.persona.uses', { name: p.name }) }}
            } @else {
              {{ t('assistant.persona.none') }}
            }
          </p>
          @if (failed()) { <p class="pt__error" role="alert">{{ t('assistant.persona.failed') }}</p> }
        </div>
        @if (p.available) {
          <button type="button" class="pt__switch" role="switch" [attr.aria-checked]="p.on" aria-labelledby="assistant-persona-title"
            [disabled]="saving()" (appThrottleClick)="toggle(!p.on)">
            <span class="pt__knob" aria-hidden="true"></span>
          </button>
        } @else {
          <button type="button" class="pt__upgrade" (appThrottleClick)="upgrade()">{{ t('assistant.persona.upgrade') }}</button>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .pt {
      display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.75rem; align-items: center;
      padding: 0.7rem 0.8rem; border: 1px solid var(--line); border-radius: 0.9rem;
      background: var(--tile);
    }
    .pt__copy { min-width: 0; }
    .pt__title { margin: 0; display: flex; gap: 0.4rem; align-items: center; font-size: 0.85rem; font-weight: 750; color: var(--fg); }
    .pt__hint { margin: 0.15rem 0 0; font-size: 0.76rem; line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
    .pt__error { margin: 0.25rem 0 0; font-size: 0.76rem; color: var(--danger); }
    .pt__chip {
      padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.66rem; font-weight: 800; letter-spacing: 0.02em;
      color: var(--gold); background: var(--gold-soft); border: 1px solid var(--gold-soft);
    }
    .pt__switch {
      position: relative; flex: none; width: 2.75rem; height: 1.6rem; padding: 0; border: 0; border-radius: 999px; cursor: pointer;
      background: var(--btn); box-shadow: inset 0 0 0 1px var(--btn-border); transition: background 160ms ease;
    }
    .pt__switch[aria-checked='true'] { background: var(--accent); }
    .pt__switch:disabled { cursor: progress; }
    .pt__switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .pt__knob {
      position: absolute; top: 0.2rem; left: 0.2rem; width: 1.2rem; height: 1.2rem; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); transition: transform 160ms ease;
    }
    .pt__switch[aria-checked='true'] .pt__knob { transform: translateX(1.15rem); }
    .pt__upgrade {
      min-height: 2.25rem; padding: 0 0.85rem; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.8rem; font-weight: 700;
      color: var(--fg); background: var(--btn); border: 1px solid var(--btn-border);
    }
    @media (prefers-reduced-motion: reduce) { .pt__switch, .pt__knob { transition: none; } }
  `,
})
export class AssistantPersonaComponent {
  readonly store = inject(AssistantStore);
  private readonly language = inject(LanguageService);
  private readonly upgradeService = inject(UpgradeService);

  readonly persona = computed(() => this.store.status()?.persona ?? null);
  readonly saving = signal(false);
  readonly failed = signal(false);

  async toggle(on: boolean): Promise<void> {
    this.saving.set(true);
    this.failed.set(false);
    const ok = await this.store.setPersona(on);
    this.saving.set(false);
    if (!ok) this.failed.set(true);
  }

  upgrade(): void {
    void this.upgradeService.promptUpgradeForAnyPlan('site_assistant_persona');
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.language.translate(key, params);
  }
}
