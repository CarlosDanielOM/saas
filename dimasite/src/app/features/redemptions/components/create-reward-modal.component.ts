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
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { LanguageService } from '../../../services/language.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import {
  PlanTier,
  PRESET_COLORS,
  RedemptionCreateRequest,
} from '../redemptions.model';

@Component({
  selector: 'app-create-reward-modal',
  imports: [ReactiveFormsModule],
  styleUrl: './create-reward-modal.component.css',
  template: `
    @if (isOpen()) {
      <div
        class="lf-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-reward-title"
        (click)="onBackdropClick($event)"
      >
        <div class="lf-modal lf-modal--wide" (click)="$event.stopPropagation()">
          <div class="lf-modal__head">
            <div>
              <p class="lf-kicker">{{ t('redemptions.customTag') }}</p>
              <h2 id="create-reward-title" class="lf-modal__title">
                {{ t('redemptions.createRewardModal.title') }}
              </h2>
            </div>
            <button
              type="button"
              class="lf-modal__close"
              (click)="close()"
              [attr.aria-label]="t('common.close')"
            >
              ×
            </button>
          </div>

          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="lf-form">
            <div class="lf-form-grid">
              <label class="lf-field lf-field--full">
                <span>{{ t('redemptions.createRewardModal.titleLabel') }} *</span>
                <input
                  type="text"
                  formControlName="title"
                  [class.lf-input--error]="form.controls.title.invalid && form.controls.title.touched"
                  [placeholder]="t('redemptions.createRewardModal.titlePlaceholder')"
                />
                @if (form.controls.title.invalid && form.controls.title.touched) {
                  <span class="lf-error">{{ t('redemptions.createRewardModal.titleRequired') }}</span>
                }
              </label>

              <label class="lf-field">
                <span>{{ t('redemptions.createRewardModal.costLabel') }} *</span>
                <input
                  type="number"
                  formControlName="cost"
                  min="1"
                  [class.lf-input--error]="form.controls.cost.invalid && form.controls.cost.touched"
                />
                @if (form.controls.cost.invalid && form.controls.cost.touched) {
                  <span class="lf-error">{{ t('redemptions.createRewardModal.costRequired') }}</span>
                }
              </label>

              <label class="lf-field">
                <span>{{ t('redemptions.createRewardModal.cooldownLabel') }}</span>
                <div class="lf-input-suffix">
                  <input type="number" formControlName="cooldown" min="0" />
                  <span>{{ t('common.seconds') }}</span>
                </div>
              </label>

              <label class="lf-field lf-field--full">
                <span>{{ t('redemptions.createRewardModal.promptLabel') }}</span>
                <textarea
                  formControlName="prompt"
                  rows="2"
                  [placeholder]="t('redemptions.createRewardModal.promptPlaceholder')"
                ></textarea>
              </label>

              <label class="lf-field lf-field--full">
                <span>{{ t('redemptions.createRewardModal.messageLabel') }}</span>
                <textarea
                  formControlName="message"
                  rows="2"
                  [placeholder]="t('redemptions.createRewardModal.messagePlaceholder')"
                ></textarea>
              </label>

              <label class="lf-field">
                <span>{{ t('redemptions.createRewardModal.durationLabel') }}</span>
                <div class="lf-input-suffix">
                  <input type="number" formControlName="duration" min="0" />
                  <span>{{ t('common.seconds') }}</span>
                </div>
              </label>

              <div class="lf-field">
                <span>{{ t('redemptions.createRewardModal.backgroundColorLabel') }}</span>
                <button type="button" class="lf-color-trigger" (click)="toggleColorPicker()">
                  <span
                    class="lf-color-preview"
                    [style.background-color]="form.value.background_color || '#6366f1'"
                  ></span>
                  <span>{{ form.value.background_color || '#6366f1' }}</span>
                </button>

                @if (showColorPicker()) {
                  <div class="lf-color-dropdown">
                    <div class="lf-color-presets">
                      @for (color of presetColors; track color) {
                        <button
                          type="button"
                          class="lf-color-swatch"
                          [style.background-color]="color"
                          [class.lf-color-swatch--selected]="form.value.background_color === color"
                          (click)="selectColor(color)"
                          [attr.aria-label]="t('redemptions.createRewardModal.selectColor', { color })"
                        ></button>
                      }
                    </div>
                    <input
                      type="text"
                      class="lf-color-custom"
                      [value]="form.value.background_color || ''"
                      (input)="onCustomColorInput($event)"
                      placeholder="#6366f1"
                    />
                  </div>
                }
              </div>
            </div>

            <div class="lf-field">
              <span>{{ t('redemptions.createRewardModal.extraOptionsLabel') }}</span>
              <div class="lf-check-grid">
                <label class="lf-check">
                  <input type="checkbox" formControlName="userInput" />
                  <span>{{ t('redemptions.createRewardModal.userInputLabel') }}</span>
                </label>
                <label class="lf-check">
                  <input type="checkbox" formControlName="skipQueue" />
                  <span>{{ t('redemptions.createRewardModal.skipQueueLabel') }}</span>
                </label>
              </div>
            </div>

            @if (showPremiumFields()) {
              <div class="lf-premium" [class.lf-premium--locked]="!canEditPremiumFields()">
                <div class="lf-premium__head">
                  <span>★ {{ t('common.premiumFeature') }}</span>
                </div>
                <div class="lf-form-grid">
                  <label class="lf-field">
                    <span>{{ t('redemptions.createRewardModal.originalCostLabel') }}</span>
                    <input type="number" formControlName="originalCost" min="0" [disabled]="!canEditPremiumFields()" />
                  </label>
                  <label class="lf-field">
                    <span>{{ t('redemptions.createRewardModal.costChangeLabel') }}</span>
                    <input type="number" formControlName="costChange" [disabled]="!canEditPremiumFields()" />
                  </label>
                  <label class="lf-check lf-field--full">
                    <input
                      type="checkbox"
                      formControlName="returnToOriginalCost"
                      [disabled]="!canEditPremiumFields()"
                    />
                    <span>{{ t('redemptions.createRewardModal.returnToOriginalCostLabel') }}</span>
                  </label>
                </div>
                @if (!canEditPremiumFields()) {
                  <p class="lf-premium-hint">{{ t('common.premiumSubscriptionRequired') }}</p>
                }
              </div>
            }

            <div class="lf-modal__actions">
              <button type="button" class="lf-btn" (click)="close()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="lf-btn lf-btn--primary" [disabled]="form.invalid || isSubmitting()">
                @if (isSubmitting()) {
                  <span class="lf-spinner"></span>
                }
                {{ t('redemptions.createRewardModal.createButton') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateRewardModalComponent {
  private readonly fb = inject(FormBuilder);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);

  readonly isOpen = input.required<boolean>();
  readonly isOpenChange = output<boolean>();
  readonly rewardCreated = output<RedemptionCreateRequest>();

  readonly presetColors = PRESET_COLORS;
  readonly isSubmitting = signal(false);
  readonly showColorPicker = signal(false);

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.session()?.appUser?.plan_tier ?? 'free';
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  readonly canEditPremiumFields = computed(() => this.userPlan() !== 'none');
  readonly showPremiumFields = computed(() => true);

  form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(1)]],
    cost: [100, [Validators.required, Validators.min(0)]],
    prompt: [''],
    message: [''],
    cooldown: [0, [Validators.min(0)]],
    duration: [0, [Validators.min(0)]],
    userInput: [false],
    skipQueue: [false],
    background_color: ['#6366f1'],
    originalCost: [0, [Validators.min(0)]],
    costChange: [0],
    returnToOriginalCost: [false],
  });

  private readonly isOpenEffect = effect(() => {
    if (this.isOpen()) {
      this.resetForm();
    }
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  close(): void {
    this.isOpenChange.emit(false);
    this.showColorPicker.set(false);
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  toggleColorPicker(): void {
    this.showColorPicker.update((v) => !v);
  }

  selectColor(color: string): void {
    this.form.patchValue({ background_color: color });
    this.showColorPicker.set(false);
  }

  onCustomColorInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.form.patchValue({ background_color: value });
  }

  onSubmit(): void {
    if (this.form.invalid || this.isSubmitting()) return;

    this.isSubmitting.set(true);

    const formValue = this.form.getRawValue();
    const rewardData: RedemptionCreateRequest = {
      title: formValue.title.trim(),
      cost: formValue.cost,
      prompt: formValue.prompt.trim(),
      message: formValue.message.trim(),
      cooldown: formValue.cooldown,
      duration: formValue.duration,
      userInput: formValue.userInput,
      skipQueue: formValue.skipQueue,
      background_color: formValue.background_color,
      type: 'custom',
      isEnabled: true,
      ...(this.canEditPremiumFields() && {
        originalCost: formValue.originalCost,
        costChange: formValue.costChange,
        returnToOriginalCost: formValue.returnToOriginalCost,
      }),
    };

    this.rewardCreated.emit(rewardData);
    this.isSubmitting.set(false);
    this.close();
  }

  private resetForm(): void {
    this.form.reset({
      title: '',
      cost: 100,
      prompt: '',
      message: '',
      cooldown: 0,
      duration: 0,
      userInput: false,
      skipQueue: false,
      background_color: '#6366f1',
      originalCost: 0,
      costChange: 0,
      returnToOriginalCost: false,
    });
    this.showColorPicker.set(false);
    this.isSubmitting.set(false);
  }
}
