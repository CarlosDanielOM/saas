import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { OverlayWidget } from './overlay.model';
import type { WidgetPlacement } from './overlay-widget-contract.generated';
import type { WidgetRenderContext } from './overlay-widget-module';
import { widgetFixture, widgetModuleFor } from './overlay-widget-registry';

@Component({
  selector: 'app-overlay-widget-host',
  imports: [NgComponentOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: ':host { display:block; width:100%; height:100% }',
  template: `@if (module()?.renderer; as renderer) { <ng-container [ngComponentOutlet]="renderer" [ngComponentOutletInputs]="rendererInputs()" /> }`
})
export class OverlayWidgetHostComponent {
  readonly widget = input.required<OverlayWidget>();
  readonly placement = input<WidgetPlacement>('scene');
  readonly state = input<unknown>(null);
  readonly preview = input(false);
  readonly previewFixture = input('');
  readonly clockOffset = input(0);
  private readonly language = inject(LanguageService);
  readonly module = computed(() => widgetModuleFor(this.widget(), this.placement()));
  readonly context = computed<WidgetRenderContext>(() => {
    const fixture = this.module()?.preview;
    const state = this.preview() && fixture ? fixture.create(widgetFixture(this.widget(), this.previewFixture()), key => this.language.translate('overlayStudio.' + key)) : this.state();
    return { widget: this.widget(), state, preview: this.preview(), clockOffset: this.clockOffset() };
  });
  readonly rendererInputs = computed(() => ({ context: this.context() }));
}
