import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { OverlayWidget } from './overlay.model';
import type { WidgetSettingsContext } from './overlay-widget-module';
import { interactionDesign } from './overlay-interaction.model';

@Component({
  selector: 'app-overlay-interaction-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display:grid; gap:.75rem; min-width:0 }
    .lf-field { display:grid; gap:.4rem; min-width:0; color:var(--fg); font-size:.8rem; font-weight:700 }
    select { width:100%; min-height:44px; min-width:0; padding:.65rem .75rem; border:1px solid var(--line); border-radius:.65rem; background:var(--tile); color:var(--fg); font:inherit; font-size:1rem }
    select:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
    .lf-note { margin:0; color:var(--muted); font-size:.76rem; line-height:1.55; font-weight:500 }
  `,
  template: `
    <label class="lf-field"><span>{{ t('interactionDesign') }}</span><select [attr.aria-label]="t('interactionDesign')" [value]="design()" (change)="setDesign($event)"><option value="card">{{ t('interactionDesignCard') }}</option><option value="compact">{{ t('interactionDesignCompact') }}</option></select></label>
    <label class="lf-field"><span>{{ t('interactionPreview') }}</span><select [attr.aria-label]="t('interactionPreview')" [value]="context().previewFixture" (change)="setPreview($event)">@for (fixture of context().fixtures; track fixture.id) { <option [value]="fixture.id" [selected]="fixture.id === context().previewFixture">{{ t(fixture.labelKey) }}</option> }</select></label>
    <p class="lf-note">{{ t('interactionPresetHint') }}</p>
  `
})
export class OverlayInteractionSettingsComponent {
  readonly context = input.required<WidgetSettingsContext>();
  readonly design = computed(() => interactionDesign(this.context().widget));
  readonly configChange = output<Partial<OverlayWidget>>();
  readonly previewChange = output<string>();
  private readonly language = inject(LanguageService);
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
  setDesign(event: Event): void {
    const design = (event.target as HTMLSelectElement).value;
    if (design === 'card' || design === 'compact') {
      const config = this.context().widget.config;
      this.configChange.emit(config ? { config: { ...config, interactionDesign: design } } : { interactionDesign: design });
    }
  }
  setPreview(event: Event): void {
    const fixture = (event.target as HTMLSelectElement).value;
    if (this.context().fixtures.some(item => item.id === fixture)) this.previewChange.emit(fixture);
  }
}
