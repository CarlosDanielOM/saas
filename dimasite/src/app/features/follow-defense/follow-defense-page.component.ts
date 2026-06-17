import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  Ban,
  ChevronLeft,
  ChevronRight,
  Crown,
  Globe2,
  Loader2,
  LucideAngularModule,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  UserX,
  Zap,
  type LucideIconData
} from 'lucide-angular';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, Subject, switchMap, takeUntil } from 'rxjs';

import {
  type FollowDefenseAttackLogEntry,
  type FollowDefenseHateRaidSource,
  type FollowDefenseMode,
  type FollowDefenseSettings,
  type FollowDefenseStatus
} from '../../models/follow-defense.model';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { FollowDefenseApiService } from '../../services/follow-defense-api.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

interface PaginationState {
  page: number;
  limit: number;
  total: number;
}

const STATUS_CHIP_CLASSES: Record<FollowDefenseMode | 'disabled' | 'raid', { chip: string; icon: LucideIconData }> = {
  disabled: { chip: 'status-chip status-chip--disabled', icon: ShieldOff },
  normal: { chip: 'status-chip status-chip--normal', icon: ShieldCheck },
  silent: { chip: 'status-chip status-chip--silent', icon: Shield },
  protection: { chip: 'status-chip status-chip--protection', icon: ShieldAlert },
  attack: { chip: 'status-chip status-chip--attack', icon: Ban },
  raid: { chip: 'status-chip status-chip--raid', icon: Zap }
};

@Component({
  selector: 'app-follow-defense-page',
  imports: [RouterLink, LucideAngularModule, TitleCasePipe, FormsModule],
  templateUrl: './follow-defense-page.component.html',
  styleUrl: './follow-defense-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FollowDefensePageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly followDefenseApi = inject(FollowDefenseApiService);
  private readonly toastService = inject(ToastService);
  private readonly destroy$ = new Subject<void>();

  // Expose Math to template
  readonly Math = Math;

  // Icons
  readonly shieldOffIcon = ShieldOff;
  readonly shieldCheckIcon = ShieldCheck;
  readonly shieldIcon = Shield;
  readonly shieldAlertIcon = ShieldAlert;
  readonly banIcon = Ban;
  readonly zapIcon = Zap;
  readonly activityIcon = Activity;
  readonly chevronLeftIcon = ChevronLeft;
  readonly chevronRightIcon = ChevronRight;
  readonly arrowLeftIcon = ArrowLeft;
  readonly crownIcon = Crown;
  readonly globeIcon = Globe2;
  readonly loaderIcon = Loader2;
  readonly refreshIcon = RefreshCw;
  readonly userXIcon = UserX;
  readonly alertIcon = AlertTriangle;

  // Signals for page state
  readonly settings = signal<FollowDefenseSettings | null>(null);
  readonly initialSettings = signal<FollowDefenseSettings | null>(null);
  readonly status = signal<FollowDefenseStatus | null>(null);
  readonly attackLogs = signal<FollowDefenseAttackLogEntry[]>([]);
  readonly hateRaidSources = signal<FollowDefenseHateRaidSource[]>([]);
  readonly settingsLoading = signal(true); // Start with loading true
  readonly statusLoading = signal(false);
  readonly logsLoading = signal(false);
  readonly savingSettings = signal(false);
  readonly activatingAttack = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly logsPagination = signal<PaginationState>({ page: 1, limit: 10, total: 0 });
  readonly hateRaidsPagination = signal<PaginationState>({ page: 1, limit: 10, total: 0 });

  readonly showAttackDialog = signal(false);
  readonly attackConfirmText = signal('');

  // Channel resolution
  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({ streamer, channelID: null, status: 'idle' });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({ streamer, channelID, status: 'resolved' as const })),
        startWith({ streamer, channelID: null, status: 'loading' as const })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });

  // Use signal for channel resolution that we manually update
  readonly channelResolution = signal<ChannelResolutionState>({
    streamer: '',
    channelID: null,
    status: 'loading'
  });

  readonly channelID = computed(() => this.channelResolution().channelID);
  readonly modulePath = computed(() => {
    const streamer = this.streamer();
    return streamer ? ['/', streamer, 'modules'] : ['/'];
  });

  readonly settingsDirty = computed(() => {
    const current = this.settings();
    const initial = this.initialSettings();
    if (!current || !initial) return false;
    return JSON.stringify(current) !== JSON.stringify(initial);
  });

  readonly currentStatusMode = computed((): FollowDefenseMode | 'disabled' | 'raid' => {
    const s = this.status();
    const settings = this.settings();
    if (!settings?.enabled) return 'disabled';
    if (s?.raid?.expiresAt && s.raid.expiresAt > Date.now()) return 'raid';
    return s?.mode ?? 'normal';
  });

  readonly statusChipClass = computed(() => {
    const mode = this.currentStatusMode();
    return STATUS_CHIP_CLASSES[mode];
  });

  readonly statusLabel = computed(() => {
    const mode = this.currentStatusMode();
    const labels: Record<FollowDefenseMode | 'disabled' | 'raid', string> = {
      disabled: this.t('followDefense.status.disabled'),
      normal: this.t('followDefense.status.normal'),
      silent: this.t('followDefense.status.silentMode'),
      protection: this.t('followDefense.status.protectionMode'),
      attack: this.t('followDefense.status.attackMode'),
      raid: this.t('followDefense.status.raidTracking')
    };
    return labels[mode];
  });

  readonly isAttackMode = computed(() => this.currentStatusMode() === 'attack');
  readonly canActivateAttack = computed(() => {
    const settings = this.settings();
    return settings?.enabled && settings.attackModeEnabled && !this.isAttackMode && !this.activatingAttack();
  });

  private lastLoadedChannelID = '';

  ngOnInit(): void {
    // Subscribe to channel resolution changes
    this.channelID$.pipe(
      takeUntil(this.destroy$)
    ).subscribe((resolution) => {
      this.channelResolution.set(resolution);

      if (resolution.status === 'idle') {
        this.settingsLoading.set(false);
        this.errorMessage.set(this.t('followDefense.errors.channelNotResolved'));
        return;
      }

      if (resolution.status === 'loading') {
        this.settingsLoading.set(true);
        return;
      }

      // Status is 'resolved'
      this.settingsLoading.set(false);

      if (!resolution.channelID) {
        this.errorMessage.set(this.t('followDefense.errors.channelNotResolved'));
        return;
      }

      // Only load if channel changed
      if (this.lastLoadedChannelID !== resolution.channelID) {
        this.lastLoadedChannelID = resolution.channelID;
        void this.loadAllData(resolution.channelID);
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  async loadAllData(channelID: string): Promise<void> {
    await Promise.all([
      this.loadSettings(channelID),
      this.loadStatus(channelID),
      this.loadAttackLogs(channelID),
      this.loadHateRaidSources(channelID)
    ]);
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (channelID) {
      await this.loadAllData(channelID);
    }
  }

  private async loadSettings(channelID: string): Promise<void> {
    this.settingsLoading.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(this.followDefenseApi.getSettings(channelID));
      if (response.error || !response.data) {
        throw new Error(response.message || this.t('followDefense.errors.loadSettingsFailed'));
      }
      this.settings.set(response.data);
      this.initialSettings.set(JSON.parse(JSON.stringify(response.data)));
    } catch (error) {
      console.error('Failed to load Follow Defense settings:', error);
      this.errorMessage.set(error instanceof Error ? error.message : this.t('followDefense.errors.loadSettingsFailed'));
    } finally {
      this.settingsLoading.set(false);
    }
  }

  private async loadStatus(channelID: string): Promise<void> {
    this.statusLoading.set(true);

    try {
      const response = await firstValueFrom(this.followDefenseApi.getStatus(channelID));
      if (!response.error && response.data) {
        this.status.set(response.data);
      }
    } catch (error) {
      console.error('Failed to load Follow Defense status:', error);
      // Status is not critical, don't show error
    } finally {
      this.statusLoading.set(false);
    }
  }

  private async loadAttackLogs(channelID: string): Promise<void> {
    this.logsLoading.set(true);

    try {
      const page = this.logsPagination().page;
      const limit = this.logsPagination().limit;
      const response = await firstValueFrom(this.followDefenseApi.getAttackLogs(channelID, page, limit));
      if (!response.error && response.data) {
        this.attackLogs.set(response.data.entries);
        this.logsPagination.update(p => ({ ...p, total: response.data!.total }));
      }
    } catch (error) {
      console.error('Failed to load attack logs:', error);
    } finally {
      this.logsLoading.set(false);
    }
  }

  private async loadHateRaidSources(channelID: string): Promise<void> {
    try {
      const page = this.hateRaidsPagination().page;
      const limit = this.hateRaidsPagination().limit;
      const response = await firstValueFrom(this.followDefenseApi.getHateRaidSources(channelID, page, limit));
      if (!response.error && response.data) {
        this.hateRaidSources.set(response.data.sources);
        this.hateRaidsPagination.update(p => ({ ...p, total: response.data!.total }));
      }
    } catch (error) {
      console.error('Failed to load hate raid sources:', error);
    }
  }

  async saveSettings(): Promise<void> {
    const channelID = this.channelID();
    const currentSettings = this.settings();
    const initialSettings = this.initialSettings();

    if (!channelID || !currentSettings || !initialSettings || this.savingSettings() || !this.settingsDirty()) {
      return;
    }

    // Build patch only for changed fields
    const patch: Partial<FollowDefenseSettings> = {};
    const fields: Array<keyof FollowDefenseSettings> = [
      'enabled',
      'silentModeEnabled',
      'protectionModeEnabled',
      'attackModeEnabled',
      'silentThresholdX',
      'silentWindowYSeconds',
      'protectionThresholdB',
      'attackThreshold',
      'silentDurationSeconds',
      'baselineFollowsPerHour'
    ];

    for (const field of fields) {
      if (currentSettings[field] !== initialSettings[field]) {
        (patch as Record<string, unknown>)[field] = currentSettings[field];
      }
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    this.savingSettings.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(this.followDefenseApi.updateSettings(channelID, patch));
      if (response.error || !response.data) {
        throw new Error(response.message || this.t('followDefense.errors.saveSettingsFailed'));
      }
      this.settings.set(response.data);
      this.initialSettings.set(JSON.parse(JSON.stringify(response.data)));
      this.toastService.success(this.t('followDefense.toasts.savedTitle'), this.t('followDefense.toasts.savedMessage'));
    } catch (error) {
      console.error('Failed to save Follow Defense settings:', error);
      const message = error instanceof Error ? error.message : this.t('followDefense.errors.saveSettingsFailed');
      this.errorMessage.set(message);
      this.toastService.error(this.t('followDefense.toasts.errorTitle'), message);
    } finally {
      this.savingSettings.set(false);
    }
  }

  updateEnabled(enabled: boolean): void {
    this.settings.update(s => s ? { ...s, enabled } : s);
  }

  updateSilentModeEnabled(enabled: boolean): void {
    this.settings.update(s => s ? { ...s, silentModeEnabled: enabled } : s);
  }

  updateProtectionModeEnabled(enabled: boolean): void {
    this.settings.update(s => s ? { ...s, protectionModeEnabled: enabled } : s);
  }

  updateAttackModeEnabled(enabled: boolean): void {
    this.settings.update(s => s ? { ...s, attackModeEnabled: enabled } : s);
  }

  updateSilentThreshold(value: string, field: 'silentThresholdX' | 'silentWindowYSeconds' | 'silentDurationSeconds'): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    this.settings.update(s => s ? { ...s, [field]: parsed } : s);
  }

  updateProtectionThreshold(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    this.settings.update(s => s ? { ...s, protectionThresholdB: parsed } : s);
  }

  updateAttackThreshold(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    this.settings.update(s => s ? { ...s, attackThreshold: parsed } : s);
  }

  updateBaselineFollowsPerHour(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.settings.update(s => s ? { ...s, baselineFollowsPerHour: null } : s);
      return;
    }
    this.settings.update(s => s ? { ...s, baselineFollowsPerHour: parsed } : s);
  }

  openAttackDialog(): void {
    this.showAttackDialog.set(true);
    this.attackConfirmText.set('');
  }

  closeAttackDialog(): void {
    this.showAttackDialog.set(false);
    this.attackConfirmText.set('');
  }

  async activateAttackMode(): Promise<void> {
    const channelID = this.channelID();
    const status = this.status();
    const trackedCount = status?.trackedCount ?? 0;

    // Require typed confirmation if tracked count is high
    if (trackedCount > 50 && this.attackConfirmText() !== 'ATTACK') {
      return;
    }

    if (!channelID) return;

    this.activatingAttack.set(true);

    try {
      const response = await firstValueFrom(this.followDefenseApi.activateAttackMode(channelID));
      if (response.error) {
        throw new Error(response.message || this.t('followDefense.errors.activateFailed'));
      }
      this.toastService.success(this.t('followDefense.toasts.attackActivatedTitle'), this.t('followDefense.toasts.attackActivatedMessage'));
      this.closeAttackDialog();
      await this.loadStatus(channelID);
    } catch (error) {
      console.error('Failed to activate attack mode:', error);
      this.toastService.error(this.t('followDefense.toasts.errorTitle'), error instanceof Error ? error.message : this.t('followDefense.errors.activateFailed'));
    } finally {
      this.activatingAttack.set(false);
    }
  }

  async resetMode(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) return;

    try {
      const response = await firstValueFrom(this.followDefenseApi.resetMode(channelID));
      if (response.error) {
        throw new Error(response.message || this.t('followDefense.errors.resetFailed'));
      }
      this.toastService.success(this.t('followDefense.toasts.resetSuccessTitle'), this.t('followDefense.toasts.resetSuccessMessage'));
      await this.loadStatus(channelID);
    } catch (error) {
      console.error('Failed to reset mode:', error);
      this.toastService.error(this.t('followDefense.toasts.errorTitle'), error instanceof Error ? error.message : this.t('followDefense.errors.resetFailed'));
    }
  }

  async refreshStatus(): Promise<void> {
    const channelID = this.channelID();
    if (channelID) {
      await this.loadStatus(channelID);
    }
  }

  formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  getModeChipClass(mode: FollowDefenseMode): string {
    const classMap: Record<FollowDefenseMode, string> = {
      normal: 'mode-chip mode-chip--normal',
      silent: 'mode-chip mode-chip--silent',
      protection: 'mode-chip mode-chip--protection',
      attack: 'mode-chip mode-chip--attack'
    };
    return classMap[mode];
  }

  getLogsPageNumbers(): number[] {
    const { page, total, limit } = this.logsPagination();
    const totalPages = Math.ceil(total / limit);
    const pages: number[] = [];
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
      pages.push(i);
    }
    return pages;
  }

  getHateRaidsPageNumbers(): number[] {
    const { page, total, limit } = this.hateRaidsPagination();
    const totalPages = Math.ceil(total / limit);
    const pages: number[] = [];
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
      pages.push(i);
    }
    return pages;
  }

  async goToLogsPage(page: number): Promise<void> {
    this.logsPagination.update(p => ({ ...p, page }));
    const channelID = this.channelID();
    if (channelID) {
      await this.loadAttackLogs(channelID);
    }
  }

  async goToHateRaidsPage(page: number): Promise<void> {
    this.hateRaidsPagination.update(p => ({ ...p, page }));
    const channelID = this.channelID();
    if (channelID) {
      await this.loadHateRaidSources(channelID);
    }
  }

  getStatusAge(status: FollowDefenseStatus | null): string {
    if (!status?.modeStartedAt) return '';
    const seconds = Math.floor((Date.now() - status.modeStartedAt) / 1000);
    return this.formatDuration(seconds);
  }

  getRaidExpiresIn(status: FollowDefenseStatus | null): string {
    const raid = status?.raid;
    if (!raid?.expiresAt) return '';
    const seconds = Math.floor((raid.expiresAt - Date.now()) / 1000);
    if (seconds <= 0) return '';
    return this.formatDuration(seconds);
  }

  canSubmitAttackDialog(): boolean {
    const status = this.status();
    const trackedCount = status?.trackedCount ?? 0;
    if (trackedCount <= 50) return true;
    return this.attackConfirmText() === 'ATTACK';
  }
}
