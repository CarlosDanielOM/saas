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
import { LucideAngularModule, Crown, X, Palette } from 'lucide-angular';

import { LanguageService } from '../../../services/language.service';
import { SessionAuthService } from '../../../services/session-auth.service';
import {
  RedemptionCreateRequest,
  PRESET_COLORS,
  PlanTier,
} from '../redemptions.model';

@Component({
  selector: 'app-create-reward-modal',
  imports: [LucideAngularModule, ReactiveFormsModule],
  styleUrl: './create-reward-modal.component.css',
  template: `
    @if (isOpen()) {
      <div
        class="reward-modal__overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-reward-title"
        (click)="onBackdropClick($event)"
      >
        <div class="reward-modal__container">
          <div class="reward-modal__header">
            <h2 id="create-reward-title" class="reward-modal__title">
              {{ t('redemptions.createRewardModal.title') }}
            </h2>
            <button
              type="button"
              class="reward-modal__close-btn"
              (click)="close()"
              [attr.aria-label]="t('common.close')"
            >
              <lucide-icon [name]="xIcon" class="reward-modal__close-icon"></lucide-icon>
            </button>
          </div>

          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="reward-modal__form">
            <!-- Title Field -->
            <div class="form-field">
              <label for="reward-title" class="form-label">
                {{ t('redemptions.createRewardModal.titleLabel') }}
                <span class="form-required">*</span>
              </label>
              <input
                id="reward-title"
                type="text"
                formControlName="title"
                class="form-input"
                [class.form-input-error]="form.controls.title.invalid && form.controls.title.touched"
                [placeholder]="t('redemptions.createRewardModal.titlePlaceholder')"
              />
              @if (form.controls.title.invalid && form.controls.title.touched) {
                <span class="form-error">{{ t('redemptions.createRewardModal.titleRequired') }}</span>
              }
            </div>

            <!-- Cost Field -->
            <div class="form-field">
              <label for="reward-cost" class="form-label">
                {{ t('redemptions.createRewardModal.costLabel') }}
                <span class="form-required">*</span>
              </label>
              <input
                id="reward-cost"
                type="number"
                formControlName="cost"
                min="1"
                class="form-input"
                [class.form-input-error]="form.controls.cost.invalid && form.controls.cost.touched"
              />
              @if (form.controls.cost.invalid && form.controls.cost.touched) {
                <span class="form-error">{{ t('redemptions.createRewardModal.costRequired') }}</span>
              }
            </div>

            <!-- Prompt Field -->
            <div class="form-field">
              <label for="reward-prompt" class="form-label">
                {{ t('redemptions.createRewardModal.promptLabel') }}
              </label>
              <textarea
                id="reward-prompt"
                formControlName="prompt"
                rows="2"
                class="form-textarea"
                [placeholder]="t('redemptions.createRewardModal.promptPlaceholder')"
              ></textarea>
            </div>

            <!-- Message Field -->
            <div class="form-field">
              <label for="reward-message" class="form-label">
                {{ t('redemptions.createRewardModal.messageLabel') }}
              </label>
              <textarea
                id="reward-message"
                formControlName="message"
                rows="2"
                class="form-textarea"
                [placeholder]="t('redemptions.createRewardModal.messagePlaceholder')"
              ></textarea>
            </div>

            <!-- Cooldown Field -->
            <div class="form-field">
              <label for="reward-cooldown" class="form-label">
                {{ t('redemptions.createRewardModal.cooldownLabel') }}
              </label>
              <div class="form-input-with-suffix">
                <input
                  id="reward-cooldown"
                  type="number"
                  formControlName="cooldown"
                  min="0"
                  class="form-input"
                />
                <span class="form-input-suffix">{{ t('common.seconds') }}</span>
              </div>
            </div>

            <!-- Duration Field -->
            <div class="form-field">
              <label for="reward-duration" class="form-label">
                {{ t('redemptions.createRewardModal.durationLabel') }}
              </label>
              <div class="form-input-with-suffix">
                <input
                  id="reward-duration"
                  type="number"
                  formControlName="duration"
                  min="0"
                  class="form-input"
                />
                <span class="form-input-suffix">{{ t('common.seconds') }}</span>
              </div>
            </div>

            <!-- Background Color Field -->
            <div class="form-field">
              <label class="form-label">
                <lucide-icon [name]="paletteIcon" class="form-label-icon"></lucide-icon>
                {{ t('redemptions.createRewardModal.backgroundColorLabel') }}
              </label>
              <div class="color-picker-trigger" (click)="toggleColorPicker()">
                <div
                  class="color-preview"
                  [style.background-color]="form.value.background_color || '#6366f1'"
                ></div>
                <span class="color-value">{{ form.value.background_color || '#6366f1' }}</span>
              </div>

              @if (showColorPicker()) {
                <div class="color-picker-dropdown">
                  <div class="color-presets">
                    @for (color of presetColors; track color) {
                      <button
                        type="button"
                        class="color-preset-btn"
                        [style.background-color]="color"
                        [class.color-preset-selected]="form.value.background_color === color"
                        (click)="selectColor(color)"
                        [attr.aria-label]="t('redemptions.createRewardModal.selectColor', { color })"
                      ></button>
                    }
                  </div>
                  <div class="color-custom">
                    <input
                      type="text"
                      [value]="form.value.background_color || ''"
                      (input)="onCustomColorInput($event)"
                      class="form-input color-custom-input"
                      placeholder="#6366f1"
                    />
                  </div>
                </div>
              }
            </div>

            <!-- Extra Options -->
            <div class="form-field">
              <label class="form-label">{{ t('redemptions.createRewardModal.extraOptionsLabel') }}</label>
              <div class="reward-modal__checkbox-grid">
                <label class="checkbox-label reward-modal__checkbox-option">
                  <input
                    type="checkbox"
                    formControlName="userInput"
                    class="checkbox-input"
                  />
                  <span class="checkbox-text reward-modal__checkbox-text">
                    {{ t('redemptions.createRewardModal.userInputLabel') }}
                  </span>
                </label>

                <label class="checkbox-label reward-modal__checkbox-option">
                  <input
                    type="checkbox"
                    formControlName="skipQueue"
                    class="checkbox-input"
                  />
                  <span class="checkbox-text reward-modal__checkbox-text">
                    {{ t('redemptions.createRewardModal.skipQueueLabel') }}
                  </span>
                </label>
              </div>
            </div>

            <!-- Premium Fields Section -->
            @if (showPremiumFields()) {
              <div class="premium-section">
                <div class="premium-header">
                  <lucide-icon [name]="crownIcon" class="premium-icon"></lucide-icon>
                  <span class="premium-label">{{ t('common.premiumFeature') }}</span>
                </div>

                <div class="form-row">
                  <!-- Original Cost -->
                  <div class="form-field form-field-half">
                    <label for="reward-original-cost" class="form-label">
                      {{ t('redemptions.createRewardModal.originalCostLabel') }}
                    </label>
                    <input
                      id="reward-original-cost"
                      type="number"
                      formControlName="originalCost"
                      min="0"
                      class="form-input"
                      [disabled]="!canEditPremiumFields()"
                    />
                  </div>

                  <!-- Cost Change -->
                  <div class="form-field form-field-half">
                    <label for="reward-cost-change" class="form-label">
                      {{ t('redemptions.createRewardModal.costChangeLabel') }}
                    </label>
                    <input
                      id="reward-cost-change"
                      type="number"
                      formControlName="costChange"
                      class="form-input"
                      [disabled]="!canEditPremiumFields()"
                    />
                  </div>
                </div>

                <!-- Return to Original Cost -->
                <div class="form-field form-field-checkbox">
                  <label class="checkbox-label">
                    <input
                      type="checkbox"
                      formControlName="returnToOriginalCost"
                      class="checkbox-input"
                      [disabled]="!canEditPremiumFields()"
                    />
                    <span class="checkbox-text">{{ t('redemptions.createRewardModal.returnToOriginalCostLabel') }}</span>
                  </label>
                </div>

                @if (!canEditPremiumFields()) {
                  <p class="premium-hint">{{ t('common.premiumSubscriptionRequired') }}</p>
                }
              </div>
            }

            <!-- Actions -->
            <div class="reward-modal__actions">
              <button type="button" class="btn btn-secondary" (click)="close()">
                {{ t('common.cancel') }}
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="form.invalid || isSubmitting()"
              >
                @if (isSubmitting()) {
                  <span class="btn-spinner"></span>
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

  readonly xIcon = X;
  readonly crownIcon = Crown;
  readonly paletteIcon = Palette;
  readonly presetColors = PRESET_COLORS;

  readonly isSubmitting = signal(false);
  readonly showColorPicker = signal(false);

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.session()?.appUser?.plan_tier ?? 'free';
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  readonly canEditPremiumFields = computed(() => this.userPlan() !== 'none');
  readonly showPremiumFields = computed(() => true); // Always show but disable if not premium

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
    // Premium fields
    originalCost: [0, [Validators.min(0)]],
    costChange: [0],
    returnToOriginalCost: [false],
  });

  // Watch isOpen to reset form when opened
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
      // Only include premium fields if user has premium
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
