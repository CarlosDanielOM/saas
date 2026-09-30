import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  catchError,
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
  VariationMode,
  GeneratedVariation,
  ModerationAction,
  ModerationActionLogEntry,
  ModerationOffenseStep,
  ModerationRule,
  ModerationRuleType,
  ModerationSettings,
  OffenseStepKey,
  ModerationPattern,
  ModerationSemanticPolicy,
  ModerationDecisionEntry
} from '../../models/moderation.model';
import {
  MODERATION_ACTION_OPTIONS,
  MODERATION_DEFAULTS,
  MODERATION_RULE_TYPES,
  buildNewModerationRule
} from '../../models/moderation.model';
import { ModerationApiService } from '../../services/moderation-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { whoCanUsePhrase } from '../../models/command.model';
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

export interface LadderRow {
  key: OffenseStepKey;
  labelKey: string;
  step: ModerationOffenseStep;
}

type ListField = 'terms' | 'allowlistDomains';

@Component({
  selector: 'app-moderation-page',
  imports: [RouterLink, LfIconComponent],
  templateUrl: './moderation-page.component.html',
  styleUrl: './moderation-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModerationPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly moderationApi = inject(ModerationApiService);
  private readonly toastService = inject(ToastService);
  private readonly destroy$ = new Subject<void>();

  readonly actionOptions = MODERATION_ACTION_OPTIONS;
  readonly ruleTypes = MODERATION_RULE_TYPES;
  readonly maxRules = MODERATION_DEFAULTS.maxRules;

  readonly settings = signal<ModerationSettings | null>(null);
  readonly initialSettings = signal<ModerationSettings | null>(null);
  readonly logs = signal<ModerationActionLogEntry[]>([]);
  readonly decisions = signal<ModerationDecisionEntry[]>([]);
  readonly decisionsLoading = signal(false);
  readonly decisionsError = signal(false);
  readonly decisionsPagination = signal<PaginationState>({ page: 1, limit: 10, total: 0 });
  readonly settingsLoading = signal(true);
  readonly logsLoading = signal(false);
  readonly savingSettings = signal(false);
  readonly generatingRule = signal<string | null>(null);
  private destroyed = false;
  readonly canManage = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly pendingListInput = signal(false);
  readonly mobileTab = signal<'status' | 'rules' | 'logs' | 'decisions'>('status');
  private readonly ruleOpenState = signal<Record<string, boolean>>({});

  readonly logsPagination = signal<PaginationState>({ page: 1, limit: 10, total: 0 });

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
  readonly hasPaidModeration = computed(() => this.planTier() === 'premium' || this.planTier() === 'pro');

  readonly settingsDirty = computed(() => {
    const current = this.settings();
    const initial = this.initialSettings();
    if (!current || !initial) return false;
    return JSON.stringify(current) !== JSON.stringify(initial) || this.pendingListInput();
  });

  readonly activeRuleCount = computed(
    () => this.settings()?.rules.filter((rule) => rule.enabled).length ?? 0
  );

  readonly totalRuleCount = computed(() => this.settings()?.rules.length ?? 0);

  readonly canAddRule = computed(() => this.totalRuleCount() < this.maxRules);

  private lastLoadedChannelID = '';

  ngOnInit(): void {
    this.channelID$.pipe(takeUntil(this.destroy$)).subscribe((resolution) => {
      this.channelResolution.set(resolution);

      if (resolution.status === 'idle') {
        this.settingsLoading.set(false);
        this.errorMessage.set(this.t('moderation.errors.channelNotResolved'));
        return;
      }

      if (resolution.status === 'loading') {
        this.settingsLoading.set(true);
        return;
      }

      this.settingsLoading.set(false);

      if (!resolution.channelID) {
        this.errorMessage.set(this.t('moderation.errors.channelNotResolved'));
        return;
      }

      if (this.lastLoadedChannelID !== resolution.channelID) {
        this.lastLoadedChannelID = resolution.channelID;
        void this.loadAllData(resolution.channelID);
      }
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.destroy$.next();
    this.destroy$.complete();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  ruleTypeLabel(type: ModerationRuleType, ruleID?: string): string {
    if (ruleID === 'builtin-spam-protection') return this.t('moderation.spam.title');
    return this.t(`moderation.types.${type}`);
  }

  ruleTypeDescription(type: ModerationRuleType): string {
    return this.t(`moderation.typeDescriptions.${type}`);
  }

  actionLabel(action: ModerationAction): string {
    return this.t(`moderation.actions.${action}`);
  }

  ladderRows(rule: ModerationRule): LadderRow[] {
    return [
      { key: 'firstOffense', labelKey: 'moderation.rules.firstOffense', step: rule.firstOffense },
      { key: 'secondOffense', labelKey: 'moderation.rules.secondOffense', step: rule.secondOffense },
      { key: 'thirdOffense', labelKey: 'moderation.rules.thirdOffense', step: rule.thirdOffense }
    ];
  }

  ruleSummary(rule: ModerationRule): string {
    return this.ladderRows(rule)
      .map((row) => {
        const label = this.actionLabel(row.step.action);
        return row.step.action === 'timeout'
          ? `${label} ${this.formatDuration(row.step.timeoutSeconds)}`
          : label;
      })
      .join(' → ');
  }

  isRuleOpen(rule: ModerationRule, totalRules: number): boolean {
    const overrides = this.ruleOpenState();
    return rule.id in overrides ? overrides[rule.id] : totalRules === 1;
  }

  toggleRule(rule: ModerationRule, totalRules: number): void {
    const next = !this.isRuleOpen(rule, totalRules);
    this.ruleOpenState.update((state) => ({ ...state, [rule.id]: next }));
  }

  actionChipClass(action: ModerationAction): string {
    switch (action) {
      case 'ban':
      case 'timeout':
      case 'delete':
        return 'lf-chip lf-chip--danger';
      case 'warn':
        return 'lf-chip lf-chip--warn';
      default:
        return 'lf-chip lf-chip--muted';
    }
  }

  formatTimestamp(value: string): string {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
  }

  readonly exemptLevels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

  whoCanUse(level: number): string {
    return whoCanUsePhrase(level, (key, params) => this.t(key, params));
  }

  offenseWindowMinutes(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 60;
    return Math.max(1, Math.round(seconds / 60));
  }

  updateOffenseWindowMinutes(value: string): void {
    const minutes = Number.parseInt(value, 10);
    if (!Number.isFinite(minutes)) return;
    this.updateOffenseWindow(String(minutes * 60));
  }

  formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  totalLogsPages(): number {
    const { total, limit } = this.logsPagination();
    return Math.max(1, Math.ceil(total / limit));
  }

  getLogsPageNumbers(): number[] {
    const { page, total, limit } = this.logsPagination();
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const pages: number[] = [];
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
      pages.push(i);
    }
    return pages;
  }

  async loadAllData(channelID: string): Promise<void> {
    await Promise.all([
      this.loadSettings(channelID),
      this.loadLogs(channelID),
      this.loadDecisions(channelID),
      this.loadPermission(channelID)
    ]);
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (channelID) {
      await this.loadAllData(channelID);
    }
  }

  private async loadPermission(channelID: string): Promise<void> {
    try {
      const allowed = await firstValueFrom(
        this.sessionAuth
          .checkPermission(channelID, 'moderation:manage')
          .pipe(catchError(() => of(false)))
      );
      this.canManage.set(allowed);
    } catch {
      this.canManage.set(false);
    }
  }

  private async loadSettings(channelID: string): Promise<void> {
    this.settingsLoading.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(this.moderationApi.getSettings(channelID));
      if (response.error || !response.data) {
        throw new Error(response.message || this.t('moderation.errors.loadFailed'));
      }
      this.settings.set(response.data);
      this.initialSettings.set(JSON.parse(JSON.stringify(response.data)));
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('moderation.errors.loadFailed')
      );
    } finally {
      this.settingsLoading.set(false);
    }
  }

  private async loadLogs(channelID: string): Promise<void> {
    this.logsLoading.set(true);
    try {
      const { page, limit } = this.logsPagination();
      const response = await firstValueFrom(this.moderationApi.getLogs(channelID, page, limit));
      if (!response.error && response.data) {
        this.logs.set(response.data.logs);
        this.logsPagination.update((p) => ({ ...p, total: response.data!.total }));
      }
    } catch {
      // non-critical
    } finally {
      this.logsLoading.set(false);
    }
  }

  async goToLogsPage(page: number): Promise<void> {
    const totalPages = this.totalLogsPages();
    if (page < 1 || page > totalPages) return;
    this.logsPagination.update((p) => ({ ...p, page }));
    const channelID = this.channelID();
    if (channelID) {
      await this.loadLogs(channelID);
    }
  }

  async loadDecisions(channelID = this.channelID()): Promise<void> {
    if (!channelID) return;
    this.decisionsLoading.set(true);
    this.decisionsError.set(false);
    try {
      const { page, limit } = this.decisionsPagination();
      const response = await firstValueFrom(this.moderationApi.getDecisions(channelID, page, limit));
      if (response.error || !response.data) throw new Error('Unable to load decisions');
      this.decisions.set(response.data.decisions);
      this.decisionsPagination.update(p => ({ ...p, total: response.data!.total }));
    } catch { this.decisionsError.set(true); }
    finally { this.decisionsLoading.set(false); }
  }

  async goToDecisionsPage(page: number): Promise<void> {
    this.decisionsPagination.update(p => ({ ...p, page }));
    await this.loadDecisions();
  }

  decisionStatus(status: string): string {
    const known = ['pending', 'matched', 'completed', 'uncertain', 'timeout', 'unavailable', 'invalid_response', 'rate_limited', 'quota_exhausted', 'credits_unavailable', 'plan_required', 'policy_changed'];
    return this.t(`moderation.decisions.statuses.${known.includes(status) ? status : 'unavailable'}`);
  }

  async saveSettings(): Promise<void> {
    const channelID = this.channelID();
    const currentSettings = this.settings() ? structuredClone(this.settings()!) : null;

    if (!channelID || !currentSettings || this.savingSettings() || this.generatingRule() || !this.settingsDirty()) {
      return;
    }

    if (!this.canManage()) {
      this.toastService.error(
        this.t('moderation.toasts.errorTitle'),
        this.t('moderation.permission.readOnly')
      );
      return;
    }

    this.savingSettings.set(true);
    this.errorMessage.set(null);

    try {
      if (currentSettings.rules.some(rule => rule.semantic?.enabled && !this.validSemanticThreshold(rule.semantic.thresholdPercent ?? 85))) {
        throw new Error(this.t('moderation.advanced.thresholdInvalid'));
      }
      for (const rule of currentSettings.rules) {
        if (this.hasPaidModeration() && rule.type === 'blacklist' && rule.variations && rule.variations.mode !== 'off') {
          this.generatingRule.set(rule.id);
          rule.variations.entries = await this.fetchVariations(channelID, rule);
        }
      }
      this.generatingRule.set(null);
      if (this.destroyed) return;
      const response = await firstValueFrom(
        this.moderationApi.updateSettings(channelID, {
          enabled: currentSettings.enabled,
          spamProtection: { enabled: currentSettings.spamProtection?.enabled !== false, reviewAllMessages: currentSettings.spamProtection?.reviewAllMessages === true },
          offenseWindowSeconds: currentSettings.offenseWindowSeconds,
          // Generated artifacts are resolved server-side; avoid echoing large previews.
          rules: currentSettings.rules.map(rule => ({ ...rule, variations: rule.variations ? { mode: rule.variations.mode, allowSpaces: rule.variations.allowSpaces ?? false, entries: [], overrides: this.activeVariationOverrides(rule) } : undefined }))
        })
      );
      if (response.error || !response.data) {
        throw new Error(response.message || this.t('moderation.errors.saveFailed'));
      }
      this.settings.set(response.data);
      this.initialSettings.set(JSON.parse(JSON.stringify(response.data)));
      this.toastService.success(
        this.t('moderation.toasts.savedTitle'),
        this.t('moderation.toasts.savedMessage')
      );
      await this.loadLogs(channelID);
    } catch (error) {
      const message =
        error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
          ? error.error.message : error instanceof Error ? error.message : this.t('moderation.errors.saveFailed');
      this.errorMessage.set(message);
      this.toastService.error(this.t('moderation.toasts.errorTitle'), message);
    } finally {
      this.savingSettings.set(false);
      this.generatingRule.set(null);
    }
  }

  updateEnabled(enabled: boolean): void {
    this.settings.update((s) => (s ? { ...s, enabled } : s));
  }

  updateSpamProtection(field: 'enabled' | 'reviewAllMessages', enabled: boolean): void {
    if (!this.canManage() || (field === 'reviewAllMessages' && enabled && !this.hasPaidModeration())) return;
    this.settings.update(settings => settings ? { ...settings, spamProtection: {
      enabled: settings.spamProtection?.enabled !== false,
      reviewAllMessages: settings.spamProtection?.reviewAllMessages === true,
      [field]: enabled
    } } : settings);
  }

  updateOffenseWindow(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(
      MODERATION_DEFAULTS.maxOffenseWindowSeconds,
      Math.max(MODERATION_DEFAULTS.minOffenseWindowSeconds, parsed)
    );
    this.settings.update((s) => (s ? { ...s, offenseWindowSeconds: clamped } : s));
  }

  updateRuleEnabled(ruleID: string, enabled: boolean): void {
    this.patchRule(ruleID, { enabled });
  }

  updateRuleType(ruleID: string, type: string): void {
    if (!MODERATION_RULE_TYPES.includes(type as ModerationRuleType)) return;
    this.patchRule(ruleID, { type: type as ModerationRuleType });
  }

  updateVariationMode(ruleID: string, mode: string): void {
    if (mode !== 'off' && mode !== 'common' && mode !== 'broad') return;
    const prior = this.settings()?.rules.find(item => item.id === ruleID)?.variations;
    this.patchRule(ruleID, { variations: { mode, allowSpaces: mode !== 'off' && (prior?.allowSpaces ?? false), entries: [] } });
  }

  variationExamples(rule: ModerationRule): GeneratedVariation[] {
    const terms = new Set(rule.terms.map(term => term.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()));
    return (rule.variations?.entries ?? []).filter(entry => terms.has(entry.term));
  }

  activeVariationOverrides(rule: ModerationRule) {
    const terms = new Set(rule.terms.map(term => term.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()));
    return (rule.variations?.overrides ?? []).filter(item => terms.has(item.term));
  }

  variationRegex(rule: ModerationRule, entry: GeneratedVariation): string {
    return rule.variations?.overrides?.find(item => item.term === entry.term)?.source ?? entry.pattern.source;
  }

  isVariationEdited(rule: ModerationRule, term: string): boolean {
    return !!rule.variations?.overrides?.some(item => item.term === term);
  }

  editVariationRegex(rule: ModerationRule, entry: GeneratedVariation, source: string): void {
    if (!rule.variations || !this.canManage() || !this.hasPaidModeration()) return;
    const overrides = this.activeVariationOverrides(rule).filter(item => item.term !== entry.term);
    if (source !== entry.pattern.source) overrides.push({ term: entry.term, source });
    this.patchRule(rule.id, { variations: { ...rule.variations, overrides } });
  }

  private async fetchVariations(channelID: string, rule: ModerationRule): Promise<GeneratedVariation[]> {
    const deadline = Date.now() + 310000;
    let response = await firstValueFrom(this.moderationApi.prepareVariations(channelID, rule.terms, rule.variations?.mode ?? 'off', rule.variations?.allowSpaces ?? false));
    while (!this.destroyed && response.data && ['pending', 'processing'].includes(response.data.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (this.destroyed) break;
      response = await firstValueFrom(this.moderationApi.getVariationJob(channelID, response.data.id, rule.variations?.allowSpaces ?? false));
    }
    if (this.destroyed || response.error || response.data?.state !== 'completed') throw new Error(this.t('moderation.variations.failed'));
    return response.data.entries;
  }

  async previewVariations(ruleID: string, allowSpaces?: boolean): Promise<void> {
    const channelID = this.channelID();
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (!channelID || !rule || !this.canManage() || !this.hasPaidModeration() || this.generatingRule() || this.savingSettings()) return;
    this.generatingRule.set(ruleID);
    this.errorMessage.set(null);
    try {
      const spacedRule = allowSpaces === undefined ? rule : { ...rule, variations: { ...rule.variations!, allowSpaces } };
      if (allowSpaces !== undefined) this.patchRule(ruleID, { variations: spacedRule.variations });
      const entries = await this.fetchVariations(channelID, spacedRule);
      if (!this.destroyed) this.patchRule(ruleID, { variations: { allowSpaces: spacedRule.variations?.allowSpaces ?? false, mode: rule.variations?.mode ?? 'off', entries, overrides: this.activeVariationOverrides(rule) } });
    } catch (error) {
      if (!this.destroyed && allowSpaces !== undefined) this.patchRule(ruleID, { variations: rule.variations });
      if (!this.destroyed) this.errorMessage.set(error instanceof HttpErrorResponse && typeof error.error?.message === 'string' ? error.error.message : this.t('moderation.variations.failed'));
    } finally { this.generatingRule.set(null); }
  }

  addPattern(ruleID: string): void {
    if (!this.hasPaidModeration() || !this.canManage()) return;
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (!rule || (rule.patterns?.length ?? 0) >= 10) return;
    this.patchRule(ruleID, { patterns: [...(rule.patterns ?? []), { id: crypto.randomUUID(), source: '', boundary: 'whole_word', ignoreCase: true }] });
  }

  updatePattern(ruleID: string, patternID: string, patch: Partial<ModerationPattern>): void {
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (rule) this.patchRule(ruleID, { patterns: rule.patterns?.map(pattern => pattern.id === patternID ? { ...pattern, ...patch } : pattern) });
  }

  updatePatternBoundary(ruleID: string, patternID: string, boundary: string): void {
    if (boundary === 'whole_word' || boundary === 'anywhere') this.updatePattern(ruleID, patternID, { boundary });
  }

  removePattern(ruleID: string, patternID: string): void {
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (rule) this.patchRule(ruleID, { patterns: rule.patterns?.filter(pattern => pattern.id !== patternID) });
  }

  updateSemantic(ruleID: string, patch: Partial<ModerationSemanticPolicy>): void {
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (rule) this.patchRule(ruleID, { semantic: { enabled: false, thresholdPercent: 85, policy: '', examples: [], onUncertain: 'allow_and_log', ...rule.semantic, ...patch } });
  }

  updateSemanticThreshold(ruleID: string, value: string): void {
    if (!this.canManage() || !this.hasPaidModeration()) return;
    this.updateSemantic(ruleID, { thresholdPercent: value.trim() ? Number(value) : Number.NaN });
  }

  validSemanticThreshold(value: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= 100;
  }

  semanticThresholdValue(rule: ModerationRule): number | string {
    const value = rule.semantic?.thresholdPercent ?? 85;
    return Number.isFinite(value) ? value : '';
  }

  addExample(ruleID: string, label: 'allow' | 'violation'): void {
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (!rule || (rule.semantic?.examples.length ?? 0) >= 10) return;
    this.updateSemantic(ruleID, { examples: [...(rule.semantic?.examples ?? []), { message: '', label }] });
  }

  updateExample(ruleID: string, index: number, message: string): void {
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (rule) this.updateSemantic(ruleID, { examples: rule.semantic?.examples.map((example, i) => i === index ? { ...example, message } : example) });
  }

  removeExample(ruleID: string, index: number): void {
    const rule = this.settings()?.rules.find(item => item.id === ruleID);
    if (rule) this.updateSemantic(ruleID, { examples: rule.semantic?.examples.filter((_, i) => i !== index) });
  }

  updateRuleReason(ruleID: string, reason: string): void {
    this.patchRule(ruleID, { reason });
  }

  updateExemptLevel(ruleID: string, value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    this.patchRule(ruleID, { exemptUserLevel: Math.min(10, Math.max(1, parsed)) });
  }

  updateCapsMode(ruleID: string, mode: string): void {
    if (mode !== 'count' && mode !== 'percentage') return;
    this.patchRule(ruleID, { capsThresholdMode: mode });
  }

  updateNumberField(
    ruleID: string,
    field: 'minCapsCount' | 'maxCapsPercentage' | 'minMessageLength' | 'maxEmoteCount',
    value: string,
    min: number,
    max: number
  ): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    this.patchRule(ruleID, { [field]: Math.min(max, Math.max(min, parsed)) } as Partial<ModerationRule>);
  }

  updateStepAction(ruleID: string, stepKey: OffenseStepKey, action: string): void {
    if (!MODERATION_ACTION_OPTIONS.includes(action as ModerationAction)) return;
    this.patchStep(ruleID, stepKey, { action: action as ModerationAction });
  }

  updateStepTimeout(ruleID: string, stepKey: OffenseStepKey, value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(MODERATION_DEFAULTS.maxTimeoutSeconds, Math.max(1, parsed));
    this.patchStep(ruleID, stepKey, { timeoutSeconds: clamped });
  }

  addRule(type: ModerationRuleType): void {
    if (!this.canAddRule()) return;
    this.settings.update((s) => (s ? { ...s, rules: [...s.rules, buildNewModerationRule(type)] } : s));
  }

  removeRule(ruleID: string): void {
    this.settings.update((s) =>
      s ? { ...s, rules: s.rules.filter((rule) => rule.id !== ruleID) } : s
    );
  }

  onListInput(value: string): void {
    this.pendingListInput.set(value.trim().length > 0);
  }

  addListItems(ruleID: string, field: ListField, input: HTMLInputElement): void {
    const raw = input.value;
    input.value = '';
    this.pendingListInput.set(false);

    const candidates = raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (candidates.length === 0) return;

    this.settings.update((s) => {
      if (!s) return s;
      return {
        ...s,
        rules: s.rules.map((rule) => {
          if (rule.id !== ruleID) return rule;

          const existing = rule[field];
          const seen = new Set(existing.map((item) => item.toLowerCase()));
          const additions: string[] = [];

          for (const candidate of candidates) {
            const key = candidate.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            additions.push(candidate);
          }

          if (additions.length === 0) return rule;
          return { ...rule, [field]: [...existing, ...additions] } as ModerationRule;
        })
      };
    });
  }

  removeListItem(ruleID: string, field: ListField, index: number): void {
    this.settings.update((s) => {
      if (!s) return s;
      return {
        ...s,
        rules: s.rules.map((rule) =>
          rule.id === ruleID
            ? ({ ...rule, [field]: rule[field].filter((_, i) => i !== index) } as ModerationRule)
            : rule
        )
      };
    });
  }

  private patchRule(ruleID: string, patch: Partial<ModerationRule>): void {
    this.settings.update((s) =>
      s
        ? { ...s, rules: s.rules.map((rule) => (rule.id === ruleID ? { ...rule, ...patch } : rule)) }
        : s
    );
  }

  private patchStep(
    ruleID: string,
    stepKey: OffenseStepKey,
    patch: Partial<ModerationOffenseStep>
  ): void {
    this.settings.update((s) => {
      if (!s) return s;
      return {
        ...s,
        rules: s.rules.map((rule) => {
          if (rule.id !== ruleID) return rule;
          const nextRule: ModerationRule = { ...rule };
          nextRule[stepKey] = { ...rule[stepKey], ...patch };
          return nextRule;
        })
      };
    });
  }
}
