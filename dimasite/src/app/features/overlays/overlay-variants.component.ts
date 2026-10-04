import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { AlertEvent, AlertVariant } from './overlay.model';
@Component({
  selector: 'app-overlay-variants', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="variants" [attr.aria-label]="t('variants')">
    <p>{{ t('variantHint') }}</p>
    <div class="tabs" role="group" [attr.aria-label]="t('variants')">
      <button type="button" [attr.aria-pressed]="!selected()" (click)="selectedChange.emit(null)">{{ t('defaultVariant') }}</button>
      @for (variant of variants(); track variant.id) { <button type="button" [attr.aria-pressed]="selected() === variant.id" (click)="selectedChange.emit(variant.id)">{{ variant.name }}{{ variant.enabled ? '' : ' · ' + t('variantOff') }}</button> }
      <button type="button" [disabled]="variants().length >= 10" (click)="added.emit()">{{ t('addVariant') }}</button>
    </div>
    @if (current(); as variant) {
      <div class="rule">
        <label>{{ t('variantName') }}<input maxlength="80" [value]="variant.name" (change)="name($event)" /></label>
        @if (kind() === 'sub') {
          <label>{{ t('subTier') }}<select [value]="variant.tier" (change)="tier($event)">@for (tier of ['1000','2000','3000']; track tier) { <option [value]="tier" [selected]="variant.tier === tier">{{ t('tier_' + tier) }}</option> }</select></label>
        } @else {
          <label>{{ t(kind() === 'bits' ? 'minBits' : 'minViewers') }}<input type="number" min="0" max="1000000000" step="1" [value]="variant.min ?? 0" (change)="amount('min', $event)" /></label>
          <label>{{ t('maxAmount') }}<input type="number" [min]="variant.min ?? 0" max="1000000000" step="1" [value]="variant.max ?? ''" [placeholder]="t('noMaximum')" (change)="amount('max', $event)" /></label>
        }
      </div>
      <div class="actions">
        <label class="check"><input type="checkbox" [checked]="variant.enabled" (change)="changed.emit({enabled: !variant.enabled})" />{{ t('variantEnabled') }}</label>
        <button type="button" [disabled]="index() === 0" (click)="moved.emit(-1)">{{ t('higherPriority') }}</button>
        <button type="button" [disabled]="index() === variants().length - 1" (click)="moved.emit(1)">{{ t('lowerPriority') }}</button>
        <button type="button" [disabled]="variants().length >= 10" (click)="added.emit()">{{ t('duplicateVariant') }}</button>
        <button type="button" (click)="removed.emit()">{{ t('removeVariant') }}</button>
      </div>
    }
  </section>`, styleUrl: './overlay-design-controls.css'
})
export class OverlayVariantsComponent {
  readonly variants = input<AlertVariant[]>([]);
  readonly kind = input.required<AlertEvent>();
  readonly selected = input<string | null>(null);
  readonly selectedChange = output<string | null>();
  readonly added = output<void>(); readonly removed = output<void>(); readonly moved = output<-1 | 1>();
  readonly changed = output<Partial<AlertVariant>>();
  readonly index = computed(() => this.variants().findIndex(v => v.id === this.selected()));
  readonly current = computed(() => this.variants()[this.index()]);
  private readonly language = inject(LanguageService);
  t(key: string) { return this.language.translate('overlayStudio.' + key); }
  name(event: Event) { const input = event.target as HTMLInputElement, value = input.value.trim(); if (value) this.changed.emit({name: value}); else input.value = this.current()?.name ?? ''; }
  tier(event: Event) { this.changed.emit({tier: (event.target as HTMLSelectElement).value as AlertVariant['tier']}); }
  amount(key: 'min' | 'max', event: Event) {
    const input = event.target as HTMLInputElement, v = this.current(); if (!v) return;
    if (key === 'max' && input.value === '') { this.changed.emit({max: undefined}); return; }
    const n = Number(input.value); if (!Number.isFinite(n)) return;
    const amount = Math.max(0, Math.min(1000000000, Math.round(n)));
    this.changed.emit(key === 'min' ? {min: amount, ...(v.max !== undefined && v.max < amount ? {max: amount} : {})} : {max: Math.max(v.min ?? 0, amount)});
  }
}
