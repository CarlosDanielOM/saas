import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import type { AlertEvent, AlertVariant } from './overlay.model';
/** Sub/raid variants of an alert design: one vertical list (Default, each variant, Add), then the open variant's settings. */
@Component({
  selector: 'app-overlay-variants', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="variants" [attr.aria-label]="t('variants')">
    <div class="v-head">
      <h3 class="v-title">{{ t(title()) }}</h3>
      <p>{{ t('variantHint') }}</p>
    </div>
    <div class="tabs v-list" role="group" [attr.aria-label]="t('variants')">
      <button type="button" class="v-row" [attr.aria-pressed]="!selected()" (click)="selectedChange.emit(null)"><span class="v-name">{{ t('defaultVariant') }}</span></button>
      @for (variant of variants(); track variant.id) {
        <button type="button" class="v-row" [class.v-row--off]="!variant.enabled" [attr.aria-pressed]="selected() === variant.id" (click)="selectedChange.emit(variant.id)">
          <span class="v-name">{{ variant.name }}</span>@if (!variant.enabled) { <span class="v-chip">{{ t('variantOff') }}</span> }
        </button>
      }
    </div>
    <button type="button" class="v-add" [disabled]="variants().length >= 10" (click)="added.emit()">{{ t('addVariant') }}</button>
    @if (current(); as variant) {
      <div class="v-form">
        <label>{{ t('variantName') }}<input maxlength="80" [value]="variant.name" (change)="name($event)" /></label>
        @if (kind() === 'sub') {
          <label>{{ t('subTier') }}<select [value]="variant.gift ? 'gift' : variant.tier" (change)="tier($event)">@for (tier of ['1000','2000','3000','gift']; track tier) { <option [value]="tier" [selected]="(variant.gift ? 'gift' : variant.tier) === tier">{{ t('tier_' + tier) }}</option> }</select></label>
        } @else {
          <div class="v-range">
            <label>{{ t(kind() === 'bits' ? 'minBits' : 'minViewers') }}<input type="number" min="0" max="1000000000" step="1" [value]="variant.min ?? 0" (change)="amount('min', $event)" /></label>
            <label>{{ t('maxAmount') }}<input type="number" [min]="variant.min ?? 0" max="1000000000" step="1" [value]="variant.max ?? ''" [placeholder]="t('noMaximum')" (change)="amount('max', $event)" /></label>
          </div>
        }
        <label class="switch"><input type="checkbox" role="switch" [checked]="variant.enabled" (change)="changed.emit({enabled: !variant.enabled})" /><span class="switch__track" aria-hidden="true"></span>{{ t('variantEnabled') }}</label>
        @if (variants().length > 1) {
          <div class="v-move">
            <button type="button" [disabled]="index() === 0" (click)="moved.emit(-1)">{{ t('higherPriority') }}</button>
            <button type="button" [disabled]="index() === variants().length - 1" (click)="moved.emit(1)">{{ t('lowerPriority') }}</button>
          </div>
        }
        <button type="button" class="danger" (click)="removed.emit()">{{ t('removeVariant') }}</button>
      </div>
    }
  </section>`, styleUrls: ['./overlay-design-controls.css', './overlay-variants.component.css']
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
  readonly title = computed(() => this.kind() === 'sub' ? 'variantsTitleSub' : this.kind() === 'raid' ? 'variantsTitleRaid' : 'variants');
  private readonly language = inject(LanguageService);
  t(key: string) { return this.language.translate('overlayStudio.' + key); }
  name(event: Event) { const input = event.target as HTMLInputElement, value = input.value.trim(); if (value) this.changed.emit({name: value}); else input.value = this.current()?.name ?? ''; }
  /** A tier, or `gift`: a look for every gifted sub (whatever its tier), which plays before the tier looks. */
  tier(event: Event) { const value = (event.target as HTMLSelectElement).value; this.changed.emit(value === 'gift' ? {gift: true, tier: undefined} : {tier: value as AlertVariant['tier'], gift: undefined}); }
  amount(key: 'min' | 'max', event: Event) {
    const input = event.target as HTMLInputElement, v = this.current(); if (!v) return;
    if (key === 'max' && input.value === '') { this.changed.emit({max: undefined}); return; }
    const n = Number(input.value); if (!Number.isFinite(n)) return;
    const amount = Math.max(0, Math.min(1000000000, Math.round(n)));
    this.changed.emit(key === 'min' ? {min: amount, ...(v.max !== undefined && v.max < amount ? {max: amount} : {})} : {max: Math.max(v.min ?? 0, amount)});
  }
}
