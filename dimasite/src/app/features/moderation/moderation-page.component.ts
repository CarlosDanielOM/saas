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
  ModerationAction,
  ModerationActionLogEntry,
  ModerationOffenseStep,
  ModerationRule,
  ModerationRuleType,
  ModerationSettings,
  OffenseStepKey
} from '../../models/moderation.model';
import {
  MODERATION_ACTION_OPTIONS,
  MODERATION_DEFAULTS,
  MODERATION_RULE_TYPES,
  buildNewModerationRule
} from '../../models/moderation.model';
import {
  ACCESS_TAGS,
  buildAccessExpression,
  cycleAccessTag,
  emptyAccessDraft,
  hasAccessRules,
  parseAccessDraft,
  type AccessDraft,
  type AccessTag,
  type TagDecision,
  type TwitchAccountRef
} from '../../models/permission-expression.model';
import { ModerationApiService } from '../../services/moderation-api.service';
import { TwitchAccountLookupService } from '../../services/twitch-account-lookup.service';
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
  private readonly accountLookup = inject(TwitchAccountLookupService);
  private readonly toastService = inject(ToastService);
  private readonly destroy$ = new Subject<void>();

  readonly actionOptions = MODERATION_ACTION_OPTIONS;
  readonly ruleTypes = MODERATION_RULE_TYPES;
  readonly maxRules = MODERATION_DEFAULTS.maxRules;

  readonly settings = signal<ModerationSettings | null>(null);
  readonly initialSettings = signal<ModerationSettings | null>(null);
  readonly logs = signal<ModerationActionLogEntry[]>([]);
  readonly settingsLoading = signal(true);
  readonly logsLoading = signal(false);
  readonly savingSettings = signal(false);
  readonly canManage = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly pendingListInput = signal(false);
  readonly accessTags = ACCESS_TAGS;
  readonly accessLookupInputs = signal<Record<string, string>>({});
  readonly accessLookupPending = signal<string | null>(null);
  readonly accessLookupError = signal<Record<string, string>>({});
  readonly maxUsersPerList = 5;
  private accessGeneration = 0;

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
    this.accessGeneration += 1;
    this.destroy$.next();
    this.destroy$.complete();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  ruleTypeLabel(type: ModerationRuleType): string {
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

  formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
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
    this.accessGeneration += 1;
    this.accessLookupInputs.set({});
    this.accessLookupError.set({});
    this.accessLookupPending.set(null);
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

  async saveSettings(): Promise<void> {
    const channelID = this.channelID();
    const currentSettings = this.settings();

    if (!channelID || !currentSettings || this.savingSettings() || !this.settingsDirty()) {
      return;
    }

    if (!this.canManage()) {
      this.toastService.error(
        this.t('moderation.toasts.errorTitle'),
        this.t('moderation.permission.readOnly')
      );
      return;
    }

    if (currentSettings.rules.some((rule) =>
      rule.exemptExpression != null && this.ruleAccessDraft(rule).legacyCombined)) {
      this.errorMessage.set(this.t('moderation.access.chooseMethod'));
      return;
    }

    if (this.accessLookupPending() || Object.values(this.accessLookupInputs()).some((value) => value.trim())) {
      this.errorMessage.set(this.t('moderation.access.finishUsername'));
      return;
    }

    this.savingSettings.set(true);
    this.errorMessage.set(null);

    try {
      const response = await firstValueFrom(
        this.moderationApi.updateSettings(channelID, {
          enabled: currentSettings.enabled,
          offenseWindowSeconds: currentSettings.offenseWindowSeconds,
          rules: currentSettings.rules
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
        error instanceof Error ? error.message : this.t('moderation.errors.saveFailed');
      this.errorMessage.set(message);
      this.toastService.error(this.t('moderation.toasts.errorTitle'), message);
    } finally {
      this.savingSettings.set(false);
    }
  }

  updateEnabled(enabled: boolean): void {
    this.settings.update((s) => (s ? { ...s, enabled } : s));
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

  updateRuleReason(ruleID: string, reason: string): void {
    this.patchRule(ruleID, { reason });
  }

  updateExemptLevel(ruleID: string, value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    this.patchRule(ruleID, { exemptUserLevel: Math.min(10, Math.max(1, parsed)) });
  }

  ruleAccessMode(rule: ModerationRule): 'level' | 'tags' {
    return rule.exemptExpression == null ? 'level' : 'tags';
  }

  ruleAccessDraft(rule: ModerationRule): AccessDraft {
    return parseAccessDraft(rule.exemptExpression);
  }

  ruleTagDecision(rule: ModerationRule, tag: AccessTag): TagDecision {
    return this.ruleAccessDraft(rule).tags[tag];
  }

  ruleTagLabel(tag: AccessTag): string {
    return this.t(`commands.access.tags.${tag}`);
  }

  setRuleAccessMode(rule: ModerationRule, mode: 'level' | 'tags'): void {
    if (!this.canManage() || mode === this.ruleAccessMode(rule)) return;
    this.accessGeneration += 1;
    this.accessLookupPending.set(null);
    this.clearRuleLookup(rule.id);
    this.patchRule(rule.id, { exemptExpression: mode === 'level' ? null : { not: { role: 'everyone' } } });
  }

  resetRuleTags(ruleID: string): void {
    if (!this.canManage()) return;
    this.patchRule(ruleID, { exemptExpression: { not: { role: 'everyone' } } });
    this.accessLookupError.update((errors) => ({ ...errors, [ruleID]: '' }));
  }

  cycleRuleTag(rule: ModerationRule, tag: AccessTag): void {
    if (!this.canManage()) return;
    const draft = this.ruleAccessDraft(rule);
    if (!draft.editable) return;
    let next = cycleAccessTag(draft, tag);
    if (!hasAccessRules(next)) {
      // The persisted tag mode needs an expression. Keep the safe "nobody
      // exempt" state when the final specific rule is cleared; let the
      // Everyone chip toggle directly to exempting everyone.
      next = emptyAccessDraft();
      next.tags.everyone = tag === 'everyone' ? 'allow' : 'exclude';
    }
    this.patchRule(rule.id, { exemptExpression: buildAccessExpression(next) });
    this.accessLookupError.update((errors) => ({ ...errors, [rule.id]: '' }));
  }

  ruleAccountCount(rule: ModerationRule): number {
    const draft = this.ruleAccessDraft(rule);
    return draft.allowUsers.length + draft.excludeUsers.length;
  }

  ruleAccountInput(ruleID: string, kind: 'allow' | 'exclude'): string {
    return this.accessLookupInputs()[`${ruleID}:${kind}`] ?? '';
  }

  setRuleAccountInput(ruleID: string, kind: 'allow' | 'exclude', value: string): void {
    this.accessLookupInputs.update((inputs) => ({ ...inputs, [`${ruleID}:${kind}`]: value }));
    this.accessLookupError.update((errors) => ({ ...errors, [ruleID]: '' }));
  }

  canAddRuleAccount(rule: ModerationRule, kind: 'allow' | 'exclude'): boolean {
    const draft = this.ruleAccessDraft(rule);
    return draft.editable && draft[kind === 'allow' ? 'allowUsers' : 'excludeUsers'].length < this.maxUsersPerList;
  }

  async addRuleAccount(rule: ModerationRule, kind: 'allow' | 'exclude'): Promise<void> {
    if (!this.canManage() || this.accessLookupPending() || !this.canAddRuleAccount(rule, kind)) return;
    const key = `${rule.id}:${kind}`;
    const input = this.ruleAccountInput(rule.id, kind);
    const generation = this.accessGeneration;
    this.accessLookupPending.set(key);
    this.accessLookupError.update((errors) => ({ ...errors, [rule.id]: '' }));
    try {
      const user = await firstValueFrom(this.accountLookup.lookup(input));
      if (generation !== this.accessGeneration) return;
      const currentRule = this.settings()?.rules.find((item) => item.id === rule.id);
      if (!currentRule || this.ruleAccessMode(currentRule) !== 'tags') return;
      const draft = this.ruleAccessDraft(currentRule);
      const target = kind === 'allow' ? 'allowUsers' : 'excludeUsers';
      const opposite = kind === 'allow' ? 'excludeUsers' : 'allowUsers';
      if (draft[target].some((entry) => entry.id === user.id)) {
        this.accessLookupError.update((errors) => ({ ...errors, [rule.id]: this.t('commands.access.alreadyAdded') }));
        return;
      }
      const next: AccessDraft = {
        ...draft,
        [target]: [...draft[target], user],
        [opposite]: draft[opposite].filter((entry) => entry.id !== user.id)
      };
      this.patchRule(rule.id, { exemptExpression: buildAccessExpression(next) });
      this.setRuleAccountInput(rule.id, kind, '');
    } catch {
      if (generation === this.accessGeneration) {
        this.accessLookupError.update((errors) => ({ ...errors, [rule.id]: this.t('commands.access.lookupError') }));
      }
    } finally {
      if (generation === this.accessGeneration) this.accessLookupPending.set(null);
    }
  }

  removeRuleAccount(rule: ModerationRule, kind: 'allow' | 'exclude', user: TwitchAccountRef): void {
    if (!this.canManage()) return;
    const draft = this.ruleAccessDraft(rule);
    if (!draft.editable) return;
    const key = kind === 'allow' ? 'allowUsers' : 'excludeUsers';
    let next: AccessDraft = { ...draft, [key]: draft[key].filter((entry) => entry.id !== user.id) };
    if (!hasAccessRules(next)) {
      next = emptyAccessDraft();
      next.tags.everyone = 'exclude';
    }
    this.patchRule(rule.id, { exemptExpression: buildAccessExpression(next) });
  }

  private clearRuleLookup(ruleID: string): void {
    this.accessLookupInputs.update((inputs) => {
      const next = { ...inputs };
      delete next[`${ruleID}:allow`];
      delete next[`${ruleID}:exclude`];
      return next;
    });
    this.accessLookupError.update((errors) => {
      const next = { ...errors };
      delete next[ruleID];
      return next;
    });
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
    this.accessGeneration += 1;
    this.accessLookupPending.set(null);
    this.clearRuleLookup(ruleID);
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
