import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  LucideAngularModule,
  Gift,
  ArrowLeft,
  Sparkles,
  RefreshCw,
  Plus,
  Crown,
  Edit3,
  Trash2,
  Power,
  PowerOff,
  Lock,
  Info,
  AlertCircle,
} from 'lucide-angular';
import { firstValueFrom, map } from 'rxjs';

import { FormsModule } from '@angular/forms';
import { LoadingIndicatorComponent } from '../../components/loading';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { RedemptionsService } from './redemptions.service';
import { CreateRewardModalComponent } from './components/create-reward-modal.component';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import {
  Redemption,
  TwitchRedemption,
  RedemptionCreateRequest,
  PlanTier,
  EditingState,
  BulkEditState,
  ColorPickerState,
  PRESET_COLORS,
  PendingAction,
} from './redemptions.model';
import { getRouteParam } from '../../shared/utils/route-param.util';

@Component({
  selector: 'app-redemptions-page',
  imports: [
    LucideAngularModule,
    FormsModule,
    LoadingIndicatorComponent,
    CreateRewardModalComponent,
    ConfirmationModalComponent,
  ],
  styleUrl: './redemptions-page.component.css',
  template: `
    <div class="redemptions-page">
      <div class="redemptions-hero">
        <div class="redemptions-hero-content">
          <button type="button" class="redemptions-back-btn" (click)="goBack()">
            <lucide-icon [name]="arrowLeftIcon" class="redemptions-back-icon"></lucide-icon>
            {{ t('redemptions.backToModules') }}
          </button>

          <div class="redemptions-hero-badge">
            <lucide-icon [name]="sparklesIcon" class="redemptions-hero-badge-icon"></lucide-icon>
            {{ t('redemptions.heroBadge') }}
          </div>

          <h1 class="redemptions-title">{{ t('redemptions.title') }}</h1>
          <p class="redemptions-subtitle">{{ t('redemptions.subtitle') }}</p>
        </div>
      </div>

      <!-- Main Content -->
      <div class="redemptions-content">
        <!-- Actions Bar -->
        <div class="redemptions-actions">
          <button type="button" class="btn btn-primary" (click)="openCreateModal()">
            <lucide-icon [name]="plusIcon" class="button-icon"></lucide-icon>
            {{ t('redemptions.createRewardButton') }}
          </button>

          <button
            type="button"
            class="btn btn-secondary"
            [class.btn-disabled]="refreshCooldown() > 0"
            [disabled]="isLoading() || refreshCooldown() > 0"
            (click)="refreshAll()"
          >
            <lucide-icon [name]="refreshIcon" class="button-icon" [class.spinning]="isLoading()"
            ></lucide-icon>
            @if (refreshCooldown() > 0) {
              {{ t('redemptions.cooldown', { seconds: refreshCooldown() }) }}
            } @else {
              {{ t('common.refresh') }}
            }
          </button>
        </div>

        <!-- Loading State -->
        @if (isLoading()) {
          <div class="redemptions-loading">
            <loading-indicator [loading]="true" [message]="t('redemptions.loading')" size="lg" />
          </div>
        } @else {
          <!-- Custom Redemptions Section -->
          <section class="redemptions-section">
            <div class="section-header">
              <h2 class="section-title">
                <lucide-icon [name]="giftIcon" class="section-title-icon"></lucide-icon>
                {{ t('redemptions.customRedemptions') }}
                <span class="section-count">({{ customRedemptions().length }})</span>
              </h2>
            </div>

            @if (customRedemptions().length === 0) {
              <div class="empty-state">
                <p class="empty-state-text">{{ t('redemptions.noCustomRedemptions') }}</p>
                <button type="button" class="btn btn-primary" (click)="openCreateModal()">
                  {{ t('redemptions.createFirstReward') }}
                </button>
              </div>
            } @else {
              <div class="redemptions-grid">
                @for (redemption of customRedemptions(); track getRedemptionId(redemption)) {
                  <div
                    class="redemption-card"
                    [attr.data-redemption-card]="getRedemptionId(redemption)"
                    [class.redemption-card-disabled]="!redemption.isEnabled"
                    [class.redemption-card-bulk-edit]="isInBulkEditMode(redemption)"
                  >
                    <!-- Color Bar -->
                    <div
                      class="redemption-color-bar"
                      [style.background-color]="getCardColor(redemption)"
                      (dblclick)="openColorPicker(redemption)"
                      [title]="t('redemptions.doubleClickToChangeColor')"
                    ></div>

                    <!-- Color Picker Popup -->
                    @if (isColorPickerOpen(getRedemptionId(redemption))) {
                      <div class="color-picker-popup">
                        <div class="color-picker-header">
                          <span>{{ t('redemptions.selectColor') }}</span>
                          <button type="button" class="color-picker-close" (click)="closeColorPicker(redemption)">
                            ×
                          </button>
                        </div>
                        <div class="color-presets">
                          @for (color of presetColors; track color) {
                            <button
                              type="button"
                              class="color-preset"
                              [style.background-color]="color"
                              [class.selected]="getColorPickerValue(getRedemptionId(redemption)) === color"
                              (click)="selectPresetColor(redemption, color)"
                            ></button>
                          }
                        </div>
                        <div class="color-custom">
                          <input
                            type="text"
                            [value]="getColorPickerValue(getRedemptionId(redemption))"
                            (input)="updateColorPickerValue(getRedemptionId(redemption), $event)"
                            (blur)="saveColorPicker(redemption)"
                            placeholder="#6366f1"
                          />
                        </div>
                      </div>
                    }

                    <div class="redemption-content">
                      <div class="redemption-card-head">
                        <div class="redemption-card-badges">
                          <span class="redemption-surface-tag">
                            {{ t('redemptions.customTag') }}
                          </span>
                          <span
                            class="status-badge"
                            [class.status-enabled]="redemption.isEnabled"
                            [class.status-disabled]="!redemption.isEnabled"
                          >
                            {{ redemption.isEnabled ? t('common.enabled') : t('common.disabled') }}
                          </span>
                        </div>
                      </div>

                      <!-- Title -->
                      <div class="redemption-field">
                        @if (isEditingField(getRedemptionId(redemption), 'title')) {
                          <input
                            type="text"
                            class="field-input field-input-large"
                            [value]="getEditingValue(getRedemptionId(redemption))"
                            (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                            (blur)="saveFieldEdit(redemption, 'title')"
                            (keyup.enter)="saveFieldEdit(redemption, 'title')"
                            (keyup.escape)="cancelFieldEdit(redemption)"
                            #editInput
                          />
                        } @else if (isInBulkEditMode(redemption)) {
                          <input
                            type="text"
                            class="field-input field-input-large"
                            [ngModel]="redemption.title"
                            (ngModelChange)="updateRedemptionField(redemption, 'title', $event)"
                          />
                        } @else {
                          <h3
                            class="redemption-title"
                            (dblclick)="startFieldEdit(redemption, 'title')"
                            [title]="t('redemptions.doubleClickToEdit')"
                          >
                            {{ redemption.title }}
                          </h3>
                        }
                      </div>

                      <!-- Prompt -->
                      <div class="redemption-field">
                        @if (isEditingField(getRedemptionId(redemption), 'prompt')) {
                          <textarea
                            class="field-textarea"
                            [value]="getEditingValue(getRedemptionId(redemption))"
                            (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                            (blur)="saveFieldEdit(redemption, 'prompt')"
                            (keyup.escape)="cancelFieldEdit(redemption)"
                            rows="2"
                          ></textarea>
                        } @else if (isInBulkEditMode(redemption)) {
                          <textarea
                            class="field-textarea"
                            [ngModel]="redemption.prompt"
                            (ngModelChange)="updateRedemptionField(redemption, 'prompt', $event)"
                            rows="2"
                          ></textarea>
                        } @else {
                          <p
                            class="redemption-prompt"
                            (dblclick)="startFieldEdit(redemption, 'prompt')"
                            [title]="t('redemptions.doubleClickToEdit')"
                          >
                            {{ redemption.prompt || t('redemptions.noPrompt') }}
                          </p>
                        }
                      </div>

                      <!-- Message -->
                      <div class="redemption-field">
                        <label class="field-label">{{ t('common.message') }}</label>
                        @if (isEditingField(getRedemptionId(redemption), 'message')) {
                          <textarea
                            class="field-textarea"
                            [value]="getEditingValue(getRedemptionId(redemption))"
                            (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                            (blur)="saveFieldEdit(redemption, 'message')"
                            (keyup.escape)="cancelFieldEdit(redemption)"
                            rows="2"
                          ></textarea>
                        } @else if (isInBulkEditMode(redemption)) {
                          <textarea
                            class="field-textarea"
                            [ngModel]="redemption.message"
                            (ngModelChange)="updateRedemptionField(redemption, 'message', $event)"
                            rows="2"
                          ></textarea>
                        } @else {
                          <p
                            class="redemption-message"
                            (dblclick)="startFieldEdit(redemption, 'message')"
                            [title]="t('redemptions.doubleClickToEdit')"
                          >
                            {{ redemption.message || t('redemptions.noMessage') }}
                          </p>
                        }
                      </div>

                      <!-- Cost and Cooldown -->
                      <div class="redemption-stats">
                        <div class="stat-box">
                          <label class="stat-label">{{ t('common.cost') }}</label>
                          @if (isEditingField(getRedemptionId(redemption), 'cost')) {
                            <input
                              type="number"
                              class="field-input"
                              [value]="getEditingValue(getRedemptionId(redemption))"
                              (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                              (blur)="saveFieldEdit(redemption, 'cost')"
                              (keyup.enter)="saveFieldEdit(redemption, 'cost')"
                              min="0"
                            />
                          } @else if (isInBulkEditMode(redemption)) {
                            <input
                              type="number"
                              class="field-input"
                              [ngModel]="redemption.cost"
                              (ngModelChange)="updateRedemptionField(redemption, 'cost', $event)"
                              min="0"
                            />
                          } @else {
                            <span
                              class="stat-value"
                              (dblclick)="startFieldEdit(redemption, 'cost')"
                              [title]="t('redemptions.doubleClickToEdit')"
                            >
                              {{ redemption.cost }}
                            </span>
                          }
                        </div>

                        <div class="stat-box">
                          <label class="stat-label">{{ t('common.cooldown') }}</label>
                          @if (isEditingField(getRedemptionId(redemption), 'cooldown')) {
                            <input
                              type="number"
                              class="field-input"
                              [value]="getEditingValue(getRedemptionId(redemption))"
                              (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                              (blur)="saveFieldEdit(redemption, 'cooldown')"
                              (keyup.enter)="saveFieldEdit(redemption, 'cooldown')"
                              min="0"
                            />
                          } @else if (isInBulkEditMode(redemption)) {
                            <input
                              type="number"
                              class="field-input"
                              [ngModel]="redemption.cooldown"
                              (ngModelChange)="updateRedemptionField(redemption, 'cooldown', $event)"
                              min="0"
                            />
                          } @else {
                            <span
                              class="stat-value"
                              (dblclick)="startFieldEdit(redemption, 'cooldown')"
                              [title]="t('redemptions.doubleClickToEdit')"
                            >
                              {{ redemption.cooldown }}s
                            </span>
                          }
                        </div>
                      </div>

                      <!-- Premium Fields -->
                      @if (showPremiumFields() || hasPremiumData(redemption)) {
                        <div class="premium-section">
                          <div class="premium-header">
                            <lucide-icon [name]="crownIcon" class="premium-icon"></lucide-icon>
                            <span>{{ t('common.premiumFeature') }}</span>
                            @if (!canEditPremiumFields()) {
                              <lucide-icon [name]="lockIcon" class="premium-lock"></lucide-icon>
                            }
                          </div>

                          <div class="premium-fields">
                            <div class="premium-field">
                              <label>{{ t('redemptions.originalCost') }}</label>
                              @if (canEditPremiumFields()) {
                                @if (isEditingField(getRedemptionId(redemption), 'originalCost')) {
                                  <input
                                    type="number"
                                    class="field-input"
                                    [value]="getEditingValue(getRedemptionId(redemption))"
                                    (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                                    (blur)="saveFieldEdit(redemption, 'originalCost')"
                                    min="0"
                                  />
                                } @else if (isInBulkEditMode(redemption)) {
                                  <input
                                    type="number"
                                    class="field-input"
                                    [ngModel]="redemption.originalCost"
                                    (ngModelChange)="updateRedemptionField(redemption, 'originalCost', $event)"
                                    min="0"
                                  />
                                } @else {
                                  <span
                                    (dblclick)="startFieldEdit(redemption, 'originalCost')"
                                    [title]="t('redemptions.doubleClickToEdit')"
                                  >
                                    {{ redemption.originalCost ?? '--' }}
                                  </span>
                                }
                              } @else {
                                <span class="premium-locked">{{ redemption.originalCost ?? '--' }}</span>
                              }
                            </div>

                            <div class="premium-field">
                              <label>{{ t('redemptions.costChange') }}</label>
                              @if (canEditPremiumFields()) {
                                @if (isEditingField(getRedemptionId(redemption), 'costChange')) {
                                  <input
                                    type="number"
                                    class="field-input"
                                    [value]="getEditingValue(getRedemptionId(redemption))"
                                    (input)="updateEditingValue(getRedemptionId(redemption), $event)"
                                    (blur)="saveFieldEdit(redemption, 'costChange')"
                                  />
                                } @else if (isInBulkEditMode(redemption)) {
                                  <input
                                    type="number"
                                    class="field-input"
                                    [ngModel]="redemption.costChange"
                                    (ngModelChange)="updateRedemptionField(redemption, 'costChange', $event)"
                                  />
                                } @else {
                                  <span
                                    (dblclick)="startFieldEdit(redemption, 'costChange')"
                                    [title]="t('redemptions.doubleClickToEdit')"
                                  >
                                    {{ formatCostChange(redemption.costChange) }}
                                  </span>
                                }
                              } @else {
                                <span class="premium-locked">{{ formatCostChange(redemption.costChange) }}</span>
                              }
                            </div>

                            <div class="premium-field premium-field-full">
                              <label class="checkbox-label">
                                <input
                                  type="checkbox"
                                  [checked]="redemption.returnToOriginalCost"
                                  [disabled]="!canEditPremiumFields()"
                                  (change)="
                                    canEditPremiumFields()
                                      && (isInBulkEditMode(redemption)
                                        ? updateRedemptionField(redemption, 'returnToOriginalCost', $any($event.target).checked)
                                        : toggleReturnToOriginal(redemption))
                                  "
                                />
                                <span>{{ t('redemptions.returnToOriginalCost') }}</span>
                              </label>
                            </div>
                          </div>
                        </div>
                      }

                      <!-- Actions -->
                      <div class="redemption-actions">
                        @if (isInBulkEditMode(redemption)) {
                          <button type="button" class="btn btn-success" (click)="saveBulkEdit(redemption)">
                            {{ t('common.save') }}
                          </button>
                          <button type="button" class="btn btn-secondary" (click)="cancelBulkEdit(redemption)">
                            {{ t('common.cancel') }}
                          </button>
                        } @else {
                          <button
                            type="button"
                            class="btn btn-icon"
                            [title]="t('redemptions.editAll')"
                            (click)="enterBulkEditMode(redemption)"
                          >
                            <lucide-icon [name]="editIcon"></lucide-icon>
                          </button>

                          <button
                            type="button"
                            class="btn btn-icon btn-danger"
                            [title]="t('common.delete')"
                            (click)="deleteRedemption(redemption)"
                          >
                            <lucide-icon [name]="trashIcon"></lucide-icon>
                          </button>

                          <button
                            type="button"
                            class="btn btn-icon"
                            [class.btn-success]="!redemption.isEnabled"
                            [class.btn-warning]="redemption.isEnabled"
                            [title]="redemption.isEnabled ? t('common.disable') : t('common.enable')"
                            (click)="toggleEnabled(redemption)"
                          >
                            <lucide-icon [name]="redemption.isEnabled ? powerOffIcon : powerIcon"
                            ></lucide-icon>
                          </button>
                        }
                      </div>
                    </div>
                  </div>
                }
              </div>
            }
          </section>

          <!-- Twitch Native Redemptions Section -->
          <section class="redemptions-section redemptions-section-twitch">
            <div class="section-header">
              <h2 class="section-title">
                <lucide-icon [name]="giftIcon" class="section-title-icon"></lucide-icon>
                {{ t('redemptions.twitchRedemptions') }}
                <span class="section-count">({{ uniqueTwitchRedemptions().length }})</span>
              </h2>

              <button
                type="button"
                class="btn btn-twitch"
                [class.btn-disabled]="twitchRefreshCooldown() > 0"
                [disabled]="twitchRefreshCooldown() > 0"
                (click)="refreshTwitch()"
              >
                <lucide-icon [name]="refreshIcon" class="button-icon" [class.spinning]="isLoadingTwitch()"
                ></lucide-icon>
                @if (twitchRefreshCooldown() > 0) {
                  {{ t('redemptions.cooldown', { seconds: twitchRefreshCooldown() }) }}
                } @else {
                  {{ t('common.refresh') }}
                }
              </button>
            </div>

            @if (isLoadingTwitch()) {
              <div class="redemptions-loading">
                <loading-indicator [loading]="true" [message]="t('redemptions.loadingTwitch')" size="md" />
              </div>
            } @else if (uniqueTwitchRedemptions().length === 0) {
              <div class="empty-state empty-state-twitch">
                <lucide-icon [name]="infoIcon" class="empty-state-icon"></lucide-icon>
                <p class="empty-state-text">{{ t('redemptions.noUniqueTwitchRedemptions') }}</p>
              </div>
            } @else {
              <div class="redemptions-grid">
                @for (redemption of uniqueTwitchRedemptions(); track redemption.id) {
                  <div class="redemption-card redemption-card-twitch">
                    <div
                      class="redemption-color-bar"
                      [style.background-color]="redemption.background_color || '#9146ff'"
                    ></div>

                    <div class="redemption-content">
                      <div class="redemption-card-head">
                        <div class="redemption-card-badges">
                          <div class="redemption-readonly-badge">
                            <lucide-icon [name]="lockIcon"></lucide-icon>
                            {{ t('redemptions.readOnly') }}
                          </div>
                          <span
                            class="status-badge"
                            [class.status-enabled]="redemption.is_enabled"
                            [class.status-disabled]="!redemption.is_enabled"
                          >
                            {{ redemption.is_enabled ? t('common.enabled') : t('common.disabled') }}
                          </span>
                        </div>
                      </div>

                      <h3 class="redemption-title">{{ redemption.title }}</h3>
                      <p class="redemption-prompt">{{ redemption.prompt || t('redemptions.noPrompt') }}</p>

                      <div class="redemption-stats">
                        <div class="stat-box stat-box-twitch">
                          <label class="stat-label">{{ t('common.cost') }}</label>
                          <span class="stat-value">{{ redemption.cost }}</span>
                        </div>

                        <div class="stat-box stat-box-twitch">
                          <label class="stat-label">{{ t('common.cooldown') }}</label>
                          <span class="stat-value">
                            {{ redemption.global_cooldown_setting?.global_cooldown_seconds || 0 }}s
                          </span>
                        </div>
                      </div>

                      <div class="redemption-actions">
                        <span class="twitch-hint">
                          <lucide-icon [name]="alertCircleIcon"></lucide-icon>
                          {{ t('redemptions.manageOnTwitch') }}
                        </span>
                      </div>
                    </div>
                  </div>
                }
              </div>
            }
          </section>
        }
      </div>
    </div>

    <!-- Create Reward Modal -->
    <app-create-reward-modal
      [isOpen]="isCreateModalOpen()"
      (isOpenChange)="isCreateModalOpen.set($event)"
      (rewardCreated)="onRewardCreated($event)"
    />

    <app-confirmation-modal
      [isOpen]="showDeleteModal()"
      [title]="t('redemptions.deleteModal.title')"
      [message]="deleteModalMessage()"
      [confirmText]="t('common.delete')"
      [cancelText]="t('common.cancel')"
      variant="danger"
      (confirm)="confirmDeleteRedemption()"
      (cancel)="closeDeleteModal()"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onDocumentEscape()'
  }
})
export class RedemptionsPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly redemptionsService = inject(RedemptionsService);
  private readonly toastService = inject(ToastService);

  private cooldownTimer: number | null = null;

  // Icons
  readonly giftIcon = Gift;
  readonly arrowLeftIcon = ArrowLeft;
  readonly sparklesIcon = Sparkles;
  readonly refreshIcon = RefreshCw;
  readonly plusIcon = Plus;
  readonly crownIcon = Crown;
  readonly editIcon = Edit3;
  readonly trashIcon = Trash2;
  readonly powerIcon = Power;
  readonly powerOffIcon = PowerOff;
  readonly lockIcon = Lock;
  readonly infoIcon = Info;
  readonly alertCircleIcon = AlertCircle;

  // Constants
  readonly presetColors = PRESET_COLORS;

  // State signals
  readonly streamer = toSignal(
    this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer'))),
    { initialValue: getRouteParam(this.route, 'streamer') }
  );
  readonly channelID = signal<string | null>(null);

  readonly customRedemptions = signal<Redemption[]>([]);
  readonly twitchRedemptions = signal<TwitchRedemption[]>([]);
  readonly isLoading = signal(true);
  readonly isLoadingTwitch = signal(false);

  readonly refreshCooldown = signal(0);
  readonly twitchRefreshCooldown = signal(0);

  readonly isCreateModalOpen = signal(false);
  readonly showDeleteModal = signal(false);
  readonly redemptionToDelete = signal<Redemption | null>(null);

  // Editing state
  readonly editingState = signal<EditingState | null>(null);
  readonly bulkEditState = signal<BulkEditState | null>(null);
  readonly colorPickerState = signal<ColorPickerState | null>(null);
  readonly pendingActions = signal<Record<string, PendingAction>>({});

  private readonly numericFields = new Set(['cost', 'cooldown', 'originalCost', 'costChange']);
  private readonly requiredNumericFields = new Set(['cost', 'cooldown']);

  // Computed values
  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.session()?.appUser?.plan_tier ?? 'free';
    return tier === 'free' ? 'none' : tier === 'pro' ? 'premium_plus' : 'premium';
  });

  readonly canEditPremiumFields = computed(() => this.userPlan() !== 'none');
  readonly showPremiumFields = computed(() => true);
  readonly uniqueTwitchRedemptions = computed(() => {
    const customTitles = new Set(
      this.customRedemptions()
        .map((redemption) => redemption.title.toLowerCase().trim())
        .filter((title) => title.length > 0)
    );

    return this.twitchRedemptions().filter(
      (redemption) => !customTitles.has(redemption.title.toLowerCase().trim())
    );
  });
  readonly deleteModalMessage = computed(() => {
    const redemption = this.redemptionToDelete();
    return redemption
      ? this.t('redemptions.deleteConfirmation', { title: redemption.title })
      : this.t('redemptions.deleteFallback');
  });

  async ngOnInit(): Promise<void> {
    const routeStreamer = this.streamer() ?? '';
    const resolvedChannelId = routeStreamer
      ? await firstValueFrom(this.sessionAuth.resolveChannelID(routeStreamer))
      : this.sessionAuth.getPrimaryChannelID();

    if (!resolvedChannelId) {
      this.isLoading.set(false);
      this.toastService.error(this.t('redemptions.errors.loadTitle'), this.t('redemptions.errors.loadMessage'));
      return;
    }

    this.channelID.set(resolvedChannelId);
    this.loadRedemptions(resolvedChannelId);
    this.loadTwitchRedemptions(resolvedChannelId);
    this.startCooldownTimers();
  }

  ngOnDestroy(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  // Translation helper
  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  getRedemptionId(redemption: Pick<Redemption, 'id' | 'rewardID' | 'eventsubID' | 'title'>): string {
    return redemption.id || redemption.rewardID || redemption.eventsubID || redemption.title;
  }

  // Loading methods
  loadRedemptions(channelId: string, forceRefresh = false): void {
    this.isLoading.set(true);

    this.redemptionsService.getRedemptions(channelId, forceRefresh).subscribe({
      next: (redemptions) => {
        this.customRedemptions.set(redemptions);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
        this.toastService.error(this.t('redemptions.errors.loadTitle'), this.t('redemptions.errors.loadMessage'));
      },
    });
  }

  loadTwitchRedemptions(channelId: string, forceRefresh = false): void {
    this.isLoadingTwitch.set(true);

    this.redemptionsService.getTwitchRedemptions(channelId, forceRefresh).subscribe({
      next: (redemptions) => {
        this.twitchRedemptions.set(redemptions);
        this.isLoadingTwitch.set(false);
      },
      error: () => {
        this.isLoadingTwitch.set(false);
        this.toastService.error(this.t('redemptions.errors.loadTwitchTitle'), this.t('redemptions.errors.loadTwitchMessage'));
      },
    });
  }

  // Refresh methods
  refreshAll(): void {
    if (this.refreshCooldown() > 0) {
      this.toastService.warning(this.t('redemptions.cooldownTitle'), this.t('redemptions.cooldownMessage', { seconds: this.refreshCooldown() }));
      return;
    }

    const channelId = this.channelID();
    if (!channelId) return;

    this.loadRedemptions(channelId, true);
    this.loadTwitchRedemptions(channelId, true);
    this.refreshCooldown.set(30);
    this.twitchRefreshCooldown.set(30);

    this.toastService.success(this.t('redemptions.refreshSuccessTitle'), this.t('redemptions.refreshSuccessMessage'));
  }

  refreshTwitch(): void {
    if (this.twitchRefreshCooldown() > 0) {
      this.toastService.warning(this.t('redemptions.cooldownTitle'), this.t('redemptions.cooldownMessage', { seconds: this.twitchRefreshCooldown() }));
      return;
    }

    const channelId = this.channelID();
    if (!channelId) return;

    this.loadTwitchRedemptions(channelId, true);
    this.twitchRefreshCooldown.set(30);

    this.toastService.success(this.t('redemptions.refreshSuccessTitle'), this.t('redemptions.refreshSuccessMessage'));
  }

  // Cooldown timer
  private startCooldownTimers(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
    }

    this.cooldownTimer = window.setInterval(() => {
      this.refreshCooldown.update((v) => Math.max(0, v - 1));
      this.twitchRefreshCooldown.update((v) => Math.max(0, v - 1));
    }, 1000);
  }

  // Create reward
  openCreateModal(): void {
    this.isCreateModalOpen.set(true);
  }

  onRewardCreated(data: RedemptionCreateRequest): void {
    const channelId = this.channelID();
    if (!channelId) return;

    this.redemptionsService.createRedemption(channelId, data).subscribe({
      next: () => {
        this.loadRedemptions(channelId, true);
        this.toastService.success(this.t('redemptions.createSuccessTitle'), this.t('redemptions.createSuccessMessage'));
      },
      error: () => {
        // Error handled by service
      },
    });
  }

  // Inline editing
  startFieldEdit(redemption: Redemption, field: string): void {
    if (this.isFieldPremium(field) && !this.canEditPremiumFields()) {
      this.toastService.warning(this.t('common.premiumFeature'), this.t('common.premiumSubscriptionRequired'));
      return;
    }

    const redemptionId = this.getRedemptionId(redemption);
    const value = ((redemption as unknown) as Record<string, unknown>)[field];
    const normalizedValue = this.normalizeFieldValue(field, value);
    this.editingState.set({
      redemptionId,
      field,
      value: normalizedValue,
      originalValue: normalizedValue,
    });
  }

  isEditingField(redemptionId: string, field: string): boolean {
    const state = this.editingState();
    return state?.redemptionId === redemptionId && state?.field === field;
  }

  getEditingValue(redemptionId: string): unknown {
    const state = this.editingState();
    return state?.redemptionId === redemptionId ? state.value : '';
  }

  updateEditingValue(redemptionId: string, event: Event): void {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    this.editingState.update((state) => {
      if (state?.redemptionId === redemptionId) {
        return { ...state, value: this.normalizeFieldValue(state.field, input.value) };
      }
      return state;
    });
  }

  saveFieldEdit(redemption: Redemption, field: string): void {
    const state = this.editingState();
    const redemptionId = this.getRedemptionId(redemption);
    if (!state || state.redemptionId !== redemptionId || state.field !== field) return;

    const nextValue = this.normalizeFieldValue(field, state.value);
    const originalValue = this.normalizeFieldValue(field, state.originalValue);

    if (this.requiredNumericFields.has(field) && typeof nextValue !== 'number') {
      this.editingState.set(null);
      return;
    }

    // Don't save if value hasn't changed
    if (!this.hasFieldChanged(field, nextValue, originalValue)) {
      this.editingState.set(null);
      return;
    }

    this.editingState.set(null);

    const channelId = this.channelID();
    if (!channelId) return;

    const updateData: Record<string, unknown> = { [field]: nextValue };

    this.redemptionsService.updateRedemption(channelId, redemption.rewardID || redemption.id, updateData).subscribe({
      next: () => {
        this.customRedemptions.update((reds) =>
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, [field]: nextValue } : r))
        );
        this.toastService.success(this.t('redemptions.updateSuccessTitle'), this.t('redemptions.updateSuccessMessage'));
      },
      error: () => {},
    });
  }

  cancelFieldEdit(redemption: Redemption): void {
    this.editingState.set(null);
  }

  // Bulk editing
  enterBulkEditMode(redemption: Redemption): void {
    this.bulkEditState.set({
      redemptionId: this.getRedemptionId(redemption),
      originalValues: { ...redemption },
    });
  }

  isInBulkEditMode(redemption: Redemption): boolean {
    return this.bulkEditState()?.redemptionId === this.getRedemptionId(redemption);
  }

  updateRedemptionField(redemption: Redemption, field: string, value: unknown): void {
    const redemptionId = this.getRedemptionId(redemption);
    const normalizedValue = this.normalizeFieldValue(field, value);
    this.customRedemptions.update((reds) =>
      reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, [field]: normalizedValue } : r))
    );
  }

  saveBulkEdit(redemption: Redemption, options?: { showSuccessOnNoChanges?: boolean }): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const redemptionId = this.getRedemptionId(redemption);

    const originalValues = this.bulkEditState()?.originalValues;
    if (!originalValues) {
      this.bulkEditState.set(null);
      return;
    }

    const updateData = this.buildBulkUpdateData(redemption, originalValues);
    if (Object.keys(updateData).length === 0) {
      this.bulkEditState.set(null);
      if (options?.showSuccessOnNoChanges ?? true) {
        this.toastService.success(this.t('redemptions.updateSuccessTitle'), this.t('redemptions.updateSuccessMessage'));
      }
      return;
    }

    this.bulkEditState.set(null);

    this.redemptionsService.updateRedemption(channelId, redemption.rewardID || redemption.id, updateData).subscribe({
      next: () => {
        this.toastService.success(this.t('redemptions.updateSuccessTitle'), this.t('redemptions.updateSuccessMessage'));
      },
      error: () => {
        this.customRedemptions.update((reds) =>
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, ...originalValues } : r))
        );
      },
    });
  }

  cancelBulkEdit(redemption: Redemption): void {
    const original = this.bulkEditState()?.originalValues;
    const redemptionId = this.getRedemptionId(redemption);
    if (original) {
      this.customRedemptions.update((reds) =>
        reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, ...original } : r))
      );
    }
    this.bulkEditState.set(null);
  }

  // Color picker
  openColorPicker(redemption: Redemption): void {
    this.colorPickerState.set({
      redemptionId: this.getRedemptionId(redemption),
      isOpen: true,
      value: redemption.background_color || '#6366f1',
    });
  }

  closeColorPicker(redemption: Redemption): void {
    this.colorPickerState.set(null);
  }

  isColorPickerOpen(redemptionId: string): boolean {
    return this.colorPickerState()?.redemptionId === redemptionId && this.colorPickerState()?.isOpen === true;
  }

  getColorPickerValue(redemptionId: string): string {
    return (this.colorPickerState()?.redemptionId === redemptionId ? this.colorPickerState()?.value : '') || '#6366f1';
  }

  updateColorPickerValue(redemptionId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.colorPickerState.update((state) => {
      if (state?.redemptionId === redemptionId) {
        return { ...state, value };
      }
      return state;
    });
  }

  selectPresetColor(redemption: Redemption, color: string): void {
    this.colorPickerState.update((state) => {
      if (state?.redemptionId === this.getRedemptionId(redemption)) {
        return { ...state, value: color };
      }
      return state;
    });
    this.saveColorPicker(redemption);
  }

  saveColorPicker(redemption: Redemption): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const redemptionId = this.getRedemptionId(redemption);

    const color = this.colorPickerState()?.value;
    if (!color || !this.redemptionsService.validateColor(color)) {
      this.toastService.error(this.t('redemptions.invalidColorTitle'), this.t('redemptions.invalidColorMessage'));
      return;
    }

    this.redemptionsService.updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'background_color', color).subscribe({
      next: () => {
        this.colorPickerState.set(null);
        this.customRedemptions.update((reds) =>
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, background_color: color } : r))
        );
        this.toastService.success(this.t('redemptions.colorUpdateSuccessTitle'), this.t('redemptions.colorUpdateSuccessMessage'));
      },
      error: () => {
        this.colorPickerState.set(null);
      },
    });
  }

  // Actions
  toggleEnabled(redemption: Redemption): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const redemptionId = this.getRedemptionId(redemption);

    const newValue = !redemption.isEnabled;

    this.redemptionsService.updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'isEnabled', newValue).subscribe({
      next: () => {
        this.customRedemptions.update((reds) =>
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, isEnabled: newValue } : r))
        );
        const title = newValue ? this.t('redemptions.enabledTitle') : this.t('redemptions.disabledTitle');
        const message = newValue ? this.t('redemptions.enabledMessage') : this.t('redemptions.disabledMessage');
        this.toastService.success(title, message);
      },
      error: () => {
        // Error handled by service
      },
    });
  }

  deleteRedemption(redemption: Redemption): void {
    this.redemptionToDelete.set(redemption);
    this.showDeleteModal.set(true);
  }

  closeDeleteModal(): void {
    this.showDeleteModal.set(false);
    this.redemptionToDelete.set(null);
  }

  confirmDeleteRedemption(): void {
    const redemption = this.redemptionToDelete();
    if (!redemption) {
      this.closeDeleteModal();
      return;
    }

    const channelId = this.channelID();
    if (!channelId) {
      this.closeDeleteModal();
      return;
    }
    const redemptionId = this.getRedemptionId(redemption);

    this.redemptionsService.deleteRedemption(channelId, redemption.rewardID || redemption.id).subscribe({
      next: () => {
        this.customRedemptions.update((reds) => reds.filter((r) => this.getRedemptionId(r) !== redemptionId));
        this.closeDeleteModal();
        this.toastService.success(this.t('redemptions.deleteSuccessTitle'), this.t('redemptions.deleteSuccessMessage'));
      },
      error: () => {
        this.closeDeleteModal();
      },
    });
  }

  toggleReturnToOriginal(redemption: Redemption): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const redemptionId = this.getRedemptionId(redemption);

    const newValue = !redemption.returnToOriginalCost;

    this.redemptionsService.updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'returnToOriginalCost', newValue).subscribe({
      next: () => {
        this.customRedemptions.update((reds) =>
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, returnToOriginalCost: newValue } : r))
        );
      },
      error: () => {
        // Error handled by service
      },
    });
  }

  onDocumentClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    this.handleInlineEditClickAway(target);
    this.handleBulkEditClickAway(target);
    this.handleColorPickerClickAway(target);
  }

  onDocumentEscape(): void {
    const bulkState = this.bulkEditState();
    if (bulkState) {
      const redemption = this.findRedemptionById(bulkState.redemptionId);
      if (redemption) {
        this.cancelBulkEdit(redemption);
      } else {
        this.bulkEditState.set(null);
      }
    }

    if (this.editingState()) {
      this.editingState.set(null);
    }

    if (this.colorPickerState()) {
      this.colorPickerState.set(null);
    }
  }

  // Helpers
  getCardColor(redemption: Redemption): string {
    const color = redemption.background_color?.trim();
    if (!color) return '#6366f1';

    const hexPattern = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    const rgbPattern = /^rgb\((\s*\d+\s*,){2}\s*\d+\s*\)$/;
    const rgbaPattern = /^rgba\((\s*\d+\s*,){3}\s*(0|0?\.\d+|1)\s*\)$/;

    return hexPattern.test(color) || rgbPattern.test(color) || rgbaPattern.test(color) ? color : '#6366f1';
  }

  isFieldPremium(field: string): boolean {
    return ['originalCost', 'costChange', 'returnToOriginalCost'].includes(field);
  }

  hasPremiumData(redemption: Redemption): boolean {
    return redemption.originalCost !== undefined || redemption.costChange !== undefined || redemption.returnToOriginalCost !== undefined;
  }

  formatCostChange(value: number | undefined): string {
    if (value === undefined) return '--';
    return value >= 0 ? `+${value}` : `${value}`;
  }

  goBack(): void {
    const streamer = this.streamer();
    if (streamer) {
      void this.router.navigate([streamer, 'modules']);
    }
  }

  private normalizeFieldValue(field: string, value: unknown): unknown {
    if (field === 'returnToOriginalCost') {
      return Boolean(value);
    }

    if (this.numericFields.has(field)) {
      if (value === '' || value === null || value === undefined) {
        return undefined;
      }

      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return value;
  }

  private hasFieldChanged(field: string, currentValue: unknown, originalValue: unknown): boolean {
    return this.normalizeFieldValue(field, currentValue) !== this.normalizeFieldValue(field, originalValue);
  }

  private getBulkEditableFields(): string[] {
    const fields = ['title', 'prompt', 'message', 'cost', 'cooldown'];

    if (this.canEditPremiumFields()) {
      fields.push('originalCost', 'costChange', 'returnToOriginalCost');
    }

    return fields;
  }

  private buildBulkUpdateData(redemption: Redemption, originalValues: Partial<Redemption>): Partial<Redemption> {
    const updateData: Partial<Redemption> = {};

    for (const field of this.getBulkEditableFields()) {
      const currentValue = this.normalizeFieldValue(field, ((redemption as unknown) as Record<string, unknown>)[field]);
      const originalValue = this.normalizeFieldValue(field, ((originalValues as unknown) as Record<string, unknown>)[field]);

      if (!this.hasFieldChanged(field, currentValue, originalValue)) {
        continue;
      }

      (updateData as Record<string, unknown>)[field] = currentValue;
    }

    return updateData;
  }

  private findRedemptionById(redemptionId: string): Redemption | undefined {
    return this.customRedemptions().find((redemption) => this.getRedemptionId(redemption) === redemptionId);
  }

  private handleInlineEditClickAway(target: HTMLElement): void {
    const state = this.editingState();
    if (!state) {
      return;
    }

    if (target.closest('.field-input') || target.closest('.field-textarea')) {
      return;
    }

    const redemption = this.findRedemptionById(state.redemptionId);
    if (!redemption) {
      this.editingState.set(null);
      return;
    }

    this.saveFieldEdit(redemption, state.field);
  }

  private handleBulkEditClickAway(target: HTMLElement): void {
    const state = this.bulkEditState();
    if (!state) {
      return;
    }

    const activeCardId = target.closest('[data-redemption-card]')?.getAttribute('data-redemption-card');
    if (activeCardId === state.redemptionId) {
      return;
    }

    const redemption = this.findRedemptionById(state.redemptionId);
    if (!redemption) {
      this.bulkEditState.set(null);
      return;
    }

    const hasChanges = Object.keys(this.buildBulkUpdateData(redemption, state.originalValues)).length > 0;
    if (!hasChanges) {
      this.cancelBulkEdit(redemption);
      return;
    }

    this.saveBulkEdit(redemption, { showSuccessOnNoChanges: false });
  }

  private handleColorPickerClickAway(target: HTMLElement): void {
    const state = this.colorPickerState();
    if (!state) {
      return;
    }

    if (target.closest('.color-picker-popup') || target.closest('.redemption-color-bar')) {
      return;
    }

    this.colorPickerState.set(null);
  }
}
