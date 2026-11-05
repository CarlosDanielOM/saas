import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideAngularModule, Puzzle } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { CustomWidgetsService } from './custom-widgets.service';
import type { WidgetRenderContext } from './overlay-widget-module';

/**
 * Canvas stand-in for a custom widget. The widget's own code does not run yet (that is the widget
 * engine's job), so the editor shows a labelled frame and OBS shows nothing.
 */
@Component({
  selector: 'app-overlay-custom-widget',
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display:block; width:100%; height:100% }
    .frame { box-sizing:border-box; width:100%; height:100%; display:grid; place-content:center; justify-items:center; gap:14px; padding:24px; text-align:center;
      border:3px dashed rgba(196,181,253,.75); border-radius:24px; background:repeating-linear-gradient(135deg, rgba(23,26,33,.72) 0 18px, rgba(23,26,33,.6) 18px 36px);
      color:#f5f7fb; font-family:'Plus Jakarta Sans','Segoe UI',system-ui,sans-serif; overflow:hidden }
    .icon { display:grid; place-items:center; width:72px; height:72px; border-radius:20px; background:rgba(139,92,246,.28); color:#c4b5fd }
    strong { font-size:30px; font-weight:800; line-height:1.15; overflow-wrap:anywhere }
    small { max-width:28ch; color:#d4d8e3; font-size:20px; font-weight:600; line-height:1.35 }
  `,
  template: `@if (context().preview) {
    <div class="frame" data-custom-placeholder>
      <span class="icon" aria-hidden="true"><lucide-icon [img]="icon" [size]="38" /></span>
      <strong>{{ name() }}</strong>
      <small>{{ t(missing() ? 'customMissingCanvas' : 'customCanvasNote') }}</small>
    </div>
  }`
})
export class OverlayCustomWidgetComponent {
  readonly context = input.required<WidgetRenderContext>();
  private readonly widgets = inject(CustomWidgetsService);
  private readonly language = inject(LanguageService);
  readonly icon = Puzzle;
  private readonly source = computed(() => this.widgets.widget(this.context().widget.config?.['widgetId']));
  readonly missing = computed(() => this.widgets.list() !== null && !this.source());
  readonly name = computed(() => this.context().widget.name || this.source()?.name || this.t('customName'));
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }
}
