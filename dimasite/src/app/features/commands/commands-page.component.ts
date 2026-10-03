import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { catchError, combineLatest, map, of, switchMap } from 'rxjs';

import { Command, CreateCommandRequest, UpdateCommandRequest, USER_LEVELS, USER_LEVEL_NAMES, whoCanUsePhrase } from '../../models/command.model';
import { CommandsApiService } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { TimersApiService } from '../../services/timers-api.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import {
  BUILTIN_GROUP_ORDER,
  BuiltinGroup,
  ReplyPart,
  builtinInfo,
  customUsage,
  formatUsage,
  realDescription,
  replyParts
} from './builtin-commands';
import { CommandModalComponent, CommandModalSavePayload, PlanTier } from './command-modal.component';

export type CommandFilter = 'all' | 'custom' | 'keyword' | 'timer' | 'builtin' | 'off';
type CommandKind = 'reserved' | 'timer' | 'normal' | 'keyword';
type PendingOperation = 'create' | 'update' | 'enable' | 'disable' | 'delete';
type CommandFeedbackState = 'success' | 'error';

interface CommandListItem extends Command {
  pendingOperation?: PendingOperation;
  optimistic?: boolean;
}

@Component({
  selector: 'app-commands-page',
  imports: [ReactiveFormsModule, NgTemplateOutlet, ConfirmationModalComponent, CommandModalComponent, LfIconComponent],
  templateUrl: './commands-page.component.html',
  styleUrl: './commands-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onDocumentEscape()'
  }
})
export class CommandsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly commandsApi = inject(CommandsApiService);
  private readonly timersApi = inject(TimersApiService);
  private readonly toastService = inject(ToastService);

  // Route params - resolved to channelID
  readonly channelID = signal<string | null>(null);
  private readonly manageAccess = toSignal(toObservable(this.channelID).pipe(
    switchMap((channelID) => channelID
      ? this.sessionAuth.checkPermission(channelID, 'commands:manage').pipe(
          map((allowed) => ({ channelID, allowed })),
          catchError(() => of({ channelID, allowed: false }))
        )
      : of({ channelID: null, allowed: false }))
  ), { initialValue: { channelID: null as string | null, allowed: false } });
  readonly canManage = computed(() => this.manageAccess().channelID === this.channelID() && this.manageAccess().allowed);
  private readonly routeStreamer$ = combineLatest([
    this.route.paramMap,
    this.route.parent?.paramMap ?? of(convertToParamMap({}))
  ]).pipe(
    map(([currentParams, parentParams]) => currentParams.get('streamer') ?? parentParams.get('streamer') ?? '')
  );
  readonly streamer = toSignal(this.routeStreamer$, {
    initialValue:
      this.route.snapshot.paramMap.get('streamer') ??
      this.route.parent?.snapshot.paramMap.get('streamer') ??
      ''
  });
  private readonly streamerParam = toSignal(
    this.routeStreamer$.pipe(
      switchMap((streamer) => {
        if (!streamer) {
          return of(this.sessionAuth.getPrimaryChannelID());
        }
        return this.sessionAuth.resolveChannelID(streamer);
      })
    ),
    { initialValue: null }
  );

  // Data signals
  readonly commands = signal<CommandListItem[]>([]);
  activationLabel(command: Command): string {
    return command.activation === 'keyword' ? command.cmd : `!${command.cmd}`;
  }

  matchModeLabel(command: Command): string {
    return this.t(`keywords.match.${command.keywordSettings?.matchMode ?? 'start'}`);
  }
  readonly loading = computed(() => this.commandsApi.listLoading());
  readonly error = computed(() => this.commandsApi.listError());
  readonly showInitialLoading = computed(() => this.loading() && this.commands().length === 0);
  readonly showLoadError = computed(() => !!this.error() && this.commands().length === 0);

  // Search state
  readonly searchInput = signal('');

  // Filter state
  readonly filter = signal<CommandFilter>('all');
  readonly builtinGroupOrder = BUILTIN_GROUP_ORDER;
  readonly publicCopied = signal(false);
  readonly newItemKind = signal<'command' | 'keyword'>('command');
  /** Timer names from GET /timers/:channelID — used for list styling + modal prefill. */
  readonly timerNames = signal<Set<string>>(new Set());
  /** Timer interval (minutes) keyed by timer name. */
  readonly timerMinutesByName = signal<Map<string, number>>(new Map());

  // Modal state
  readonly showCommandModal = signal(false);
  readonly editingCommand = signal<Command | null>(null);

  // Delete confirmation
  readonly showDeleteModal = signal(false);
  readonly commandToDelete = signal<Command | null>(null);

  // Rate limiting
  private readonly requestTimestamps = signal<number[]>([]);
  private readonly RATE_LIMIT_REQUESTS = 15;
  private readonly RATE_LIMIT_WINDOW = 60 * 1000;
  private readonly RATE_LIMIT_BLOCK_DURATION = 60 * 1000;
  private readonly isRateLimited = signal(false);
  private readonly rateLimitEndTime = signal(0);
  private readonly commandSnapshots = new Map<string, CommandListItem>();
  private readonly commandFeedback = signal<Record<string, CommandFeedbackState>>({});
  private readonly commandFeedbackTimers = new Map<string, number>();

  // Computed
  readonly planTier = computed((): PlanTier => {
    return this.sessionAuth.getPlanTierForStreamer(this.streamer());
  });

  readonly planLabel = computed(() => {
    const tier = this.planTier();
    if (tier === 'premium') {
      return this.t('navbar.planPremium');
    }
    if (tier === 'pro') {
      return this.t('navbar.planPro');
    }
    return this.t('navbar.planFree');
  });

  /** Prefill interval when editing a timer-linked command. */
  readonly editingTimerMinutes = computed((): number | null => {
    const command = this.editingCommand();
    if (!command) {
      return null;
    }
    return this.getTimerMinutesForCommand(command);
  });
  readonly streamerLabel = computed(() => {
    const fromRoute =
      this.route.snapshot.paramMap.get('streamer') ||
      this.route.parent?.snapshot.paramMap.get('streamer') ||
      '';
    return fromRoute || this.sessionAuth.session()?.twitchUser.login || '—';
  });
  readonly totalCommands = computed(() => this.commands().length);
  readonly enabledCommands = computed(() => this.commands().filter((command) => command.enabled !== false).length);
  readonly disabledCommands = computed(() => this.commands().filter((command) => command.enabled === false).length);

  /** Commands the streamer wrote (including ones that repeat on a timer). */
  readonly customList = computed(() =>
    this.byName(this.commands().filter((command) => command.activation !== 'keyword' && !command.reserved)));
  readonly keywordList = computed(() => this.byName(this.commands().filter((command) => command.activation === 'keyword')));
  readonly builtinList = computed(() => this.commands().filter((command) => command.reserved && command.activation !== 'keyword'));
  readonly timerList = computed(() => this.customList().filter((command) => this.isTimerLinked(command)));
  readonly offList = computed(() => this.byName(this.commands().filter((command) => command.enabled === false)));

  readonly builtinGroups = computed(() => {
    const groups = new Map<BuiltinGroup, CommandListItem[]>();
    for (const command of this.builtinList()) {
      const group = builtinInfo(command).group;
      groups.set(group, [...(groups.get(group) ?? []), command]);
    }
    return BUILTIN_GROUP_ORDER
      .filter((group) => groups.has(group))
      .map((group) => {
        const items = [...(groups.get(group) ?? [])].sort((a, b) => a.cmd.localeCompare(b.cmd));
        return { group, items, on: items.filter((c) => c.enabled !== false).length };
      });
  });

  readonly filterCounts = computed<Record<CommandFilter, number>>(() => ({
    all: this.totalCommands(),
    custom: this.customList().length,
    keyword: this.keywordList().length,
    timer: this.timerList().length,
    builtin: this.builtinList().length,
    off: this.offList().length
  }));

  /** Flat results while searching: name, trigger, reply or built-in description. */
  readonly searchResults = computed(() => {
    const query = this.searchInput().trim().toLowerCase().replace(/^!/, '');
    if (!query) return [];
    return this.byName(this.commands().filter((command) =>
      [command.name, command.cmd, command.message, command.reserved ? this.builtinDescription(command) : '']
        .join(' ')
        .toLowerCase()
        .includes(query)));
  });

  readonly isSearching = computed(() => this.searchInput().trim().length > 0);

  /** Always-useful filters, plus the others once they have something to show. */
  readonly visibleFilters = computed(() => {
    const counts = this.filterCounts();
    return (['all', 'custom', 'keyword', 'timer', 'builtin', 'off'] as const)
      .filter((option) => option === 'all' || option === 'custom' || option === 'builtin' || counts[option] > 0);
  });

  readonly publicUrl = computed(() => {
    const streamer = this.streamerLabel();
    if (!streamer || streamer === '—' || typeof window === 'undefined') return '';
    return `${window.location.origin}/commands/${encodeURIComponent(streamer)}`;
  });

  // Effects
  private readonly resolveChannelEffect = effect(() => {
    const resolvedID = this.streamerParam();
    this.channelID.set(resolvedID);

    if (!resolvedID) {
      this.commands.set([]);
    }
  });

  private readonly loadCommandsEffect = effect(() => {
    const channelID = this.channelID();
    this.languageService.currentLanguage();

    // Cached command responses emit synchronously. Pagination reads and the
    // auth interceptor's session reads must not become fetch dependencies.
    untracked(() => {
      if (channelID) {
        this.loadCommands(channelID);
        this.loadTimerNames(channelID);
      } else {
        this.timerNames.set(new Set());
        this.timerMinutesByName.set(new Map());
      }
    });
  });

  ngOnDestroy(): void {
    this.clearAllCommandFeedbackTimers();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  // ========== Command ID Helpers ==========

  private getCommandId(command: Pick<Command, 'id' | '_id'>): string {
    return command.id || command._id || '';
  }

  commandTrackId(command: Pick<Command, 'id' | '_id'>): string {
    return this.getCommandId(command);
  }

  private matchesCommand(command: Pick<Command, 'id' | '_id'>, commandId: string): boolean {
    return this.getCommandId(command) === commandId;
  }

  // ========== Loading Commands ==========

  loadCommands(channelID: string, options: { skipCache?: boolean } = {}): void {
    this.commandsApi.getCommands(channelID, { skipCache: options.skipCache, activation: 'all', limit: 1000 }).subscribe({
      next: (cmds) => {
        this.commands.set(this.normalizeCommands(cmds));
        this.syncCurrentPage();
      },
      error: (err) => {
        this.toastService.error(this.t('commands.toast.loadErrorTitle'), err.message || this.t('commands.toast.loadErrorMessage'));
      }
    });
  }

  hardRefreshCommands(): void {
    const channelID = this.channelID();
    if (!channelID) {
      this.toastService.error(this.t('commands.toast.loadErrorTitle'), this.t('commands.toast.missingChannel'));
      return;
    }

    this.loadCommands(channelID, { skipCache: true });
    this.toastService.success(this.t('commands.toast.refreshSuccessTitle'), this.languageService.translate('commands.toast.refreshSuccessMessage', { count: 0 }));
  }

  private normalizeCommands(commands: Command[]): CommandListItem[] {
    return commands.map((command) => ({ ...command }));
  }

  private syncCurrentPage(): void {
    // Lists aren't paginated any more; kept so create/delete flows read the same.
  }

  // ========== Search + filters ==========

  onSearchInput(value: string): void {
    this.searchInput.set(value);
  }

  setFilter(filter: CommandFilter): void {
    this.filter.set(filter);
    this.searchInput.set('');
  }

  private byName<T extends Command>(commands: T[]): T[] {
    return [...commands].sort((a, b) => (a.name || a.cmd).localeCompare(b.name || b.cmd, undefined, { sensitivity: 'base' }));
  }

  isTimerLinked(command: Pick<Command, 'cmd' | 'name' | 'reserved' | 'activation'>): boolean {
    if (command.reserved || command.activation === 'keyword') {
      return false;
    }
    const names = this.timerNames();
    if (names.size === 0) {
      return false;
    }
    const cmd = (command.cmd || '').trim().toLowerCase();
    const name = (command.name || '').trim().toLowerCase();
    return (cmd !== '' && names.has(cmd)) || (name !== '' && names.has(name));
  }

  commandKind(command: Pick<Command, 'cmd' | 'name' | 'reserved' | 'activation'>): CommandKind {
    if (command.activation === 'keyword') return 'keyword';
    if (command.reserved) {
      return 'reserved';
    }
    if (this.isTimerLinked(command)) {
      return 'timer';
    }
    return 'normal';
  }

  // ========== Modal Handlers ==========

  openCreateModal(): void {
    if (!this.canManage()) return;
    if (!this.checkRateLimit()) return;
    this.editingCommand.set(null);
    this.showCommandModal.set(true);
  }

  openEditModal(command: Command): void {
    if (!this.canManage()) return;
    if (!this.checkRateLimit()) return;
    this.editingCommand.set(command);
    this.showCommandModal.set(true);
  }

  closeModal(): void {
    this.showCommandModal.set(false);
    this.editingCommand.set(null);
  }

  onModalSave(payload: CommandModalSavePayload): void {
    if (!this.canManage()) return;
    const channelID = this.channelID();
    if (!channelID) return;

    const session = this.sessionAuth.session();
    if (!session) return;

    const request = payload.command;
    const editingCmd = this.editingCommand();
    const previousTimerName = editingCmd ? this.resolveTimerName(editingCmd) : null;

    if (editingCmd) {
      const commandId = this.getCommandId(editingCmd);
      const updates: UpdateCommandRequest = {
        ...(request.keywordSettings ? { keywordSettings: request.keywordSettings } : {}),
        name: request.name,
        cmd: request.cmd,
        message: request.message,
        description: request.description || null,
        cooldown: request.cooldown,
        userLevel: request.userLevel,
        userLevelName: USER_LEVELS[request.userLevel],
        enabled: request.enabled,
        ...(request.permissionExpression !== undefined
          ? { permissionExpression: request.permissionExpression }
          : {})
      };

      this.recordRequest();
      this.commandSnapshots.set(commandId, { ...editingCmd });
      this.updateCommandItem(commandId, (cmd) => ({
        ...cmd,
        ...updates,
        permissionMode: updates.permissionExpression === undefined
          ? cmd.permissionMode
          : updates.permissionExpression === null ? 'level' : 'tags',
        pendingOperation: 'update'
      }));
      this.closeModal();

      this.commandsApi.updateCommand(channelID, commandId, updates).subscribe((updated) => {
        if (updated) {
          this.replaceCommandItem(commandId, updated);
          this.clearCommandSnapshot(commandId);
          this.setCommandFeedbackState(this.getCommandId(updated), 'success');
          this.toastService.success(this.t('commands.toast.savedTitle'), this.t('commands.toast.savedMessage'));
          if (updated.activation !== 'keyword') this.syncCommandTimer(channelID, updated.cmd || request.cmd, previousTimerName, request.message, payload.timer);
        } else {
          this.restoreCommandSnapshot(commandId);
          this.setCommandFeedbackState(commandId, 'error');
          this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
        }
      });
    } else {
      const newCommand: CreateCommandRequest = {
        ...request,
        channel: session.twitchUser.login || channelID
      };

      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticCommand = this.buildOptimisticCommand(tempId, channelID, newCommand);

      this.recordRequest();
      this.commands.update((cmds) => [...cmds, optimisticCommand]);
      this.closeModal();

      this.commandsApi.createCommand(channelID, newCommand).subscribe((created) => {
        if (created) {
          this.replaceCommandItem(tempId, created);
          this.setCommandFeedbackState(this.getCommandId(created), 'success');
          this.toastService.success(this.t('commands.toast.createdTitle'), this.t('commands.toast.createdMessage'));
          if (created.activation !== 'keyword') this.syncCommandTimer(channelID, created.cmd || request.cmd, null, request.message, payload.timer);
        } else {
          this.setCommandFeedbackState(tempId, 'error');
          window.setTimeout(() => {
            this.commands.update((cmds) => cmds.filter((cmd) => !this.matchesCommand(cmd, tempId)));
          }, 650);
          this.toastService.error(this.t('commands.toast.createErrorTitle'), this.t('commands.toast.createErrorMessage'));
        }
      });
    }
  }

  private buildOptimisticCommand(tempId: string, channelID: string, command: CreateCommandRequest): CommandListItem {
    return {
      id: tempId,
      _id: tempId,
      channel: command.channel,
      channelID,
      cmd: command.cmd,
      activation: command.activation,
      keywordSettings: command.keywordSettings,
      func: command.func,
      cooldown: command.cooldown,
      createdAt: new Date().toISOString(),
      description: command.description ?? null,
      enabled: command.enabled,
      message: command.message,
      name: command.name,
      reserved: false,
      userLevel: command.userLevel,
      userLevelName: command.userLevelName,
      permissionExpression: command.permissionExpression ?? null,
      permissionMode: command.permissionExpression ? 'tags' : 'level',
      pendingOperation: 'create',
      optimistic: true
    };
  }

  // ========== Enable/Disable ==========

  enableCommand(commandId: string, onFail?: () => void): void {
    if (!this.canManage()) return;
    if (!this.checkRateLimit()) return;
    if (this.isPending(commandId)) return;

    const channelID = this.channelID();
    if (!channelID) return;

    const command = this.commands().find((c) => this.matchesCommand(c, commandId));
    if (!command) return;

    this.recordRequest();
    this.commandSnapshots.set(commandId, { ...command });
    this.updateCommandItem(commandId, (currentCommand) => ({
      ...currentCommand,
      enabled: true,
      pendingOperation: 'enable'
    }));

    this.commandsApi.enableCommand(channelID, commandId).subscribe((updated) => {
      if (updated) {
        this.replaceCommandItem(commandId, updated);
        this.clearCommandSnapshot(commandId);
        this.setCommandFeedbackState(this.getCommandId(updated), 'success');
        this.toastService.success(this.t('commands.toast.enabledTitle'), this.t('commands.toast.enabledMessage'));
      } else {
        this.restoreCommandSnapshot(commandId);
        onFail?.();
        this.setCommandFeedbackState(commandId, 'error');
        this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
      }
    });
  }

  disableCommand(commandId: string, onFail?: () => void): void {
    if (!this.canManage()) return;
    if (!this.checkRateLimit()) return;
    if (this.isPending(commandId)) return;

    const channelID = this.channelID();
    if (!channelID) return;

    const command = this.commands().find((c) => this.matchesCommand(c, commandId));
    if (!command) return;

    this.recordRequest();
    this.commandSnapshots.set(commandId, { ...command });
    this.updateCommandItem(commandId, (currentCommand) => ({
      ...currentCommand,
      enabled: false,
      pendingOperation: 'disable'
    }));

    this.commandsApi.disableCommand(channelID, commandId).subscribe((updated) => {
      if (updated) {
        this.replaceCommandItem(commandId, updated);
        this.clearCommandSnapshot(commandId);
        this.setCommandFeedbackState(this.getCommandId(updated), 'success');
        this.toastService.success(this.t('commands.toast.disabledTitle'), this.t('commands.toast.disabledMessage'));
      } else {
        this.restoreCommandSnapshot(commandId);
        onFail?.();
        this.setCommandFeedbackState(commandId, 'error');
        this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
      }
    });
  }

  // ========== Delete ==========

  promptDeleteCommand(command: Command): void {
    if (!this.canManage()) return;
    const commandId = this.getCommandId(command);
    if (command.reserved || !commandId || this.isPending(commandId)) return;
    this.commandToDelete.set(command);
    this.showDeleteModal.set(true);
  }

  confirmDelete(): void {
    if (!this.canManage()) return;
    const command = this.commandToDelete();
    if (!command) return;

    const commandId = command.id || command._id;
    if (!commandId) return;

    if (!this.checkRateLimit()) {
      this.closeDeleteModal();
      return;
    }

    const channelID = this.channelID();
    if (!channelID) return;

    this.recordRequest();
    this.commandSnapshots.set(commandId, { ...(command as CommandListItem) });
    this.updateCommandItem(commandId, (currentCommand) => ({
      ...currentCommand,
      pendingOperation: 'delete'
    }));
    this.closeDeleteModal();

    const timerName = this.resolveTimerName(command);

    this.commandsApi.deleteCommand(channelID, commandId).subscribe((success) => {
      if (success) {
        this.commands.update((cmds) => cmds.filter((c) => !this.matchesCommand(c, commandId)));
        this.clearCommandSnapshot(commandId);
        this.syncCurrentPage();
        this.toastService.success(this.t('commands.toast.deletedTitle'), this.t('commands.toast.deletedMessage'));
        if (timerName) {
          this.timersApi.deleteTimer(channelID, timerName).subscribe(() => this.loadTimerNames(channelID));
        }
      } else {
        this.restoreCommandSnapshot(commandId);
        this.setCommandFeedbackState(commandId, 'error');
        this.toastService.error(this.t('commands.toast.deleteErrorTitle'), this.t('commands.toast.deleteErrorMessage'));
      }
    });
  }

  closeDeleteModal(): void {
    this.showDeleteModal.set(false);
    this.commandToDelete.set(null);
  }

  // ========== Pending State Helpers ==========

  isPending(commandId: string): boolean {
    return this.commands().some((command) => this.matchesCommand(command, commandId) && !!command.pendingOperation);
  }

  isPendingDelete(commandId: string): boolean {
    return this.getPendingOperation(commandId) === 'delete';
  }

  getPendingOperation(commandId: string): PendingOperation | null {
    return this.commands().find((command) => this.matchesCommand(command, commandId))?.pendingOperation ?? null;
  }

  getPendingLabel(commandId: string): string {
    switch (this.getPendingOperation(commandId)) {
      case 'create': return this.t('commands.pending.creating');
      case 'delete': return this.t('commands.pending.deleting');
      case 'enable': return this.t('commands.pending.enabling');
      case 'disable': return this.t('commands.pending.disabling');
      case 'update': return this.t('commands.pending.saving');
      default: return '';
    }
  }

  getCommandFeedbackState(commandId: string): CommandFeedbackState | null {
    return this.commandFeedback()[commandId] ?? null;
  }

  private setCommandFeedbackState(commandId: string, state: CommandFeedbackState): void {
    const existingTimer = this.commandFeedbackTimers.get(commandId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    this.commandFeedback.update((feedback) => ({ ...feedback, [commandId]: state }));

    const timerId = window.setTimeout(() => {
      this.commandFeedback.update((feedback) => {
        const { [commandId]: _removed, ...rest } = feedback;
        return rest;
      });
      this.commandFeedbackTimers.delete(commandId);
    }, 1600);

    this.commandFeedbackTimers.set(commandId, timerId);
  }

  private clearAllCommandFeedbackTimers(): void {
    for (const timerId of this.commandFeedbackTimers.values()) {
      window.clearTimeout(timerId);
    }
    this.commandFeedbackTimers.clear();
  }

  private updateCommandItem(commandId: string, updater: (command: CommandListItem) => CommandListItem): void {
    this.commands.update((commands) =>
      commands.map((command) => (this.matchesCommand(command, commandId) ? updater(command) : command))
    );
  }

  private replaceCommandItem(commandId: string, command: Command): void {
    const normalizedCommand = this.normalizeCommand(command);

    this.commands.update((commands) =>
      commands.map((currentCommand) =>
        this.matchesCommand(currentCommand, commandId) ? normalizedCommand : currentCommand
      )
    );
  }

  private normalizeCommand(command: Command): CommandListItem {
    return { ...command };
  }

  private restoreCommandSnapshot(commandId: string): void {
    const snapshot = this.commandSnapshots.get(commandId);
    if (!snapshot) return;

    this.updateCommandItem(commandId, () => snapshot);
    this.commandSnapshots.delete(commandId);
  }

  private clearCommandSnapshot(commandId: string): void {
    this.commandSnapshots.delete(commandId);
  }

  // ========== Rate Limiting ==========

  private checkRateLimit(): boolean {
    const now = Date.now();

    if (this.isRateLimited()) {
      if (now >= this.rateLimitEndTime()) {
        this.isRateLimited.set(false);
        this.requestTimestamps.set([]);
        this.rateLimitEndTime.set(0);
      } else {
        const remaining = Math.ceil((this.rateLimitEndTime() - now) / 1000);
        this.toastService.warning(
          this.t('commands.toast.rateLimitTitle'),
          this.languageService.translate('commands.toast.rateLimitMessage', { seconds: remaining })
        );
        return false;
      }
    }

    const timestamps = this.requestTimestamps().filter((ts) => now - ts < this.RATE_LIMIT_WINDOW);

    if (timestamps.length >= this.RATE_LIMIT_REQUESTS) {
      this.isRateLimited.set(true);
      this.rateLimitEndTime.set(now + this.RATE_LIMIT_BLOCK_DURATION);
      this.toastService.warning(
        this.t('commands.toast.rateLimitTitle'),
        this.languageService.translate('commands.toast.rateLimitMessage', {
          seconds: Math.ceil(this.RATE_LIMIT_BLOCK_DURATION / 1000)
        })
      );
      return false;
    }

    return true;
  }

  private recordRequest(): void {
    this.requestTimestamps.update((timestamps) => [...timestamps, Date.now()]);
  }

  // ========== Helpers ==========

  getUserLevelName(level: number): string {
    return USER_LEVEL_NAMES[level] || 'commands.userLevels.everyone';
  }

  whoCanUse(level: number): string {
    return whoCanUsePhrase(level, (key, params) => this.t(key, params));
  }

  commandAccessLabel(command: Command): string {
    if (command.permissionMode === 'invalid') return this.t('commands.access.advancedRule');
    if (command.permissionExpression != null || command.permissionMode === 'tags') {
      return this.t('commands.access.customAccess');
    }
    return this.whoCanUse(command.userLevel);
  }

  // ========== View helpers ==========

  /** Switch handler; resets the box itself on failure because the binding may never have changed. */
  toggleCommand(command: CommandListItem, input: HTMLInputElement): void {
    const id = this.commandTrackId(command);
    const wasOn = command.enabled !== false;
    const reset = () => { input.checked = wasOn; };
    if (!this.canManage() || this.isPending(id)) {
      reset();
      return;
    }
    if (wasOn) this.disableCommand(id, reset);
    else this.enableCommand(id, reset);
    // Rate limit or a missing channel returns early without a request.
    if (!this.isPending(id)) reset();
  }

  openCreate(kind: 'command' | 'keyword'): void {
    this.newItemKind.set(kind);
    this.openCreateModal();
  }

  builtinTitle(command: Command): string {
    const key = `commands.builtin.name.${command.func}`;
    const title = this.t(key);
    return title === key ? command.name : title;
  }

  builtinDescription(command: Command): string {
    const key = `commands.builtin.desc.${command.func}`;
    const text = this.t(key);
    return text === key ? realDescription(command) ?? this.t('commands.builtin.noDescription') : text;
  }

  /** "!so <username>" — null when the command takes nothing. */
  usageLine(command: Command): string | null {
    if (command.activation === 'keyword') return null;
    const args = command.reserved ? builtinInfo(command).usage : customUsage(command.message);
    return args ? `!${command.cmd} ${formatUsage(args, (key, params) => this.t(key, params))}` : null;
  }

  replyParts(command: Command): ReplyPart[] {
    return replyParts(command.message || '');
  }

  groupLabel(group: BuiltinGroup): string {
    return this.t(`commands.builtin.groups.${group}`);
  }

  groupPreview(items: Command[]): string {
    return items.slice(0, 4).map((command) => `!${command.cmd}`).join(' ') + (items.length > 4 ? ' …' : '');
  }

  timerMinutes(command: Command): number | null {
    return this.isTimerLinked(command) ? this.getTimerMinutesForCommand(command) : null;
  }

  keywordRule(command: Command): string {
    return this.t(`commands.keywordRule.${command.keywordSettings?.matchMode ?? 'start'}`, { word: command.cmd });
  }

  kindLabel(command: Command): string {
    switch (this.commandKind(command)) {
      case 'keyword': return this.t('commands.kinds.keyword');
      case 'reserved': return this.t('commands.kinds.builtin');
      case 'timer': return this.t('commands.kinds.timer');
      default: return this.t('commands.kinds.command');
    }
  }

  copyPublicUrl(): void {
    const url = this.publicUrl();
    if (!url || !navigator.clipboard) return;
    void navigator.clipboard.writeText(url).then(() => {
      this.publicCopied.set(true);
      window.setTimeout(() => this.publicCopied.set(false), 1800);
    });
  }

  private loadTimerNames(channelID: string): void {
    this.timersApi.listTimers(channelID).subscribe({
      next: (rows) => {
        const names = new Set<string>();
        const minutes = new Map<string, number>();
        for (const row of rows) {
          const value = String(row.name || '')
            .trim()
            .toLowerCase()
            .replace(/^!/, '');
          if (!value) {
            continue;
          }
          names.add(value);
          const interval = Number(row.minutes ?? row.frequency) || 0;
          if (interval > 0) {
            minutes.set(value, interval);
          }
        }
        this.timerNames.set(names);
        this.timerMinutesByName.set(minutes);
      },
      error: () => {
        this.timerNames.set(new Set());
        this.timerMinutesByName.set(new Map());
      }
    });
  }

  private getTimerMinutesForCommand(command: Pick<Command, 'cmd' | 'name' | 'activation'>): number | null {
    if (command.activation === 'keyword') return null;
    const map = this.timerMinutesByName();
    const cmd = (command.cmd || '').trim().toLowerCase().replace(/^!/, '');
    const name = (command.name || '').trim().toLowerCase();
    if (cmd && map.has(cmd)) {
      return map.get(cmd) ?? null;
    }
    if (name && map.has(name)) {
      return map.get(name) ?? null;
    }
    return null;
  }

  private resolveTimerName(command: Pick<Command, 'cmd' | 'name' | 'activation'>): string | null {
    if (command.activation === 'keyword') return null;
    const names = this.timerNames();
    const cmd = (command.cmd || '').trim().toLowerCase().replace(/^!/, '');
    const name = (command.name || '').trim().toLowerCase();
    if (cmd && names.has(cmd)) {
      return cmd;
    }
    if (name && names.has(name)) {
      return name;
    }
    return null;
  }

  private normalizeTimerName(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^!/, '');
  }

  private syncCommandTimer(
    channelID: string,
    commandCmd: string,
    previousTimerName: string | null,
    message: string,
    timer: CommandModalSavePayload['timer']
  ): void {
    const timerName = this.normalizeTimerName(commandCmd);
    if (!timerName) {
      return;
    }

    const hadPrevious = Boolean(previousTimerName && this.timerNames().has(previousTimerName));
    const hasCurrent = this.timerNames().has(timerName);
    const timerMessage = String(message || '').slice(0, 350);

    if (!timer.enabled) {
      const toDelete = hadPrevious ? previousTimerName : hasCurrent ? timerName : null;
      if (!toDelete) {
        return;
      }
      this.timersApi.deleteTimer(channelID, toDelete).subscribe((ok) => {
        if (ok) {
          this.loadTimerNames(channelID);
          this.toastService.success(
            this.t('commands.toast.timerRemovedTitle'),
            this.t('commands.toast.timerRemovedMessage')
          );
        }
      });
      return;
    }

    const minutes = Number(timer.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      return;
    }

    const finishOk = (ok: boolean, failMessage?: string): void => {
      if (ok) {
        this.loadTimerNames(channelID);
        this.toastService.success(
          this.t('commands.toast.timerSavedTitle'),
          this.t('commands.toast.timerSavedMessage')
        );
        return;
      }
      this.toastService.error(
        this.t('commands.toast.timerErrorTitle'),
        failMessage || this.t('commands.toast.timerErrorMessage')
      );
    };

    if (hadPrevious && previousTimerName && previousTimerName !== timerName) {
      this.timersApi.deleteTimer(channelID, previousTimerName).subscribe(() => {
        this.timersApi.createTimer(channelID, timerName, minutes, timerMessage).subscribe((result) => {
          finishOk(result.ok, result.message);
        });
      });
      return;
    }

    if (hasCurrent || hadPrevious) {
      this.timersApi
        .updateTimer(channelID, timerName, { frequency: minutes, message: timerMessage })
        .subscribe((result) => finishOk(result.ok, result.message));
      return;
    }

    this.timersApi
      .createTimer(channelID, timerName, minutes, timerMessage)
      .subscribe((result) => finishOk(result.ok, result.message));
  }

  // ========== Event Handlers ==========

  onDocumentEscape(): void {
    if (this.showCommandModal()) {
      this.closeModal();
    } else if (this.showDeleteModal()) {
      this.closeDeleteModal();
    }
  }
}
