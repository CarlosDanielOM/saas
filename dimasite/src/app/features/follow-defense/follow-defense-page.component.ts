import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  viewChild,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { RaidSessionsComponent } from './raid-sessions.component';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  distinctUntilChanged,
  firstValueFrom,
  map,
  of,
  shareReplay,
  startWith,
  Subject,
  switchMap,
  takeUntil
} from 'rxjs';

import type {
  FollowDefenseAttackLogEntry,
  FollowDefenseHateRaidSource,
  FollowDefenseMode,
  FollowDefenseSettings,
  FollowDefenseStatus
} from '../../models/follow-defense.model';
import { FollowDefenseApiService } from '../../services/follow-defense-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

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

@Component({
  selector: 'app-follow-defense-page',
  imports: [RouterLink, RaidSessionsComponent, LfIconComponent],
  templateUrl: './follow-defense-page.component.html',
  styleUrl: './follow-defense-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' }
})
export class FollowDefensePageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly followDefenseApi = inject(FollowDefenseApiService);
  private readonly toastService = inject(ToastService);
  private readonly destroy$ = new Subject<void>();

  readonly settings = signal<FollowDefenseSettings | null>(null);
  readonly initialSettings = signal<FollowDefenseSettings | null>(null);
  readonly status = signal<FollowDefenseStatus | null>(null);
  readonly attackLogs = signal<FollowDefenseAttackLogEntry[]>([]);
  readonly hateRaidSources = signal<FollowDefenseHateRaidSource[]>([]);
  readonly settingsLoading = signal(true);
  readonly statusLoading = signal(false);
  readonly logsLoading = signal(false);
  readonly savingSettings = signal(false);
  readonly activatingAttack = signal(false);
  readonly canManage = signal(false);
  readonly permissionLoaded = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly logsPagination = signal<PaginationState>({ page: 1, limit: 10, total: 0 });
  readonly hateRaidsPagination = signal<PaginationState>({ page: 1, limit: 10, total: 0 });

  readonly showAttackDialog = signal(false);
  readonly attackConfirmText = signal('');
  private readonly attackDialog = viewChild<ElementRef<HTMLElement>>('attackDialog');
  private attackOpener: HTMLElement | null = null;
  /** Re-evaluated every 15s so "for 2m" / "ends in 40s" stay current. */
  readonly now = signal(Date.now());
  private clockTimer: ReturnType<typeof setInterval> | null = null;

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

  readonly planTier = computed(() => {
    return this.sessionAuth.getPlanTierForStreamer(this.streamer());
  });

  readonly settingsDirty = computed(() => {
    const current = this.settings();
    const initial = this.initialSettings();
    if (!current || !initial) return false;
    return JSON.stringify(current) !== JSON.stringify(initial);
  });

  readonly currentStatusMode = computed((): FollowDefenseMode | 'disabled' | 'raid' => {
    this.now();
    const s = this.status();
    const settings = this.settings();
    if (!settings?.enabled) return 'disabled';
    if (s?.mode === 'attack' && s.expiresAt > Date.now()) return 'attack';
    if (s?.raid?.expiresAt && s.raid.expiresAt > Date.now()) return 'raid';
    return s?.mode ?? 'normal';
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
  readonly sensitivitySummary = computed(() => {
    const custom = this.settings()?.attackThreshold;
    if (custom != null) return this.t('followDefense.dynamic.manual', { count: custom });
    const dynamic = this.status()?.dynamicBaseline?.attackThreshold;
    return dynamic != null ? this.t('followDefense.dynamic.ready', { count: dynamic }) : this.t('followDefense.dynamic.learning');
  });

  readonly trackedCount = computed(() => this.status()?.trackedCount ?? 0);

  readonly activeRaid = computed(() => {
    const raid = this.status()?.raid;
    this.now();
    return raid?.expiresAt && raid.expiresAt > Date.now() ? raid : null;
  });

  /** Short label for the header chip. */
  readonly modeChip = computed(() => this.t('followDefense.v2.chip.' + this.currentStatusMode()));

  readonly modeTone = computed(() => {
    const mode = this.currentStatusMode();
    if (mode === 'attack') return 'danger';
    if (mode === 'silent' || mode === 'protection' || mode === 'raid') return 'warn';
    if (mode === 'disabled') return 'off';
    return 'ok';
  });

  /** Plain sentence answering "is anything happening right now?". */
  readonly nowHeadline = computed(() => {
    this.now();
    const mode = this.currentStatusMode();
    const status = this.status();
    const params = {
      count: this.formatNumber(this.trackedCount()),
      age: this.getStatusAge(status) || this.t('followDefense.v2.justNow'),
      ends: this.getExpiresIn(status?.expiresAt) || this.t('followDefense.v2.soon')
    };
    return this.t('followDefense.v2.now.' + mode, params);
  });

  readonly nowDetail = computed(() => {
    const mode = this.currentStatusMode();
    if (mode === 'disabled') return this.t('followDefense.v2.nowDetail.disabled');
    if (mode === 'normal') return this.t('followDefense.v2.nowDetail.normal');
    const by = this.status()?.triggeredBy === 'manual' ? 'manual' : 'threshold';
    return this.t('followDefense.v2.nowDetail.' + mode) + ' ' + this.t('followDefense.v2.startedBy.' + by);
  });

  /** Live one-liners under each mode so the numbers read as rules. */
  readonly silentRule = computed(() => {
    const s = this.settings();
    if (!s) return '';
    return this.t('followDefense.v2.rule.silent', { count: s.silentThresholdX, seconds: s.silentWindowYSeconds });
  });
  readonly protectionRule = computed(() => {
    const s = this.settings();
    return s ? this.t('followDefense.v2.rule.protection', { count: this.formatNumber(s.protectionThresholdB) }) : '';
  });
  readonly durationRule = computed(() => {
    const s = this.settings();
    return s ? this.t('followDefense.v2.rule.duration', { time: this.formatDuration(s.silentDurationSeconds) }) : '';
  });
  readonly attackChip = computed(() => {
    const custom = this.settings()?.attackThreshold;
    if (custom != null) return this.t('followDefense.v2.attackChipCustom', { count: this.formatNumber(custom) });
    const dynamic = this.status()?.dynamicBaseline?.attackThreshold;
    return dynamic != null
      ? this.t('followDefense.v2.attackChipAuto', { count: this.formatNumber(dynamic) })
      : this.t('followDefense.v2.attackChipLearning');
  });

  readonly canActivateAttack = computed(() => {
    const settings = this.settings();
    return Boolean(
      this.canManage() && settings?.enabled && settings.attackModeEnabled && !this.isAttackMode() && !this.activatingAttack()
    );
  });

  private lastLoadedChannelID = '';

  constructor() {
    effect(() => {
      const dialog = this.attackDialog();
      if (dialog) queueMicrotask(() => dialog.nativeElement.focus());
    });
  }

  ngOnInit(): void {
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 15000);
    this.channelID$.pipe(takeUntil(this.destroy$)).subscribe((resolution) => {
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

      this.settingsLoading.set(false);

      if (!resolution.channelID) {
        this.errorMessage.set(this.t('followDefense.errors.channelNotResolved'));
        return;
      }

      if (this.lastLoadedChannelID !== resolution.channelID) {
        this.canManage.set(false);
        this.permissionLoaded.set(false);
        this.lastLoadedChannelID = resolution.channelID;
        void this.loadAllData(resolution.channelID);
      }
    });
  }

  ngOnDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  titleCase(value: string): string {
    if (!value) return '';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  modeChipClass(mode: FollowDefenseMode): string {
    return `lf-chip lf-chip--mode-${mode}`;
  }

  totalLogsPages(): number {
    const { total, limit } = this.logsPagination();
    return Math.max(1, Math.ceil(total / limit));
  }

  totalHateRaidsPages(): number {
    const { total, limit } = this.hateRaidsPagination();
    return Math.max(1, Math.ceil(total / limit));
  }

  async loadAllData(channelID: string): Promise<void> {
    await Promise.all([
      this.loadSettings(channelID),
      this.loadStatus(channelID),
      this.loadAttackLogs(channelID),
      this.loadHateRaidSources(channelID),
      this.loadPermission(channelID)
    ]);
  }

  private async loadPermission(channelID: string): Promise<void> {
    try {
      const allowed = await firstValueFrom(this.sessionAuth.checkPermission(channelID, 'moderation:manage'));
      if (this.channelID() === channelID) this.canManage.set(allowed);
    } catch {
      if (this.channelID() === channelID) this.canManage.set(false);
    } finally {
      if (this.channelID() === channelID) this.permissionLoaded.set(true);
    }
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
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('followDefense.errors.loadSettingsFailed')
      );
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
    } catch {
      // non-critical
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
        this.attackLogs.set(response.data.entries ?? []);
        this.logsPagination.update((p) => ({ ...p, total: response.data!.total ?? 0 }));
      }
    } catch {
      // non-critical
    } finally {
      this.logsLoading.set(false);
    }
  }

  private async loadHateRaidSources(channelID: string): Promise<void> {
    try {
      const page = this.hateRaidsPagination().page;
      const limit = this.hateRaidsPagination().limit;
      const response = await firstValueFrom(
        this.followDefenseApi.getHateRaidSources(channelID, page, limit)
      );
      if (!response.error && response.data) {
        this.hateRaidSources.set(response.data.sources ?? []);
        this.hateRaidsPagination.update((p) => ({ ...p, total: response.data!.total ?? 0 }));
      }
    } catch {
      // non-critical
    }
  }

  async saveSettings(): Promise<void> {
    const channelID = this.channelID();
    const currentSettings = this.settings();
    const initialSettings = this.initialSettings();

    if (!this.canManage() || !channelID || !currentSettings || !initialSettings || this.savingSettings() || !this.settingsDirty()) {
      return;
    }

    const patch: Partial<FollowDefenseSettings> = {};
    const fields: Array<keyof FollowDefenseSettings> = [
      'enabled',
      'silentModeEnabled',
      'protectionModeEnabled',
      'attackModeEnabled', 'resetAttackOnNewRaid',
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

    if (Object.keys(patch).length === 0) return;

    this.savingSettings.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(this.followDefenseApi.updateSettings(channelID, patch));
      if (response.error || !response.data) {
        throw new Error(response.message || this.t('followDefense.errors.saveSettingsFailed'));
      }
      this.settings.set(response.data);
      this.initialSettings.set(JSON.parse(JSON.stringify(response.data)));
      this.toastService.success(
        this.t('followDefense.toasts.savedTitle'),
        this.t('followDefense.toasts.savedMessage')
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : this.t('followDefense.errors.saveSettingsFailed');
      this.errorMessage.set(message);
      this.toastService.error(this.t('followDefense.toasts.errorTitle'), message);
    } finally {
      this.savingSettings.set(false);
    }
  }

  updateEnabled(enabled: boolean): void {
    if (!this.canManage()) return;
    this.settings.update((s) => (s ? { ...s, enabled } : s));
  }

  updateSilentModeEnabled(enabled: boolean): void {
    if (!this.canManage()) return;
    this.settings.update((s) => (s ? { ...s, silentModeEnabled: enabled } : s));
  }

  updateProtectionModeEnabled(enabled: boolean): void {
    if (!this.canManage()) return;
    this.settings.update((s) => (s ? { ...s, protectionModeEnabled: enabled } : s));
  }

  updateResetAttackOnNewRaid(enabled: boolean): void {
    if (!this.canManage()) return;
    this.settings.update(s => s ? { ...s, resetAttackOnNewRaid: enabled } : s);
  }

  updateAttackModeEnabled(enabled: boolean): void {
    if (!this.canManage()) return;
    this.settings.update((s) => (s ? { ...s, attackModeEnabled: enabled } : s));
  }

  updateSilentThreshold(
    value: string,
    field: 'silentThresholdX' | 'silentWindowYSeconds' | 'silentDurationSeconds'
  ): void {
    if (!this.canManage()) return;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    this.settings.update((s) => (s ? { ...s, [field]: parsed } : s));
  }

  updateProtectionThreshold(value: string): void {
    if (!this.canManage()) return;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    this.settings.update((s) => (s ? { ...s, protectionThresholdB: parsed } : s));
  }

  updateAttackThreshold(value: string): void {
    if (!this.canManage()) return;
    if (!value.trim()) {
      this.settings.update(s => s ? { ...s, attackThreshold: null } : s);
      return;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return;
    this.settings.update((s) => (s ? { ...s, attackThreshold: parsed } : s));
  }

  updateBaselineFollowsPerHour(value: string): void {
    if (!this.canManage()) return;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.settings.update((s) => (s ? { ...s, baselineFollowsPerHour: null } : s));
      return;
    }
    this.settings.update((s) => (s ? { ...s, baselineFollowsPerHour: parsed } : s));
  }

  onEscape(): void {
    if (this.showAttackDialog() && !this.activatingAttack()) this.closeAttackDialog();
  }

  openAttackDialog(): void {
    if (!this.canManage()) return;
    this.attackOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.showAttackDialog.set(true);
    this.attackConfirmText.set('');
  }

  closeAttackDialog(): void {
    this.showAttackDialog.set(false);
    this.attackConfirmText.set('');
    const opener = this.attackOpener;
    this.attackOpener = null;
    if (opener?.isConnected) queueMicrotask(() => opener.focus());
  }

  discardChanges(): void {
    const initial = this.initialSettings();
    if (initial) this.settings.set(JSON.parse(JSON.stringify(initial)));
  }

  modeLabel(mode: FollowDefenseMode): string {
    return this.t('followDefense.v2.mode.' + mode);
  }

  logSummary(log: FollowDefenseAttackLogEntry): string {
    const parts = [
      this.t('followDefense.v2.log.follows', { count: this.formatNumber(log.totalFollows), rate: log.velocity }),
      this.t('followDefense.v2.startedBy.' + (log.triggeredBy === 'manual' ? 'manual' : 'threshold'))
    ];
    if (log.isRaid) parts.push(this.t('followDefense.v2.log.raid', { name: log.raiderChannelName || log.raiderChannelLogin || '?' }));
    if (log.bannedCount) parts.push(this.t('followDefense.v2.log.banned', { count: this.formatNumber(log.bannedCount) }));
    return parts.join(' · ');
  }

  formatNumber(value: number): string {
    return Math.round(Number(value) || 0).toLocaleString(this.languageService.getCurrentLanguage() === 'es' ? 'es' : 'en');
  }

  formatShortDate(timestamp: number): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(this.languageService.getCurrentLanguage() === 'es' ? 'es' : 'en', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  getExpiresIn(expiresAt: number | undefined): string {
    if (!expiresAt) return '';
    const seconds = Math.floor((expiresAt - Date.now()) / 1000);
    return seconds > 0 ? this.formatDuration(seconds) : '';
  }

  onAttackBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeAttackDialog();
    }
  }

  async activateAttackMode(): Promise<void> {
    if (!this.canManage()) return;
    const channelID = this.channelID();
    const status = this.status();
    const trackedCount = status?.trackedCount ?? 0;

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
      this.toastService.success(
        this.t(response.data?.historicalOnly ? 'raidSessions.queuedTitle' : 'followDefense.toasts.attackActivatedTitle'),
        this.t(response.data?.historicalOnly ? 'raidSessions.recordedScope' : 'followDefense.toasts.attackActivatedMessage')
      );
      this.closeAttackDialog();
      await this.loadStatus(channelID);
    } catch (error) {
      this.toastService.error(
        this.t('followDefense.toasts.errorTitle'),
        error instanceof Error ? error.message : this.t('followDefense.errors.activateFailed')
      );
    } finally {
      this.activatingAttack.set(false);
    }
  }

  async resetMode(): Promise<void> {
    if (!this.canManage()) return;
    const channelID = this.channelID();
    if (!channelID) return;

    try {
      const response = await firstValueFrom(this.followDefenseApi.resetMode(channelID));
      if (response.error) {
        throw new Error(response.message || this.t('followDefense.errors.resetFailed'));
      }
      this.toastService.success(
        this.t('followDefense.toasts.resetSuccessTitle'),
        this.t('followDefense.toasts.resetSuccessMessage')
      );
      await this.loadStatus(channelID);
    } catch (error) {
      this.toastService.error(
        this.t('followDefense.toasts.errorTitle'),
        error instanceof Error ? error.message : this.t('followDefense.errors.resetFailed')
      );
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
    if (seconds < 3600) return seconds % 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
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
    this.logsPagination.update((p) => ({ ...p, page }));
    const channelID = this.channelID();
    if (channelID) {
      await this.loadAttackLogs(channelID);
    }
  }

  async goToHateRaidsPage(page: number): Promise<void> {
    this.hateRaidsPagination.update((p) => ({ ...p, page }));
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
