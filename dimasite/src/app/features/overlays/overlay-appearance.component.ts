import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { OverlayWidget } from './overlay.model';
@Component({
  selector: 'app-overlay-appearance', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section [attr.aria-label]="t('appearance')">
    @if (widget().kind === 'text') {
      <label>{{ t('fontFamily') }}<select [value]="widget().fontFamily ?? 'sans'" (change)="choice('fontFamily', $event)">
        @for (font of ['sans','serif','mono']; track font) { <option [value]="font" [selected]="font === (widget().fontFamily ?? 'sans')">{{ t('font_' + font) }}</option> }
      </select></label>
      <div class="pair"><label>{{ t('fontWeight') }}<select [value]="widget().fontWeight ?? 400" (change)="changed.emit({fontWeight: value($event) === '700' ? 700 : 400})"><option value="400" [selected]="widget().fontWeight !== 700">{{ t('regular') }}</option><option value="700" [selected]="widget().fontWeight === 700">{{ t('bold') }}</option></select></label>
      <label class="switch switch--field"><input type="checkbox" role="switch" [checked]="widget().italic" (change)="changed.emit({italic: !widget().italic})" /><span class="switch__track" aria-hidden="true"></span>{{ t('italic') }}</label></div>
      <label>{{ t('textAlign') }}<select [value]="widget().textAlign ?? 'center'" (change)="choice('textAlign', $event)">@for (align of ['left','center','right']; track align) { <option [value]="align" [selected]="align === (widget().textAlign ?? 'center')">{{ t('align_' + align) }}</option> }</select></label>
    }
    @if (widget().kind === 'shape') {
      <label>{{ t('shapeName') }}<select [value]="widget().shape ?? 'rectangle'" (change)="choice('shape', $event)"><option value="rectangle" [selected]="widget().shape !== 'ellipse'">{{ t('rectangle') }}</option><option value="ellipse" [selected]="widget().shape === 'ellipse'">{{ t('ellipse') }}</option></select></label>
      <div class="pair"><label>{{ t('fillColor') }}<input type="color" [value]="widget().color ?? '#7c3aed'" (input)="changed.emit({color: value($event)})" /></label><label>{{ t('borderColor') }}<input type="color" [value]="widget().borderColor ?? '#ffffff'" (input)="changed.emit({borderColor: value($event)})" /></label></div>
      <div class="pair"><label>{{ t('borderWidth') }}<input type="number" min="0" max="40" [value]="widget().borderWidth ?? 0" (change)="number('borderWidth', $event, 40)" /></label>
      @if (widget().shape !== 'ellipse') { <label>{{ t('cornerRadius') }}<input type="number" min="0" max="500" [value]="widget().radius ?? 0" (change)="number('radius', $event, 500)" /></label> }</div>
    }
    <details><summary>{{ t('appearance') }}</summary>
      <label>{{ t('opacity') }}<input type="number" min="0" max="100" [value]="(widget().opacity ?? 1) * 100" (change)="number('opacity', $event, 100, 100)" /></label>
      <label class="switch"><input type="checkbox" role="switch" [checked]="!!widget().shadow" (change)="changed.emit({shadow: widget().shadow ? undefined : {color:'#000000', blur:12, x:0, y:4}})" /><span class="switch__track" aria-hidden="true"></span>{{ t('objectShadow') }}</label>
      @if (widget().shadow; as shadow) {
        <div class="pair"><label>{{ t('shadowColor') }}<input type="color" [value]="shadow.color" (input)="shadowColor($event)" /></label><label>{{ t('shadowBlur') }}<input type="number" min="0" max="100" [value]="shadow.blur" (change)="shadowNumber('blur', $event)" /></label></div>
        <div class="pair"><label>{{ t('shadowX') }}<input type="number" min="-100" max="100" [value]="shadow.x" (change)="shadowNumber('x', $event)" /></label><label>{{ t('shadowY') }}<input type="number" min="-100" max="100" [value]="shadow.y" (change)="shadowNumber('y', $event)" /></label></div>
      }
    </details>
    <details><summary>{{ t('alignCanvas') }}</summary><div class="pair">
      @for (edge of edges; track edge) { <button type="button" [disabled]="widget().locked" (click)="aligned.emit(edge)">{{ t('align_' + edge) }}</button> }
    </div></details>
  </section>`, styleUrl: './overlay-design-controls.css'
})
export class OverlayAppearanceComponent {
  readonly edges = ['left','right','top','bottom'] as const;
  readonly widget = input.required<OverlayWidget>();
  readonly changed = output<Partial<OverlayWidget>>();
  readonly aligned = output<'left' | 'right' | 'top' | 'bottom'>();
  private readonly language = inject(LanguageService);
  t(key: string) { return this.language.translate('overlayStudio.' + key); }
  value(event: Event) { return (event.target as HTMLInputElement).value; }
  choice(key: 'fontFamily' | 'textAlign' | 'shape', event: Event) { this.changed.emit({[key]: this.value(event)} as Partial<OverlayWidget>); }
  number(key: 'borderWidth' | 'radius' | 'opacity', event: Event, max: number, scale = 1) {
    const n = Number(this.value(event)); if (Number.isFinite(n)) this.changed.emit({[key]: Math.max(0, Math.min(max, n)) / scale});
  }
  shadowColor(event: Event) { const shadow = this.widget().shadow; if (shadow) this.changed.emit({shadow: {...shadow, color: this.value(event)}}); }
  shadowNumber(key: 'blur' | 'x' | 'y', event: Event) {
    const shadow = this.widget().shadow, n = Number(this.value(event));
    if (shadow && Number.isFinite(n)) this.changed.emit({shadow: {...shadow, [key]: Math.max(key === 'blur' ? 0 : -100, Math.min(100, n))}});
  }
}
