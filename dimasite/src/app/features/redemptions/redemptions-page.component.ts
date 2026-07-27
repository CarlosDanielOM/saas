import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { CreateRewardModalComponent } from './components/create-reward-modal.component';
import {
  BulkEditState,
  ColorPickerState,
  EditingState,
  PRESET_COLORS,
  PendingAction,
  PlanTier,
  Redemption,
  RedemptionCreateRequest,
  TwitchRedemption,
} from './redemptions.model';
import { RedemptionsService } from './redemptions.service';

@Component({
  selector: 'app-redemptions-page',
  imports: [FormsModule, RouterLink, CreateRewardModalComponent, ConfirmationModalComponent],
  styleUrl: './redemptions-page.component.css',
  templateUrl: './redemptions-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onDocumentEscape()',
  },
})
export class RedemptionsPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly redemptionsService = inject(RedemptionsService);
  private readonly toastService = inject(ToastService);

  private cooldownTimer: number | null = null;

  readonly presetColors = PRESET_COLORS;

  readonly streamer = toSignal(
    this.route.paramMap.pipe(map(() => getRouteParam(this.route, 'streamer'))),
    { initialValue: getRouteParam(this.route, 'streamer') },
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

  readonly editingState = signal<EditingState | null>(null);
  readonly bulkEditState = signal<BulkEditState | null>(null);
  readonly colorPickerState = signal<ColorPickerState | null>(null);
  readonly pendingActions = signal<Record<string, PendingAction>>({});

  private readonly numericFields = new Set(['cost', 'cooldown', 'originalCost', 'costChange']);
  private readonly requiredNumericFields = new Set(['cost', 'cooldown']);

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
        .filter((title) => title.length > 0),
    );

    return this.twitchRedemptions().filter(
      (redemption) => !customTitles.has(redemption.title.toLowerCase().trim()),
    );
  });

  readonly enabledCustomCount = computed(
    () => this.customRedemptions().filter((r) => r.isEnabled).length,
  );

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

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  getRedemptionId(redemption: Pick<Redemption, 'id' | 'rewardID' | 'eventsubID' | 'title'>): string {
    return redemption.id || redemption.rewardID || redemption.eventsubID || redemption.title;
  }

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
        this.toastService.error(
          this.t('redemptions.errors.loadTwitchTitle'),
          this.t('redemptions.errors.loadTwitchMessage'),
        );
      },
    });
  }

  refreshAll(): void {
    if (this.refreshCooldown() > 0) {
      this.toastService.warning(
        this.t('redemptions.cooldownTitle'),
        this.t('redemptions.cooldownMessage', { seconds: this.refreshCooldown() }),
      );
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
      this.toastService.warning(
        this.t('redemptions.cooldownTitle'),
        this.t('redemptions.cooldownMessage', { seconds: this.twitchRefreshCooldown() }),
      );
      return;
    }

    const channelId = this.channelID();
    if (!channelId) return;

    this.loadTwitchRedemptions(channelId, true);
    this.twitchRefreshCooldown.set(30);

    this.toastService.success(this.t('redemptions.refreshSuccessTitle'), this.t('redemptions.refreshSuccessMessage'));
  }

  private startCooldownTimers(): void {
    if (this.cooldownTimer !== null) {
      window.clearInterval(this.cooldownTimer);
    }

    this.cooldownTimer = window.setInterval(() => {
      this.refreshCooldown.update((v) => Math.max(0, v - 1));
      this.twitchRefreshCooldown.update((v) => Math.max(0, v - 1));
    }, 1000);
  }

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
      error: () => {},
    });
  }

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
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, [field]: nextValue } : r)),
        );
        this.toastService.success(this.t('redemptions.updateSuccessTitle'), this.t('redemptions.updateSuccessMessage'));
      },
      error: () => {},
    });
  }

  cancelFieldEdit(_redemption: Redemption): void {
    this.editingState.set(null);
  }

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
      reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, [field]: normalizedValue } : r)),
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
          reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, ...originalValues } : r)),
        );
      },
    });
  }

  cancelBulkEdit(redemption: Redemption): void {
    const original = this.bulkEditState()?.originalValues;
    const redemptionId = this.getRedemptionId(redemption);
    if (original) {
      this.customRedemptions.update((reds) =>
        reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, ...original } : r)),
      );
    }
    this.bulkEditState.set(null);
  }

  openColorPicker(redemption: Redemption): void {
    this.colorPickerState.set({
      redemptionId: this.getRedemptionId(redemption),
      isOpen: true,
      value: redemption.background_color || '#6366f1',
    });
  }

  closeColorPicker(_redemption: Redemption): void {
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

    this.redemptionsService
      .updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'background_color', color)
      .subscribe({
        next: () => {
          this.colorPickerState.set(null);
          this.customRedemptions.update((reds) =>
            reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, background_color: color } : r)),
          );
          this.toastService.success(
            this.t('redemptions.colorUpdateSuccessTitle'),
            this.t('redemptions.colorUpdateSuccessMessage'),
          );
        },
        error: () => {
          this.colorPickerState.set(null);
        },
      });
  }

  toggleEnabled(redemption: Redemption): void {
    const channelId = this.channelID();
    if (!channelId) return;
    const redemptionId = this.getRedemptionId(redemption);

    const newValue = !redemption.isEnabled;

    this.redemptionsService
      .updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'isEnabled', newValue)
      .subscribe({
        next: () => {
          this.customRedemptions.update((reds) =>
            reds.map((r) => (this.getRedemptionId(r) === redemptionId ? { ...r, isEnabled: newValue } : r)),
          );
          const title = newValue ? this.t('redemptions.enabledTitle') : this.t('redemptions.disabledTitle');
          const message = newValue ? this.t('redemptions.enabledMessage') : this.t('redemptions.disabledMessage');
          this.toastService.success(title, message);
        },
        error: () => {},
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

    this.redemptionsService
      .updateRedemptionField(channelId, redemption.rewardID || redemption.id, 'returnToOriginalCost', newValue)
      .subscribe({
        next: () => {
          this.customRedemptions.update((reds) =>
            reds.map((r) =>
              this.getRedemptionId(r) === redemptionId ? { ...r, returnToOriginalCost: newValue } : r,
            ),
          );
        },
        error: () => {},
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
    return (
      redemption.originalCost !== undefined ||
      redemption.costChange !== undefined ||
      redemption.returnToOriginalCost !== undefined
    );
  }

  formatCostChange(value: number | undefined): string {
    if (value === undefined) return '—';
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
      const currentValue = this.normalizeFieldValue(
        field,
        ((redemption as unknown) as Record<string, unknown>)[field],
      );
      const originalValue = this.normalizeFieldValue(
        field,
        ((originalValues as unknown) as Record<string, unknown>)[field],
      );

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

    if (target.closest('.field-input') || target.closest('.field-textarea') || target.closest('.lf-input') || target.closest('.lf-textarea')) {
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

    if (target.closest('.lf-color-picker') || target.closest('.lf-reward-color')) {
      return;
    }

    this.colorPickerState.set(null);
  }
}
