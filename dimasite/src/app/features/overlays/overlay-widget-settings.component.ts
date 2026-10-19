import { ChangeDetectionStrategy, Component, ViewContainerRef, computed, effect, input, inputBinding, output, outputBinding, viewChild } from '@angular/core';
import type { OverlayWidget } from './overlay.model';
import type { WidgetPlacement } from './overlay-widget-contract.generated';
import type { WidgetSettingsContext } from './overlay-widget-module';
import { widgetFixture, widgetModuleFor } from './overlay-widget-registry';

@Component({
  selector: 'app-overlay-widget-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: ':host { display:contents }',
  template: '<ng-container #outlet />'
})
export class OverlayWidgetSettingsComponent {
  readonly widget = input.required<OverlayWidget>();
  readonly placement = input<WidgetPlacement>('scene');
  readonly previewFixture = input('');
  readonly configChange = output<Partial<OverlayWidget>>();
  readonly previewChange = output<string>();
  private readonly outlet = viewChild.required('outlet', { read: ViewContainerRef });
  readonly module = computed(() => widgetModuleFor(this.widget(), this.placement()));
  readonly context = computed<WidgetSettingsContext>(() => ({ widget: this.widget(),
    previewFixture: widgetFixture(this.widget(), this.previewFixture()), fixtures: this.module()?.preview?.fixtures ?? [] }));
  constructor() {
    effect(() => {
      const settings = this.module()?.settings, outlet = this.outlet();
      outlet.clear();
      if (settings) outlet.createComponent(settings, { bindings: [
        inputBinding('context', () => this.context()),
        outputBinding<Partial<OverlayWidget>>('configChange', change => this.configChange.emit(change)),
        outputBinding<string>('previewChange', fixture => this.previewChange.emit(fixture))
      ] });
    });
  }
}
