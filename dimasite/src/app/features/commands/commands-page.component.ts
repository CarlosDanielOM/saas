import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { List, LayoutGrid } from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';
import { combineLatest, map, of, switchMap } from 'rxjs';

import { Command, CreateCommandRequest, UpdateCommandRequest, USER_LEVELS, USER_LEVEL_NAMES } from '../../models/command.model';
import { CommandsApiService } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';

type ViewMode = 'table' | 'card';
type EditMode = { type: 'cell'; commandId: string; field: string } | { type: 'row'; commandId: string } | { type: 'card'; commandId: string } | null;
type PendingOperation = 'create' | 'update' | 'enable' | 'disable' | 'delete';
type CommandFeedbackState = 'success' | 'error';
type CommandLoadSource = 'initial' | 'retry' | 'manual' | 'empty-retry' | 'language';

interface CommandListItem extends Command {
  pendingOperation?: PendingOperation;
  optimistic?: boolean;
}

@Component({
  selector: 'app-commands-page',
  imports: [ReactiveFormsModule, LucideAngularModule, ConfirmationModalComponent],
  templateUrl: './commands-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onDocumentEscape()'
  }
})
export class CommandsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly commandsApi = inject(CommandsApiService);
  private readonly toastService = inject(ToastService);

  // Icons
  readonly listIcon = List;
  readonly gridIcon = LayoutGrid;

  // Route params - resolved to channelID
  readonly channelID = signal<string | null>(null);
  private readonly routeStreamer$ = combineLatest([
    this.route.paramMap,
    this.route.parent?.paramMap ?? of(convertToParamMap({}))
  ]).pipe(
    map(([currentParams, parentParams]) => currentParams.get('streamer') ?? parentParams.get('streamer') ?? '')
  );
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
  readonly loading = computed(() => this.commandsApi.listLoading());
  readonly error = computed(() => this.commandsApi.listError());
  readonly showInitialLoading = computed(() => this.loading() && this.commands().length === 0);
  readonly showLoadError = computed(() => !!this.error() && this.commands().length === 0);
  readonly refreshAvailableAt = signal(0);
  readonly refreshTick = signal(Date.now());
  readonly refreshCooldownSeconds = computed(() => {
    const remainingMs = this.refreshAvailableAt() - this.refreshTick();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  });
  readonly canHardRefresh = computed(() => this.refreshCooldownSeconds() === 0 && !this.loading());
  readonly refreshButtonLabel = computed(() => {
    this.languageService.currentLanguage();

    if (this.loading()) {
      return this.t('commands.refreshing');
    }

    const seconds = this.refreshCooldownSeconds();
    if (seconds > 0) {
      return this.languageService.translate('commands.refreshCooldown', { seconds });
    }

    return this.t('commands.refresh');
  });

  // View state
  readonly viewMode = signal<ViewMode>('table');
  readonly currentPage = signal(1);
  readonly itemsPerPage = signal(10);
  readonly itemsPerPageOptions = [5, 10, 15, 20];
  readonly addingCommand = signal(false);

  // Editing state
  readonly editMode = signal<EditMode>(null);
  readonly editingValues = signal<Record<string, unknown>>({});

  // Confirmation modal
  readonly showDeleteModal = signal(false);
  readonly commandToDelete = signal<Command | null>(null);

  // Rate limiting
  private readonly requestTimestamps = signal<number[]>([]);
  private readonly RATE_LIMIT_REQUESTS = 15;
  private readonly RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds
  private readonly RATE_LIMIT_BLOCK_DURATION = 60 * 1000;
  private readonly isRateLimited = signal(false);
  private readonly rateLimitEndTime = signal(0);
  private readonly autoRefreshAttempted = new Set<string>();
  private readonly commandSnapshots = new Map<string, CommandListItem>();
  private readonly commandFeedback = signal<Record<string, CommandFeedbackState>>({});
  private readonly commandFeedbackTimers = new Map<string, number>();
  private refreshCooldownTimer: number | null = null;

  // Form
  readonly newCommandForm: FormGroup = this.fb.group({
    name: ['', [Validators.required]],
    cmd: ['', [Validators.required]],
    message: ['', [Validators.required]],
    description: [''],
    cooldown: [10, [Validators.required, Validators.min(5), Validators.max(60)]],
    userLevel: [1, [Validators.required, Validators.min(1), Validators.max(10)]],
    enabled: [true]
  });

  readonly totalPages = computed(() => Math.ceil(this.commands().length / this.itemsPerPage()));

  readonly paginatedCommands = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    const end = start + this.itemsPerPage();
    return this.commands().slice(start, end);
  });

  readonly pages = computed(() => {
    const total = this.totalPages();
    const current = this.currentPage();

    // If 5 or fewer pages, show all
    if (total <= 5) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    // For more than 5 pages, show sliding window of 5 pages
    let start = current - 2;
    let end = current + 2;

    // Adjust window to stay within bounds
    if (start < 1) {
      start = 1;
      end = 5;
    } else if (end > total) {
      end = total;
      start = total - 4;
    }

    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
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

    if (channelID) {
      this.loadCommands(channelID, { source: 'initial', silent: true });
    }
  });

  private readonly persistViewModeEffect = effect(() => {
    const mode = this.viewMode();
    this.saveToSession('viewMode', mode);
    this.updateURL(mode, this.currentPage());
  });

  private readonly persistPageEffect = effect(() => {
    const page = this.currentPage();
    if (this.viewMode() === 'table') {
      this.saveToSession('currentPage', page);
      this.updateURL(this.viewMode(), page);
    }
  });

  constructor() {
    this.initializeFromURL();

    effect(() => {
      const mode = this.editMode();
      if (!mode) {
        return;
      }

      const editorKey = mode.type === 'cell' ? `${mode.commandId}_${mode.field}` : `${mode.commandId}_name`;
      queueMicrotask(() => this.focusEditor(editorKey));
    });
  }

  ngOnDestroy(): void {
    this.clearRefreshCooldownTimer();
    this.clearAllCommandFeedbackTimers();
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  private getCommandId(command: Pick<Command, 'id' | '_id'>): string {
    return command.id || command._id || '';
  }

  commandTrackId(command: Pick<Command, 'id' | '_id'>): string {
    return this.getCommandId(command);
  }

  private normalizeCommand(command: Command): CommandListItem {
    return { ...command };
  }

  private normalizeCommands(commands: Command[]): CommandListItem[] {
    return commands.map((command) => this.normalizeCommand(command));
  }

  private matchesCommand(command: Pick<Command, 'id' | '_id'>, commandId: string): boolean {
    return this.getCommandId(command) === commandId;
  }

  isPending(commandId: string): boolean {
    return this.commands().some((command) => this.matchesCommand(command, commandId) && !!command.pendingOperation);
  }

  getPendingOperation(commandId: string): PendingOperation | null {
    return this.commands().find((command) => this.matchesCommand(command, commandId))?.pendingOperation ?? null;
  }

  getPendingLabel(commandId: string): string {
    switch (this.getPendingOperation(commandId)) {
      case 'create':
        return this.t('commands.pending.creating');
      case 'delete':
        return this.t('commands.pending.deleting');
      case 'enable':
        return this.t('commands.pending.enabling');
      case 'disable':
        return this.t('commands.pending.disabling');
      case 'update':
        return this.t('commands.pending.saving');
      default:
        return '';
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

    this.commandFeedback.update((feedback) => ({
      ...feedback,
      [commandId]: state
    }));

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

  private restoreCommandSnapshot(commandId: string): void {
    const snapshot = this.commandSnapshots.get(commandId);
    if (!snapshot) {
      return;
    }

    this.updateCommandItem(commandId, () => snapshot);
    this.commandSnapshots.delete(commandId);
  }

  private clearCommandSnapshot(commandId: string): void {
    this.commandSnapshots.delete(commandId);
  }

  private buildOptimisticCommand(tempId: string, channelID: string, command: CreateCommandRequest): CommandListItem {
    return {
      id: tempId,
      _id: tempId,
      channel: command.channel,
      channelID,
      cmd: command.cmd,
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
      pendingOperation: 'create',
      optimistic: true
    };
  }

  isPendingDelete(commandId: string): boolean {
    return this.getPendingOperation(commandId) === 'delete';
  }

  private focusEditor(editorKey: string): void {
    if (typeof document === 'undefined') {
      return;
    }

    const element = document.querySelector<HTMLElement>(`[data-command-editor="${editorKey}"]`);
    if (!element) {
      return;
    }

    element.focus();

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select();
    }
  }

  private initializeFromURL() {
    const queryParams = this.route.snapshot.queryParams;
    const view = queryParams['view'] as ViewMode | undefined;
    const page = parseInt(queryParams['page'], 10);

    if (view === 'table' || view === 'card') {
      this.viewMode.set(view);
    } else {
      const sessionMode = this.getFromSession('viewMode') as ViewMode | null;
      if (sessionMode) {
        this.viewMode.set(sessionMode);
      }
    }

    if (!isNaN(page) && page > 0) {
      this.currentPage.set(page);
    } else {
      const sessionPage = this.getFromSession('currentPage') as number | null;
      if (sessionPage) {
        this.currentPage.set(sessionPage);
      }
    }

    const sessionItemsPerPage = this.getFromSession('itemsPerPage') as number | null;
    if (sessionItemsPerPage && this.itemsPerPageOptions.includes(sessionItemsPerPage)) {
      this.itemsPerPage.set(sessionItemsPerPage);
    }
  }

  loadCommands(channelID: string, options: { hardRefresh?: boolean; silent?: boolean; source?: CommandLoadSource } = {}) {
    const request$ = options.hardRefresh
      ? this.commandsApi.refreshCommands(channelID)
      : this.commandsApi.getCommands(channelID);
    const autoRefreshKey = `${channelID}:${this.languageService.getCurrentLanguage()}`;

    request$.subscribe((commands) => {
      const errorMessage = this.commandsApi.listError();
      if (errorMessage) {
        if (this.commands().length === 0) {
          this.commands.set([]);
        }

        if (!options.silent) {
          this.toastService.error(this.t('commands.toast.loadErrorTitle'), errorMessage);
        }
        return;
      }

      if (commands.length === 0 && !options.hardRefresh && !this.autoRefreshAttempted.has(autoRefreshKey)) {
        this.autoRefreshAttempted.add(autoRefreshKey);
        this.loadCommands(channelID, {
          hardRefresh: true,
          silent: true,
          source: 'empty-retry'
        });
        return;
      }

      this.commands.set(this.normalizeCommands(commands));
      this.syncCurrentPage();

      if (options.source === 'manual') {
        if (commands.length > 0) {
          this.toastService.success(
            this.t('commands.toast.refreshSuccessTitle'),
            this.languageService.translate('commands.toast.refreshSuccessMessage', { count: commands.length })
          );
        } else {
          this.toastService.info(
            this.t('commands.toast.emptyTitle'),
            this.t('commands.toast.emptyMessage')
          );
        }
      }

      if (options.source === 'empty-retry' && commands.length > 0) {
        this.toastService.success(
          this.t('commands.toast.recoveredTitle'),
          this.languageService.translate('commands.toast.refreshSuccessMessage', { count: commands.length })
        );
      }
    });
  }

  hardRefreshCommands() {
    const channelID = this.channelID();
    if (!channelID) {
      this.toastService.error(this.t('commands.toast.loadErrorTitle'), this.t('commands.toast.missingChannel'));
      return;
    }

    const cooldownSeconds = this.refreshCooldownSeconds();
    if (cooldownSeconds > 0) {
      this.toastService.warning(
        this.t('commands.toast.refreshCooldownTitle'),
        this.languageService.translate('commands.toast.refreshCooldownMessage', { seconds: cooldownSeconds })
      );
      return;
    }

    this.startRefreshCooldown();
    this.loadCommands(channelID, { hardRefresh: true, source: 'manual' });
  }

  private startRefreshCooldown(): void {
    const refreshAvailableAt = Date.now() + 10_000;
    this.refreshAvailableAt.set(refreshAvailableAt);
    this.refreshTick.set(Date.now());
    this.clearRefreshCooldownTimer();

    this.refreshCooldownTimer = window.setInterval(() => {
      const now = Date.now();
      this.refreshTick.set(now);

      if (now >= refreshAvailableAt) {
        this.clearRefreshCooldownTimer();
      }
    }, 1000);
  }

  private clearRefreshCooldownTimer(): void {
    if (this.refreshCooldownTimer !== null) {
      window.clearInterval(this.refreshCooldownTimer);
      this.refreshCooldownTimer = null;
    }
  }

  private syncCurrentPage(): void {
    const totalPages = this.totalPages();
    if (totalPages === 0) {
      this.currentPage.set(1);
      return;
    }

    if (this.currentPage() > totalPages) {
      this.currentPage.set(totalPages);
    }
  }

  private saveToSession(key: string, value: unknown) {
    try {
      const data = JSON.parse(sessionStorage.getItem('commandsState') || '{}');
      data[key] = value;
      sessionStorage.setItem('commandsState', JSON.stringify(data));
    } catch {
      // Ignore storage errors
    }
  }

  private getFromSession(key: string): unknown {
    try {
      const data = JSON.parse(sessionStorage.getItem('commandsState') || '{}');
      return data[key];
    } catch {
      return null;
    }
  }

  private updateURL(view: ViewMode, page?: number) {
    const queryParams: Record<string, string | number | undefined> = { view };
    if (view === 'table' && page && page > 1) {
      queryParams['page'] = page;
    }

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      replaceUrl: true
    });
  }

  // Rate limiting
  checkRateLimit(): boolean {
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

  private recordRequest() {
    this.requestTimestamps.update((timestamps) => [...timestamps, Date.now()]);
  }

  // View mode
  setViewMode(mode: ViewMode) {
    this.viewMode.set(mode);
    if (mode === 'card') {
      this.currentPage.set(1);
    }
  }

  // Pagination
  changePage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }

  onItemsPerPageChange(event: Event) {
    const value = parseInt((event.target as HTMLSelectElement).value, 10);
    if (this.itemsPerPageOptions.includes(value)) {
      this.itemsPerPage.set(value);
      this.currentPage.set(1);
      this.saveToSession('itemsPerPage', value);
    }
  }

  // Editing
  isEditingCell(commandId: string, field: string): boolean {
    const mode = this.editMode();
    return mode?.type === 'cell' && mode.commandId === commandId && mode.field === field;
  }

  isEditingRow(commandId: string): boolean {
    const mode = this.editMode();
    return mode?.type === 'row' && mode.commandId === commandId;
  }

  isEditingCard(commandId: string): boolean {
    const mode = this.editMode();
    return mode?.type === 'card' && mode.commandId === commandId;
  }

  startCellEdit(commandId: string, field: string, value: unknown) {
    if (!this.checkRateLimit()) return;
    if (this.isPending(commandId)) return;

    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (command && !this.canEditField(commandId, field)) {
      return;
    }

    this.editMode.set({ type: 'cell', commandId, field });
    this.editingValues.update((values) => ({
      ...values,
      [`${commandId}_${field}`]: value
    }));
  }

  startRowEdit(commandId: string) {
    if (!this.checkRateLimit()) return;
    if (this.isPending(commandId)) return;

    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (!command) return;

    this.editMode.set({ type: 'row', commandId });
    this.editingValues.update((values) => ({
      ...values,
      [`${commandId}_name`]: command.name,
      [`${commandId}_cmd`]: command.cmd,
      [`${commandId}_message`]: command.message,
      [`${commandId}_description`]: command.description,
      [`${commandId}_cooldown`]: command.cooldown,
      [`${commandId}_userLevel`]: command.userLevel
    }));
  }

  startCardEdit(commandId: string) {
    if (!this.checkRateLimit()) return;
    if (this.isPending(commandId)) return;

    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (!command) return;

    this.editMode.set({ type: 'card', commandId });
    this.editingValues.update((values) => ({
      ...values,
      [`${commandId}_name`]: command.name,
      [`${commandId}_cmd`]: command.cmd,
      [`${commandId}_message`]: command.message,
      [`${commandId}_description`]: command.description,
      [`${commandId}_cooldown`]: command.cooldown,
      [`${commandId}_userLevel`]: command.userLevel
    }));
  }

  getEditingValue(commandId: string, field: string): unknown {
    return this.editingValues()[`${commandId}_${field}`];
  }

  updateEditingValue(commandId: string, field: string, value: unknown) {
    this.editingValues.update((values) => ({
      ...values,
      [`${commandId}_${field}`]: value
    }));
  }

  cancelEdit() {
    this.editMode.set(null);
    this.editingValues.set({});
  }

  saveCellEdit() {
    const mode = this.editMode();
    if (mode?.type !== 'cell') return;

    const { commandId, field } = mode;
    const newValue = this.editingValues()[`${commandId}_${field}`];
    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);

    if (!command || newValue === undefined) {
      this.cancelEdit();
      return;
    }

    if (!this.checkRateLimit()) {
      this.cancelEdit();
      return;
    }

    // Check if value changed
    const oldValue = command[field as keyof Command];
    if (oldValue === newValue) {
      this.cancelEdit();
      return;
    }

    this.recordRequest();

    const channelID = this.channelID();
    if (!channelID) return;

    const updates = { [field]: newValue } as UpdateCommandRequest;
    if (field === 'userLevel') {
      updates['userLevelName'] = USER_LEVELS[newValue as number];
    }

    this.commandSnapshots.set(commandId, { ...command });
    this.updateCommandItem(commandId, (currentCommand) => ({
      ...currentCommand,
      ...updates,
      pendingOperation: 'update'
    }));
    this.cancelEdit();

    this.commandsApi.updateCommand(channelID, commandId, updates).subscribe((updated) => {
      if (updated) {
        this.replaceCommandItem(commandId, updated);
        this.clearCommandSnapshot(commandId);
        this.setCommandFeedbackState(this.getCommandId(updated), 'success');
        this.toastService.success(this.t('commands.toast.savedTitle'), this.t('commands.toast.savedMessage'));
        return;
      }

      this.restoreCommandSnapshot(commandId);
      this.setCommandFeedbackState(commandId, 'error');
      this.toastService.error(
        this.t('commands.toast.saveErrorTitle'),
        this.t('commands.toast.saveErrorMessage')
      );
    });
  }

  saveRowEdit() {
    const mode = this.editMode();
    if (mode?.type !== 'row') return;

    const { commandId } = mode;
    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (!command) return;

    const values = this.editingValues();
    const name = values[`${commandId}_name`] as string;
    const cmd = values[`${commandId}_cmd`] as string;
    const message = values[`${commandId}_message`] as string;
    const cooldown = values[`${commandId}_cooldown`] as number;
    const userLevel = values[`${commandId}_userLevel`] as number;

    // Validate
    const isReserved = command.reserved;
    const messageValid = isReserved || (message && message.trim() !== '');

    if (!name || !cmd || !messageValid || cooldown === undefined || userLevel === undefined) {
      return;
    }

    if (!this.checkRateLimit()) {
      this.cancelEdit();
      return;
    }

    this.recordRequest();

    const channelID = this.channelID();
    if (!channelID) return;

    const updates: UpdateCommandRequest = {
      name,
      cmd,
      message: isReserved ? command.message : message,
      description: (values[`${commandId}_description`] as string) || null,
      cooldown,
      userLevel,
      userLevelName: USER_LEVELS[userLevel]
    };

    this.commandSnapshots.set(commandId, { ...command });
    this.updateCommandItem(commandId, (currentCommand) => ({
      ...currentCommand,
      ...updates,
      pendingOperation: 'update'
    }));
    this.cancelEdit();

    this.commandsApi.updateCommand(channelID, commandId, updates).subscribe((updated) => {
      if (updated) {
        this.replaceCommandItem(commandId, updated);
        this.clearCommandSnapshot(commandId);
        this.setCommandFeedbackState(this.getCommandId(updated), 'success');
        this.toastService.success(this.t('commands.toast.savedTitle'), this.t('commands.toast.savedMessage'));
        return;
      }

      this.restoreCommandSnapshot(commandId);
      this.setCommandFeedbackState(commandId, 'error');
      this.toastService.error(
        this.t('commands.toast.saveErrorTitle'),
        this.t('commands.toast.saveErrorMessage')
      );
    });
  }

  saveCardEdit() {
    const mode = this.editMode();
    if (mode?.type !== 'card') return;

    const { commandId } = mode;
    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (!command) return;

    const values = this.editingValues();
    const name = values[`${commandId}_name`] as string;
    const cmd = values[`${commandId}_cmd`] as string;
    const message = values[`${commandId}_message`] as string;
    const cooldown = values[`${commandId}_cooldown`] as number;
    const userLevel = values[`${commandId}_userLevel`] as number;

    // Validate
    const isReserved = command.reserved;
    const messageValid = isReserved || (message && message.trim() !== '');

    if (!name || !cmd || !messageValid || cooldown === undefined || userLevel === undefined) {
      return;
    }

    if (!this.checkRateLimit()) {
      this.cancelEdit();
      return;
    }

    this.recordRequest();

    const channelID = this.channelID();
    if (!channelID) return;

    const updates: UpdateCommandRequest = {
      name,
      cmd,
      message: isReserved ? command.message : message,
      description: (values[`${commandId}_description`] as string) || null,
      cooldown,
      userLevel,
      userLevelName: USER_LEVELS[userLevel]
    };

    this.commandSnapshots.set(commandId, { ...command });
    this.updateCommandItem(commandId, (currentCommand) => ({
      ...currentCommand,
      ...updates,
      pendingOperation: 'update'
    }));
    this.cancelEdit();

    this.commandsApi.updateCommand(channelID, commandId, updates).subscribe((updated) => {
      if (updated) {
        this.replaceCommandItem(commandId, updated);
        this.clearCommandSnapshot(commandId);
        this.setCommandFeedbackState(this.getCommandId(updated), 'success');
        this.toastService.success(this.t('commands.toast.savedTitle'), this.t('commands.toast.savedMessage'));
        return;
      }

      this.restoreCommandSnapshot(commandId);
      this.setCommandFeedbackState(commandId, 'error');
      this.toastService.error(
        this.t('commands.toast.saveErrorTitle'),
        this.t('commands.toast.saveErrorMessage')
      );
    });
  }

  // Command actions
  canEditField(commandId: string, field: string): boolean {
    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (command?.reserved && (field === 'message' || field === 'description')) {
      return false;
    }
    return true;
  }

  enableCommand(commandId: string) {
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
        this.setCommandFeedbackState(commandId, 'error');
        this.toastService.error(
          this.t('commands.toast.saveErrorTitle'),
          this.t('commands.toast.saveErrorMessage')
        );
      }
    });
  }

  disableCommand(commandId: string) {
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
        this.setCommandFeedbackState(commandId, 'error');
        this.toastService.error(
          this.t('commands.toast.saveErrorTitle'),
          this.t('commands.toast.saveErrorMessage')
        );
      }
    });
  }

  promptDeleteCommand(command: Command) {
    const commandId = this.getCommandId(command);
    if (command.reserved || !commandId || this.isPending(commandId)) return;
    this.commandToDelete.set(command);
    this.showDeleteModal.set(true);
  }

  confirmDelete() {
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

    this.commandsApi.deleteCommand(channelID, commandId).subscribe((success) => {
      if (success) {
        this.commands.update((cmds) =>
          cmds.filter((c) => !this.matchesCommand(c, commandId))
        );
        this.clearCommandSnapshot(commandId);
        this.syncCurrentPage();
        this.toastService.success(this.t('commands.toast.deletedTitle'), this.t('commands.toast.deletedMessage'));
      } else {
        this.restoreCommandSnapshot(commandId);
        this.setCommandFeedbackState(commandId, 'error');
        this.toastService.error(
          this.t('commands.toast.deleteErrorTitle'),
          this.t('commands.toast.deleteErrorMessage')
        );
      }
    });
  }

  closeDeleteModal() {
    this.showDeleteModal.set(false);
    this.commandToDelete.set(null);
  }

  // Add new command
  startAddingCommand() {
    if (!this.checkRateLimit()) return;
    this.addingCommand.set(true);
    this.newCommandForm.reset({
      name: '',
      cmd: '',
      message: '',
      description: '',
      cooldown: 10,
      userLevel: 1,
      enabled: true
    });
  }

  cancelAddingCommand() {
    this.addingCommand.set(false);
    this.newCommandForm.reset();
  }

  saveNewCommand() {
    if (this.newCommandForm.invalid) return;

    if (!this.checkRateLimit()) return;

    const channelID = this.channelID();
    if (!channelID) return;

    const session = this.sessionAuth.session();
    if (!session) return;

    const formValue = this.newCommandForm.value;
    const newCommand: CreateCommandRequest = {
      name: formValue.name,
      cmd: formValue.cmd,
      func: formValue.cmd,
      message: formValue.message,
      description: formValue.description || null,
      cooldown: formValue.cooldown,
      userLevel: formValue.userLevel,
      userLevelName: USER_LEVELS[formValue.userLevel],
      enabled: formValue.enabled,
      channel: session.twitchUser.login || channelID
    };

    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticCommand = this.buildOptimisticCommand(tempId, channelID, newCommand);

    const optimisticTotalPages = Math.ceil((this.commands().length + 1) / this.itemsPerPage());

    this.recordRequest();
    this.commands.update((cmds) => [...cmds, optimisticCommand]);
    this.addingCommand.set(false);

    if (this.viewMode() === 'table' && optimisticTotalPages > this.currentPage()) {
      this.currentPage.set(optimisticTotalPages);
    }

    this.commandsApi.createCommand(channelID, newCommand).subscribe((created) => {
      if (created) {
        this.replaceCommandItem(tempId, created);
        this.setCommandFeedbackState(this.getCommandId(created), 'success');
        this.newCommandForm.reset();
        this.toastService.success(this.t('commands.toast.createdTitle'), this.t('commands.toast.createdMessage'));
      } else {
        this.setCommandFeedbackState(tempId, 'error');

        window.setTimeout(() => {
          this.commands.update((cmds) => cmds.filter((command) => !this.matchesCommand(command, tempId)));
          this.syncCurrentPage();
          this.addingCommand.set(true);
        }, 650);

        this.toastService.error(
          this.t('commands.toast.createErrorTitle'),
          this.t('commands.toast.createErrorMessage')
        );
      }
    });
  }

  // Helpers
  getUserLevelName(level: number): string {
    return USER_LEVEL_NAMES[level] || 'commands.userLevels.everyone';
  }

  onDocumentClick(event: Event) {
    const mode = this.editMode();
    if (mode?.type !== 'cell') {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (
      target.closest('.commands-table__cell--editable') ||
      target.closest('.commands-card__title') ||
      target.closest('.commands-card__value') ||
      target.closest('.commands-input') ||
      target.closest('.commands-select') ||
      target.closest('.commands-input-prefix') ||
      target.closest('.commands-input-suffix')
    ) {
      return;
    }

    this.saveCellEdit();
  }

  onDocumentEscape() {
    if (this.editMode()) {
      this.cancelEdit();
    }

    if (this.addingCommand()) {
      this.cancelAddingCommand();
    }
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      const mode = this.editMode();
      if (mode?.type === 'cell') {
        this.saveCellEdit();
      } else if (mode?.type === 'row') {
        this.saveRowEdit();
      } else if (mode?.type === 'card') {
        this.saveCardEdit();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }
}
