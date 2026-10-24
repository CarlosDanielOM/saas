import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import {
  MAX_COOLDOWN_SECONDS,
  PlanTier,
  PRESET_COLORS,
  Redemption,
  RedemptionCreateRequest,
  RedemptionUpdateRequest,
} from '../redemptions.model';

const HEX_COLOR = /^#([0-9a-fA-F]{6})$/;
const DEFAULT_COLOR = '#9146ff';

type CooldownUnit = 'seconds' | 'minutes' | 'hours' | 'days';
const UNIT_SECONDS: Record<CooldownUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** Largest unit that divides evenly, so 300 shows as "5 minutes", not "300 seconds". */
function splitSeconds(total: number): { amount: number; unit: CooldownUnit } {
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    if (total >= UNIT_SECONDS[unit] && total % UNIT_SECONDS[unit] === 0) return { amount: total / UNIT_SECONDS[unit], unit };
  }
  return { amount: total, unit: 'seconds' };
}

@Component({
  selector: 'app-create-reward-modal',
  imports: [ReactiveFormsModule, LfIconComponent],
  styleUrl: './create-reward-modal.component.css',
  template: `
    @if (isOpen()) {
      <div class="lf-modal-overlay" (click)="close()">
        <section class="lf-modal" role="dialog" aria-modal="true" aria-labelledby="reward-editor-title" (click)="$event.stopPropagation()">
          <header class="lf-modal__head">
            <h2 id="reward-editor-title" class="lf-modal__title">
              {{ isEditMode() ? t('redemptions.createRewardModal.editTitle') : t('redemptions.createRewardModal.title') }}
            </h2>
            <button type="button" class="lf-modal__close" (click)="close()" [attr.aria-label]="t('common.close')">
              <app-lf-icon name="close"></app-lf-icon>
            </button>
          </header>

          <form class="lf-modal__body" id="reward-editor-form" [formGroup]="form" (ngSubmit)="onSubmit()" novalidate>
            <!-- 1. The reward viewers see -->
            <section class="lf-step" aria-labelledby="reward-step-1">
              <h3 class="lf-step__title" id="reward-step-1"><span class="lf-step__num" aria-hidden="true">1</span>{{ t('redemptions.createRewardModal.stepReward') }}</h3>

              <div class="lf-preview" aria-hidden="true">
                <span class="lf-preview__tile" [style.background-color]="previewColor()" [style.color]="previewInk()">
                  @if (redemption()?.imageUrl; as img) { <img [src]="img" alt="" /> } @else { <app-lf-icon name="star"></app-lf-icon> }
                </span>
                <span class="lf-preview__text">
                  <strong>{{ values().title?.trim() || t('redemptions.createRewardModal.titlePlaceholder') }}</strong>
                  <span>{{ t('redemptions.points', { count: (values().cost || 0).toLocaleString() }) }}</span>
                </span>
              </div>

              <div class="lf-form-grid">
                <div class="lf-field lf-field--full">
                  <div class="lf-label"><label for="reward-title">{{ t('redemptions.createRewardModal.titleLabel') }}</label>
                    <span class="lf-label__hint" aria-hidden="true">{{ (values().title || '').length }}/45</span></div>
                  <input type="text" id="reward-title" formControlName="title" maxlength="45"
                    [placeholder]="t('redemptions.createRewardModal.titlePlaceholder')"
                    [attr.aria-invalid]="showError('title')" [attr.aria-describedby]="showError('title') ? 'reward-title-error' : null" />
                  @if (showError('title')) {
                    <span class="lf-error" id="reward-title-error">{{ t('redemptions.createRewardModal.titleRequired') }}</span>
                  }
                </div>

                <div class="lf-field">
                  <label class="lf-label" for="reward-cost">{{ t('redemptions.createRewardModal.costLabel') }}</label>
                  <input type="number" id="reward-cost" formControlName="cost" min="1" step="1" inputmode="numeric"
                    [attr.aria-invalid]="showError('cost')" [attr.aria-describedby]="showError('cost') ? 'reward-cost-error' : null" />
                  @if (showError('cost')) {
                    <span class="lf-error" id="reward-cost-error">{{ t('redemptions.createRewardModal.costRequired') }}</span>
                  }
                </div>

                <div class="lf-field">
                  <span class="lf-label" id="reward-color-label">{{ t('redemptions.createRewardModal.backgroundColorLabel') }}</span>
                  <div class="lf-color">
                    <input type="color" [value]="previewColor()" (input)="setColor($any($event.target).value)"
                      [attr.aria-label]="t('redemptions.createRewardModal.pickColor')" />
                    <input type="text" formControlName="background_color" maxlength="7" spellcheck="false"
                      aria-labelledby="reward-color-label" [attr.aria-invalid]="showError('background_color')"
                      [attr.aria-describedby]="showError('background_color') ? 'reward-color-error' : null" />
                  </div>
                  @if (showError('background_color')) {
                    <span class="lf-error" id="reward-color-error">{{ t('redemptions.invalidColorMessage') }}</span>
                  }
                </div>

                <div class="lf-swatches lf-field--full" role="group" [attr.aria-label]="t('redemptions.createRewardModal.backgroundColorLabel')">
                  @for (color of presetColors; track color) {
                    <button type="button" class="lf-swatch" [style.background-color]="color"
                      [attr.aria-pressed]="values().background_color?.toLowerCase() === color"
                      (click)="setColor(color)" [attr.aria-label]="t('redemptions.createRewardModal.selectColor', { color })"></button>
                  }
                </div>

                <div class="lf-field lf-field--full">
                  <div class="lf-label"><label for="reward-prompt">{{ t('redemptions.createRewardModal.promptLabel') }}</label>
                    <span class="lf-label__hint" aria-hidden="true">{{ (values().prompt || '').length }}/200</span></div>
                  <textarea id="reward-prompt" formControlName="prompt" rows="2" maxlength="200"
                    [placeholder]="t('redemptions.createRewardModal.promptPlaceholder')"></textarea>
                </div>
              </div>
            </section>

            <!-- 2. What happens when someone redeems -->
            <section class="lf-step" aria-labelledby="reward-step-2">
              <h3 class="lf-step__title" id="reward-step-2"><span class="lf-step__num" aria-hidden="true">2</span>{{ t('redemptions.createRewardModal.stepRedeem') }}</h3>

              <div class="lf-field">
                <label class="lf-label" for="reward-message">{{ t('redemptions.createRewardModal.messageLabel') }}</label>
                <textarea class="lf-mono" id="reward-message" formControlName="message" rows="3" maxlength="500"
                  [placeholder]="t('redemptions.createRewardModal.messagePlaceholder')" aria-describedby="reward-message-hint"></textarea>
                <span class="lf-note" id="reward-message-hint">{{ t('redemptions.createRewardModal.messageHint') }}</span>
              </div>

              <label class="lf-check">
                <input type="checkbox" formControlName="userInput" />
                <span><strong>{{ t('redemptions.createRewardModal.userInputLabel') }}</strong>
                  <small>{{ t('redemptions.createRewardModal.userInputHint') }}</small></span>
              </label>

              @if (isVip()) {
                <div class="lf-form-grid">
                  <div class="lf-field">
                    <label class="lf-label" for="reward-duration">{{ t('redemptions.createRewardModal.durationLabel') }}</label>
                    <input type="number" id="reward-duration" formControlName="duration" min="0" step="1" inputmode="numeric" aria-describedby="reward-duration-hint" />
                    <span class="lf-note" id="reward-duration-hint">{{ t('redemptions.createRewardModal.durationHint') }}</span>
                  </div>
                </div>
              }

              <details class="lf-more">
                <summary>{{ t('redemptions.createRewardModal.moreOptions') }}</summary>
                <div class="lf-more__body">
                  <label class="lf-check">
                    <input type="checkbox" formControlName="skipQueue" />
                    <span><strong>{{ t('redemptions.createRewardModal.skipQueueLabel') }}</strong>
                      <small>{{ t('redemptions.createRewardModal.skipQueueHint') }}</small></span>
                  </label>
                </div>
              </details>
            </section>

            <!-- 3. Limits (live on Twitch, never stored by us) -->
            <section class="lf-step" aria-labelledby="reward-step-limits" aria-describedby="reward-limits-summary">
              <h3 class="lf-step__title" id="reward-step-limits"><span class="lf-step__num" aria-hidden="true">3</span>{{ t('redemptions.limits.step') }}</h3>
              <p class="lf-summary" id="reward-limits-summary" aria-live="polite">
                <app-lf-icon [name]="anyLimitOn() ? 'shield' : 'check'" [size]="15"></app-lf-icon>
                <span>{{ limitSummary() }}</span>
              </p>
              @if (!limitsKnown()) {
                <p class="lf-note lf-note--warn">{{ t('redemptions.limits.unknown') }}</p>
              }

              <fieldset class="lf-limits" [disabled]="!limitsKnown()">
                <legend class="lf-sr">{{ t('redemptions.limits.step') }}</legend>

                <!-- Per viewer -->
                <div class="lf-limit" [class.lf-limit--on]="values().perViewerOn">
                  <label class="lf-limit__head">
                    <span class="lf-limit__text"><strong>{{ t('redemptions.limits.perViewerLabel') }}</strong>
                      <small>{{ t('redemptions.limits.perViewerHint') }}</small></span>
                    <span class="lf-switch"><input type="checkbox" formControlName="perViewerOn" /><span class="lf-switch__track" aria-hidden="true"></span></span>
                  </label>
                  @if (values().perViewerOn) {
                    <div class="lf-limit__body">
                      <div class="lf-presets" role="group" [attr.aria-label]="t('redemptions.limits.quickPicks')">
                        @for (n of perViewerPresets; track n) {
                          <button type="button" class="lf-preset" [attr.aria-pressed]="values().perViewer === n" (click)="setNumber('perViewer', n)">
                            {{ t('redemptions.limits.times', { n }) }}</button>
                        }
                      </div>
                      <div class="lf-limit__input">
                        <input type="number" formControlName="perViewer" min="1" step="1" inputmode="numeric"
                          [attr.aria-label]="t('redemptions.limits.perViewerInput')"
                          [attr.aria-invalid]="showError('perViewer')" [attr.aria-describedby]="showError('perViewer') ? 'reward-per-viewer-error' : null" />
                        <span aria-hidden="true">{{ t('redemptions.limits.timesUnit') }}</span>
                      </div>
                      @if (showError('perViewer')) {
                        <span class="lf-error" id="reward-per-viewer-error">{{ t('redemptions.limits.atLeastOne') }}</span>
                      }
                    </div>
                  }
                </div>

                <!-- Per stream, everyone together -->
                <div class="lf-limit" [class.lf-limit--on]="values().perStreamOn">
                  <label class="lf-limit__head">
                    <span class="lf-limit__text"><strong>{{ t('redemptions.limits.perStreamLabel') }}</strong>
                      <small>{{ t('redemptions.limits.perStreamHint') }}</small></span>
                    <span class="lf-switch"><input type="checkbox" formControlName="perStreamOn" /><span class="lf-switch__track" aria-hidden="true"></span></span>
                  </label>
                  @if (values().perStreamOn) {
                    <div class="lf-limit__body">
                      <div class="lf-presets" role="group" [attr.aria-label]="t('redemptions.limits.quickPicks')">
                        @for (n of perStreamPresets; track n) {
                          <button type="button" class="lf-preset" [attr.aria-pressed]="values().perStream === n" (click)="setNumber('perStream', n)">
                            {{ t('redemptions.limits.times', { n }) }}</button>
                        }
                      </div>
                      <div class="lf-limit__input">
                        <input type="number" formControlName="perStream" min="1" step="1" inputmode="numeric"
                          [attr.aria-label]="t('redemptions.limits.perStreamInput')"
                          [attr.aria-invalid]="showError('perStream') || limitClash()"
                          [attr.aria-describedby]="showError('perStream') ? 'reward-per-stream-error' : limitClash() ? 'reward-limit-clash' : null" />
                        <span aria-hidden="true">{{ t('redemptions.limits.timesUnit') }}</span>
                      </div>
                      @if (showError('perStream')) {
                        <span class="lf-error" id="reward-per-stream-error">{{ t('redemptions.limits.atLeastOne') }}</span>
                      } @else if (limitClash()) {
                        <span class="lf-error" id="reward-limit-clash">{{ t('redemptions.limits.clash', { n: values().perStream ?? 0 }) }}</span>
                      }
                      @if (redeemedThisStream() !== null) {
                        <span class="lf-note">{{ t('redemptions.limits.usedSoFar', { used: redeemedThisStream() ?? 0 }) }}</span>
                      }
                    </div>
                  }
                </div>

                <!-- Shared cooldown -->
                <div class="lf-limit" [class.lf-limit--on]="values().cooldownOn">
                  <label class="lf-limit__head">
                    <span class="lf-limit__text"><strong>{{ t('redemptions.limits.cooldownLabel') }}</strong>
                      <small>{{ t('redemptions.limits.cooldownHint') }}</small></span>
                    <span class="lf-switch"><input type="checkbox" formControlName="cooldownOn" /><span class="lf-switch__track" aria-hidden="true"></span></span>
                  </label>
                  @if (values().cooldownOn) {
                    <div class="lf-limit__body">
                      <div class="lf-presets" role="group" [attr.aria-label]="t('redemptions.limits.quickPicks')">
                        @for (preset of cooldownPresets; track preset.seconds) {
                          <button type="button" class="lf-preset" [attr.aria-pressed]="cooldownSeconds() === preset.seconds"
                            (click)="setCooldown(preset.amount, preset.unit)">{{ formatDuration(preset.seconds) }}</button>
                        }
                      </div>
                      <div class="lf-limit__input">
                        <input type="number" formControlName="cooldownAmount" min="1" step="1" inputmode="numeric"
                          [attr.aria-label]="t('redemptions.limits.cooldownInput')"
                          [attr.aria-invalid]="cooldownInvalid()" [attr.aria-describedby]="cooldownInvalid() ? 'reward-cooldown-error' : 'reward-cooldown-note'" />
                        <select formControlName="cooldownUnit" [attr.aria-label]="t('redemptions.limits.unitLabel')">
                          @for (unit of cooldownUnits; track unit) {
                            <option [value]="unit">{{ t('redemptions.limits.units.' + unit) }}</option>
                          }
                        </select>
                      </div>
                      @if (cooldownInvalid()) {
                        <span class="lf-error" id="reward-cooldown-error">{{ t('redemptions.limits.cooldownRange') }}</span>
                      } @else if (cooldownSeconds() < 60) {
                        <span class="lf-note" id="reward-cooldown-note">{{ t('redemptions.limits.cooldownShort') }}</span>
                      } @else {
                        <span class="lf-note" id="reward-cooldown-note">{{ t('redemptions.limits.cooldownShownAs', { time: formatDuration(cooldownSeconds()) }) }}</span>
                      }
                    </div>
                  }
                </div>
              </fieldset>
            </section>

            <!-- 4. Price that rises with demand (paid plans) -->
            <section class="lf-step lf-premium" [class.lf-premium--locked]="!canEditPremiumFields()" aria-labelledby="reward-step-3">
              <div class="lf-step__row">
                <h3 class="lf-step__title" id="reward-step-3"><span class="lf-step__num" aria-hidden="true">4</span>{{ t('redemptions.createRewardModal.stepPrice') }}</h3>
                <span class="lf-chip lf-chip--gold"><app-lf-icon name="star" [size]="12"></app-lf-icon>{{ t('common.premiumFeature') }}</span>
              </div>
              <p class="lf-note">{{ t('redemptions.createRewardModal.priceHint') }}</p>
              <div class="lf-form-grid">
                <div class="lf-field">
                  <label class="lf-label" for="reward-rise">{{ t('redemptions.createRewardModal.costChangeLabel') }}</label>
                  <input type="number" id="reward-rise" formControlName="costChange" min="0" step="1" inputmode="numeric" aria-describedby="reward-rise-hint" />
                  <span class="lf-note" id="reward-rise-hint">{{ riseSummary() }}</span>
                </div>
                @if (isEditMode()) {
                  <div class="lf-field">
                    <label class="lf-label" for="reward-base">{{ t('redemptions.createRewardModal.originalCostLabel') }}</label>
                    <input type="number" id="reward-base" formControlName="originalCost" min="1" step="1" inputmode="numeric" aria-describedby="reward-base-hint" />
                    <span class="lf-note" id="reward-base-hint">{{ t('redemptions.createRewardModal.originalCostHint') }}</span>
                  </div>
                }
              </div>
              <label class="lf-check">
                <input type="checkbox" formControlName="returnToOriginalCost" />
                <span><strong>{{ t('redemptions.createRewardModal.returnToOriginalCostLabel') }}</strong>
                  <small>{{ isEditMode() ? t('redemptions.createRewardModal.returnHintEdit') : t('redemptions.createRewardModal.returnHintCreate') }}</small></span>
              </label>
              @if (!canEditPremiumFields()) {
                <p class="lf-note lf-note--gold">{{ t('redemptions.createRewardModal.premiumLocked') }}</p>
              }
            </section>
          </form>

          <footer class="lf-modal__footer">
            <button type="button" class="lf-btn" (click)="close()">{{ t('common.cancel') }}</button>
            <button type="submit" form="reward-editor-form" class="lf-btn lf-btn--primary">
              {{ isEditMode() ? t('redemptions.createRewardModal.saveButton') : t('redemptions.createRewardModal.createButton') }}
            </button>
          </footer>
        </section>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateRewardModalComponent {
  private readonly fb = inject(FormBuilder);
  private readonly languageService = inject(LanguageService);

  readonly isOpen = input.required<boolean>();
  readonly redemption = input<Redemption | null>(null);
  readonly userPlan = input.required<PlanTier>();
  readonly isOpenChange = output<boolean>();
  readonly rewardCreated = output<RedemptionCreateRequest>();
  readonly rewardUpdated = output<{ id: string; data: RedemptionUpdateRequest }>();

  readonly presetColors = PRESET_COLORS;
  readonly perViewerPresets = [1, 2, 3, 5] as const;
  readonly perStreamPresets = [5, 10, 25, 50] as const;
  readonly cooldownUnits: CooldownUnit[] = ['seconds', 'minutes', 'hours', 'days'];
  readonly cooldownPresets = [
    { amount: 30, unit: 'seconds' as const, seconds: 30 },
    { amount: 1, unit: 'minutes' as const, seconds: 60 },
    { amount: 5, unit: 'minutes' as const, seconds: 300 },
    { amount: 15, unit: 'minutes' as const, seconds: 900 },
    { amount: 1, unit: 'hours' as const, seconds: 3600 },
  ];
  readonly submitAttempted = signal(false);

  readonly isEditMode = computed(() => this.redemption() !== null);
  /** Days of VIP only apply to VIP rewards; other rewards ignore it. */
  readonly isVip = computed(() => (this.redemption()?.type as string | undefined) === 'vip');
  readonly canEditPremiumFields = computed(() => this.userPlan() !== 'none');
  /** Limits live only on Twitch. If Twitch's copy didn't load, don't overwrite what's there. */
  readonly limitsKnown = computed(() => {
    const reward = this.redemption();
    return !reward || reward.maxPerStream !== undefined;
  });
  readonly redeemedThisStream = computed(() => this.redemption()?.redeemedThisStream ?? null);

  form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(45), Validators.pattern(/\S/)]],
    cost: [100, [Validators.required, Validators.min(1)]],
    prompt: [''],
    message: [''],
    cooldownOn: [false],
    cooldownAmount: [5, [Validators.required, Validators.min(1), Validators.pattern(/^\d+$/)]],
    cooldownUnit: ['minutes' as CooldownUnit],
    perViewerOn: [false],
    perViewer: [1, [Validators.required, Validators.min(1), Validators.pattern(/^\d+$/)]],
    perStreamOn: [false],
    perStream: [10, [Validators.required, Validators.min(1), Validators.pattern(/^\d+$/)]],
    duration: [0, [Validators.min(0)]],
    userInput: [false],
    skipQueue: [false],
    background_color: [DEFAULT_COLOR, [Validators.pattern(HEX_COLOR)]],
    originalCost: [100, [Validators.min(1)]],
    costChange: [0, [Validators.min(0)]],
    returnToOriginalCost: [false],
  });

  readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  readonly previewColor = computed(() => {
    const color = this.values().background_color?.trim() || '';
    return HEX_COLOR.test(color) ? color : DEFAULT_COLOR;
  });

  readonly previewInk = computed(() => {
    const hex = this.previewColor().slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#14151a' : '#ffffff';
  });

  readonly cooldownSeconds = computed(() => {
    const v = this.values();
    const amount = Math.round(Number(v.cooldownAmount) || 0);
    return amount * UNIT_SECONDS[(v.cooldownUnit as CooldownUnit) || 'seconds'];
  });

  readonly cooldownInvalid = computed(() => {
    if (!this.values().cooldownOn) return false;
    const seconds = this.cooldownSeconds();
    const invalid = seconds < 1 || seconds > MAX_COOLDOWN_SECONDS || this.form.controls.cooldownAmount.invalid;
    return invalid && (this.submitAttempted() || this.form.controls.cooldownAmount.touched);
  });

  /** A viewer allowance above the whole stream's allowance never applies; say so instead of saving nonsense. */
  readonly limitClash = computed(() => {
    const v = this.values();
    return Boolean(v.perViewerOn && v.perStreamOn && Number(v.perViewer) > Number(v.perStream) && Number(v.perStream) >= 1);
  });

  readonly anyLimitOn = computed(() => {
    const v = this.values();
    return Boolean(v.perViewerOn || v.perStreamOn || v.cooldownOn);
  });

  /** The limits in one plain sentence, so the streamer sees what viewers will get. */
  readonly limitSummary = computed(() => {
    const v = this.values();
    if (!this.anyLimitOn()) return this.t('redemptions.limits.summaryNone');
    const parts: string[] = [];
    if (v.perViewerOn && Number(v.perViewer) >= 1) parts.push(this.t('redemptions.limits.summaryPerViewer', { n: Number(v.perViewer) }));
    if (v.perStreamOn && Number(v.perStream) >= 1) parts.push(this.t('redemptions.limits.summaryPerStream', { n: Number(v.perStream) }));
    if (v.cooldownOn && this.cooldownSeconds() >= 1) parts.push(this.t('redemptions.limits.summaryCooldown', { time: this.formatDuration(this.cooldownSeconds()) }));
    return parts.join(' ');
  });

  /** "500 → 550 → 600 …" so the streamer sees what the number does. */
  readonly riseSummary = computed(() => {
    const step = Math.max(0, Math.round(Number(this.values().costChange) || 0));
    if (!step) return this.t('redemptions.createRewardModal.riseOff');
    const base = Math.max(1, Math.round(Number(this.values().cost) || 1));
    return this.t('redemptions.createRewardModal.riseExample', {
      a: base.toLocaleString(),
      b: (base + step).toLocaleString(),
      c: (base + step * 2).toLocaleString(),
    });
  });

  private readonly premiumFieldsEffect = effect(() => {
    const enabled = this.canEditPremiumFields();
    for (const control of [this.form.controls.originalCost, this.form.controls.costChange, this.form.controls.returnToOriginalCost]) {
      if (enabled) control.enable({ emitEvent: false });
      else control.disable({ emitEvent: false });
    }
  });

  private readonly isOpenEffect = effect(() => {
    if (!this.isOpen()) return;
    const redemption = this.redemption();
    this.submitAttempted.set(false);
    if (redemption) this.populateForm(redemption);
    else this.resetForm();
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const days = Math.floor(total / 86400);
    if (days >= 1 && total % 86400 === 0) return this.t('redemptions.time.days', { n: days });
    if (total < 60) return this.t('redemptions.time.seconds', { n: total });
    if (total < 3600) {
      const m = Math.floor(total / 60);
      const s = total % 60;
      return s ? this.t('redemptions.time.minutesSeconds', { m, s }) : this.t('redemptions.time.minutes', { n: m });
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m ? this.t('redemptions.time.hoursMinutes', { h, m }) : this.t('redemptions.time.hours', { n: h });
  }

  setNumber(control: 'perViewer' | 'perStream', value: number): void {
    this.form.controls[control].setValue(value);
    this.form.controls[control].markAsTouched();
  }

  setCooldown(amount: number, unit: CooldownUnit): void {
    this.form.patchValue({ cooldownAmount: amount, cooldownUnit: unit });
  }

  showError(control: 'title' | 'cost' | 'background_color' | 'perViewer' | 'perStream'): boolean {
    if (control === 'perViewer' && !this.values().perViewerOn) return false;
    if (control === 'perStream' && !this.values().perStreamOn) return false;
    const ctrl = this.form.controls[control];
    return ctrl.invalid && (this.submitAttempted() || ctrl.touched);
  }

  close(): void {
    this.isOpenChange.emit(false);
  }

  setColor(color: string): void {
    this.form.controls.background_color.setValue(color.toLowerCase());
  }

  onSubmit(): void {
    this.submitAttempted.set(true);
    this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    const c = this.form.controls;
    // Number fields only count while their limit is switched on.
    const limitErrors =
      (v.perViewerOn && c.perViewer.invalid) ||
      (v.perStreamOn && c.perStream.invalid) ||
      this.limitClash() ||
      (v.cooldownOn && (c.cooldownAmount.invalid || this.cooldownSeconds() < 1 || this.cooldownSeconds() > MAX_COOLDOWN_SECONDS));
    const baseInvalid = c.title.invalid || c.cost.invalid || c.background_color.invalid || c.duration.invalid
      || (this.canEditPremiumFields() && (c.costChange.invalid || c.originalCost.invalid));
    if (baseInvalid || limitErrors) {
      this.focusFirstError();
      return;
    }

    const premium = this.canEditPremiumFields()
      ? {
          costChange: Math.max(0, Math.round(v.costChange)),
          returnToOriginalCost: v.returnToOriginalCost,
          ...(this.isEditMode() ? { originalCost: Math.max(1, Math.round(v.originalCost)) } : {}),
        }
      : {};
    const common = {
      title: v.title.trim(),
      cost: Math.round(v.cost),
      prompt: v.prompt.trim(),
      message: v.message.trim(),
      ...(this.limitsKnown()
        ? {
            cooldown: v.cooldownOn ? this.cooldownSeconds() : 0,
            maxPerStream: v.perStreamOn ? Math.round(Number(v.perStream)) : 0,
            maxPerUserPerStream: v.perViewerOn ? Math.round(Number(v.perViewer)) : 0,
          }
        : {}),
      userInput: v.userInput,
      skipQueue: v.skipQueue,
      background_color: v.background_color,
      ...(this.isVip() ? { duration: Math.max(0, Math.round(v.duration)) } : {}),
      ...premium,
    };

    const target = this.redemption();
    if (target) {
      this.rewardUpdated.emit({ id: target.rewardID || target.id, data: common });
    } else {
      this.rewardCreated.emit({ ...common, type: 'custom', isEnabled: true });
    }
    this.close();
  }

  /** Bring the first invalid field into view on long forms (phones especially). */
  private focusFirstError(): void {
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>('#reward-editor-form [aria-invalid="true"]');
      el?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  private populateForm(redemption: Redemption): void {
    const color = (redemption.background_color || '').toLowerCase();
    const cooldown = Math.max(0, Math.round(Number(redemption.cooldown) || 0));
    const split = cooldown ? splitSeconds(cooldown) : { amount: 5, unit: 'minutes' as CooldownUnit };
    this.form.reset({
      title: redemption.title,
      cost: redemption.cost,
      prompt: redemption.prompt ?? '',
      message: redemption.message ?? '',
      cooldownOn: cooldown > 0,
      cooldownAmount: split.amount,
      cooldownUnit: split.unit,
      perViewerOn: (redemption.maxPerUserPerStream ?? 0) > 0,
      perViewer: redemption.maxPerUserPerStream || 1,
      perStreamOn: (redemption.maxPerStream ?? 0) > 0,
      perStream: redemption.maxPerStream || 10,
      duration: redemption.duration ?? 0,
      userInput: redemption.userInput ?? false,
      skipQueue: redemption.skipQueue ?? false,
      background_color: HEX_COLOR.test(color) ? color : DEFAULT_COLOR,
      originalCost: redemption.originalCost || redemption.cost,
      costChange: Math.max(0, redemption.costChange ?? 0),
      returnToOriginalCost: redemption.returnToOriginalCost ?? false,
    });
  }

  private resetForm(): void {
    this.form.reset({
      title: '',
      cost: 100,
      prompt: '',
      message: '',
      cooldownOn: false,
      cooldownAmount: 5,
      cooldownUnit: 'minutes',
      perViewerOn: false,
      perViewer: 1,
      perStreamOn: false,
      perStream: 10,
      duration: 0,
      userInput: false,
      skipQueue: false,
      background_color: DEFAULT_COLOR,
      originalCost: 100,
      costChange: 0,
      returnToOriginalCost: false,
    });
  }
}
