import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { List, LayoutGrid, Edit3, Trash2, Power, PowerOff } from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';
import { combineLatest, map, of, switchMap } from 'rxjs';

import { HttpClient } from '@angular/common/http';
import { Command, CreateCommandRequest, UpdateCommandRequest, USER_LEVELS, USER_LEVEL_NAMES } from '../../models/command.model';
import { CommandsApiService } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { CommandModalComponent } from './command-modal.component';

type ViewMode = 'table' | 'card';
type EditMode = { type: 'cell'; commandId: string; field: string } | null;
type PendingOperation = 'create' | 'update' | 'enable' | 'disable' | 'delete';
type CommandFeedbackState = 'success' | 'error';

interface CommandListItem extends Command {
  pendingOperation?: PendingOperation;
  optimistic?: boolean;
}

@Component({
  selector: 'app-commands-page',
  imports: [ReactiveFormsModule, LucideAngularModule, ConfirmationModalComponent, CommandModalComponent],
  templateUrl: './commands-page.component.html',
  styleUrl: './commands-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onDocumentEscape()'
  }
})
export class CommandsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly linksService = inject(LinksService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly commandsApi = inject(CommandsApiService);
  private readonly toastService = inject(ToastService);

  // Icons
  readonly listIcon = List;
  readonly gridIcon = LayoutGrid;
  readonly editIcon = Edit3;
  readonly trashIcon = Trash2;
  readonly powerIcon = Power;
  readonly powerOffIcon = PowerOff;

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

  // Search state
  readonly searchInput = signal('');
  readonly activeSearchQuery = signal('');
  readonly searchResults = signal<CommandListItem[]>([]);
  readonly searchMode = signal<'cache' | 'api'>('cache');
  readonly isSearching = signal(false);
  readonly searchHint = signal<string | null>(null);

  // Sort state
  readonly sortBy = signal('name');
  readonly sortOrder = signal<'asc' | 'desc'>('asc');

  // View state
  readonly viewMode = signal<ViewMode>('table');
  readonly currentPage = signal(1);
  readonly itemsPerPage = signal(10);
  readonly itemsPerPageOptions = [5, 10, 15, 20] as const;
  /** Timer names from GET /timers/:channelID — used only for list styling/legend. */
  readonly timerNames = signal<Set<string>>(new Set());

  // Edit state (cell edit only - modal handles full edit)
  readonly editMode = signal<EditMode>(null);
  readonly editingValues = signal<Record<string, unknown>>({});

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
  readonly planTier = computed(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
  readonly streamerLabel = computed(() => {
    const fromRoute =
      this.route.snapshot.paramMap.get('streamer') ||
      this.route.parent?.snapshot.paramMap.get('streamer') ||
      '';
    return fromRoute || this.sessionAuth.session()?.twitchUser.login || '—';
  });
  readonly totalCommands = computed(() => this.commands().length);
  readonly enabledCommands = computed(
    () => this.commands().filter((command) => command.enabled !== false).length
  );
  readonly disabledCommands = computed(
    () => this.commands().filter((command) => command.enabled === false).length
  );
  readonly reservedCommands = computed(
    () => this.commands().filter((command) => Boolean(command.reserved)).length
  );
  readonly timerLinkedCommands = computed(
    () => this.commands().filter((command) => this.isTimerLinked(command)).length
  );

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredCommands().length / this.itemsPerPage()) || 1)
  );

  readonly filteredCommands = computed(() => {
    const input = this.searchInput();
    const commands = input ? this.searchResults() : this.commands();
    return this.sortCommands(commands);
  });

  readonly paginatedCommands = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    const end = start + this.itemsPerPage();
    return this.filteredCommands().slice(start, end);
  });

  readonly pages = computed(() => {
    const total = this.totalPages();
    const current = this.currentPage();

    if (total <= 5) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    let start = current - 2;
    let end = current + 2;

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
      this.loadCommands(channelID);
      this.loadTimerNames(channelID);
    } else {
      this.timerNames.set(new Set());
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
  }

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
    this.commandsApi.getCommands(channelID, { skipCache: options.skipCache }).subscribe({
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
    const totalPages = this.totalPages();
    if (totalPages === 0) {
      this.currentPage.set(1);
      return;
    }

    if (this.currentPage() > totalPages) {
      this.currentPage.set(totalPages);
    }
  }

  // ========== Search ==========

  onSearchInput(value: string): void {
    this.searchInput.set(value);

    if (value.trim()) {
      this.filterFromCache(value);
    } else {
      this.searchResults.set([]);
      this.searchMode.set('cache');
      this.searchHint.set(null);
    }
  }

  onSearchSubmit(): void {
    const query = this.searchInput().trim();
    if (!query) return;

    this.activeSearchQuery.set(query);

    const found = this.commands().find((cmd) =>
      cmd.name.toLowerCase().includes(query.toLowerCase()) ||
      cmd.cmd.toLowerCase().includes(query.toLowerCase())
    );

    if (found) {
      this.searchResults.set([found]);
      this.searchMode.set('cache');
      this.searchHint.set(null);
    } else {
      // Not in cache - could make API call but commands API doesn't support search
      this.searchResults.set([]);
      this.searchMode.set('api');
      this.searchHint.set(this.t('commands.search.notFoundHint'));
    }
  }

  onClearSearch(): void {
    this.searchInput.set('');
    this.activeSearchQuery.set('');
    this.searchResults.set([]);
    this.searchMode.set('cache');
    this.searchHint.set(null);
  }

  private filterFromCache(query: string): void {
    const lowerQuery = query.toLowerCase();

    const filtered = this.commands().filter((cmd) =>
      cmd.name.toLowerCase().includes(lowerQuery) ||
      cmd.cmd.toLowerCase().includes(lowerQuery)
    );

    this.searchResults.set(filtered);
    this.searchMode.set('cache');
    this.searchHint.set(filtered.length === 0 ? this.t('commands.search.noResultsInCache') : null);
  }

  // ========== Sort ==========

  onSort(column: string): void {
    if (this.sortBy() === column) {
      this.sortOrder.update((order) => order === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortBy.set(column);
      this.sortOrder.set('asc');
    }
    this.currentPage.set(1);
  }

  getSortIcon(column: string): string {
    if (this.sortBy() !== column) return '↕';
    return this.sortOrder() === 'asc' ? '↑' : '↓';
  }

  private sortCommands(commands: CommandListItem[]): CommandListItem[] {
    const column = this.sortBy();
    const order = this.sortOrder();

    return [...commands].sort((a, b) => {
      let aVal: string | number = 0;
      let bVal: string | number = 0;

      switch (column) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'cmd':
          aVal = a.cmd.toLowerCase();
          bVal = b.cmd.toLowerCase();
          break;
        case 'cooldown':
          aVal = a.cooldown;
          bVal = b.cooldown;
          break;
        case 'userLevel':
          aVal = a.userLevel;
          bVal = b.userLevel;
          break;
        case 'enabled':
          aVal = a.enabled ? 1 : 0;
          bVal = b.enabled ? 1 : 0;
          break;
        case 'createdAt':
          aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          break;
        default:
          return 0;
      }

      if (aVal === bVal) return 0;

      const comparison = aVal < bVal ? -1 : 1;
      return order === 'asc' ? comparison : -comparison;
    });
  }

  // ========== Pagination ==========

  changePage(page: number): void {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }

  onItemsPerPageChange(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (this.itemsPerPageOptions.includes(value as 5 | 10 | 15 | 20)) {
      this.itemsPerPage.set(value);
      this.currentPage.set(1);
      this.saveToSession('itemsPerPage', value);
    }
  }

  isTimerLinked(command: Pick<Command, 'cmd' | 'name' | 'reserved'>): boolean {
    if (command.reserved) {
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

  commandKind(command: Pick<Command, 'cmd' | 'name' | 'reserved'>): 'reserved' | 'timer' | 'normal' {
    if (command.reserved) {
      return 'reserved';
    }
    if (this.isTimerLinked(command)) {
      return 'timer';
    }
    return 'normal';
  }

  // ========== View Mode ==========

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
    this.currentPage.set(1);
  }

  // ========== Modal Handlers ==========

  openCreateModal(): void {
    if (!this.checkRateLimit()) return;
    this.editingCommand.set(null);
    this.showCommandModal.set(true);
  }

  openEditModal(command: Command): void {
    if (!this.checkRateLimit()) return;
    this.editingCommand.set(command);
    this.showCommandModal.set(true);
  }

  closeModal(): void {
    this.showCommandModal.set(false);
    this.editingCommand.set(null);
  }

  onModalSave(request: CreateCommandRequest): void {
    const channelID = this.channelID();
    if (!channelID) return;

    const session = this.sessionAuth.session();
    if (!session) return;

    const editingCmd = this.editingCommand();

    if (editingCmd) {
      // Update existing command
      const commandId = this.getCommandId(editingCmd);
      const updates: UpdateCommandRequest = {
        name: request.name,
        cmd: request.cmd,
        message: request.message,
        description: request.description || null,
        cooldown: request.cooldown,
        userLevel: request.userLevel,
        userLevelName: USER_LEVELS[request.userLevel],
        enabled: request.enabled
      };

      this.recordRequest();
      this.commandSnapshots.set(commandId, { ...editingCmd });
      this.updateCommandItem(commandId, (cmd) => ({ ...cmd, ...updates, pendingOperation: 'update' }));
      this.closeModal();

      this.commandsApi.updateCommand(channelID, commandId, updates).subscribe((updated) => {
        if (updated) {
          this.replaceCommandItem(commandId, updated);
          this.clearCommandSnapshot(commandId);
          this.setCommandFeedbackState(this.getCommandId(updated), 'success');
          this.toastService.success(this.t('commands.toast.savedTitle'), this.t('commands.toast.savedMessage'));
        } else {
          this.restoreCommandSnapshot(commandId);
          this.setCommandFeedbackState(commandId, 'error');
          this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
        }
      });
    } else {
      // Create new command
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

  // ========== Cell Edit (Quick Edit) ==========

  isEditingCell(commandId: string, field: string): boolean {
    const mode = this.editMode();
    return mode?.type === 'cell' && mode.commandId === commandId && mode.field === field;
  }

  startCellEdit(commandId: string, field: string, value: unknown): void {
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

  getEditingValue(commandId: string, field: string): unknown {
    return this.editingValues()[`${commandId}_${field}`];
  }

  updateEditingValue(commandId: string, field: string, value: unknown): void {
    this.editingValues.update((values) => ({
      ...values,
      [`${commandId}_${field}`]: value
    }));
  }

  cancelEdit(): void {
    this.editMode.set(null);
    this.editingValues.set({});
  }

  saveCellEdit(): void {
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
      this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
    });
  }

  canEditField(commandId: string, field: string): boolean {
    const command = this.commands().find((c) => c.id === commandId || c._id === commandId);
    if (command?.reserved && (field === 'message' || field === 'description')) {
      return false;
    }
    return true;
  }

  // ========== Enable/Disable ==========

  enableCommand(commandId: string): void {
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
        this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
      }
    });
  }

  disableCommand(commandId: string): void {
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
        this.toastService.error(this.t('commands.toast.saveErrorTitle'), this.t('commands.toast.saveErrorMessage'));
      }
    });
  }

  // ========== Delete ==========

  promptDeleteCommand(command: Command): void {
    const commandId = this.getCommandId(command);
    if (command.reserved || !commandId || this.isPending(commandId)) return;
    this.commandToDelete.set(command);
    this.showDeleteModal.set(true);
  }

  confirmDelete(): void {
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
        this.commands.update((cmds) => cmds.filter((c) => !this.matchesCommand(c, commandId)));
        this.clearCommandSnapshot(commandId);
        this.syncCurrentPage();
        this.toastService.success(this.t('commands.toast.deletedTitle'), this.t('commands.toast.deletedMessage'));
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

  private initializeFromURL(): void {
    const queryParams = this.route.snapshot.queryParams;
    const view = queryParams['view'] as ViewMode | undefined;
    const page = parseInt(queryParams['page'], 10);

    if (view === 'table' || view === 'card') {
      this.viewMode.set(view);
    } else {
      const sessionMode = this.getFromSession('viewMode') as ViewMode | null;
      if (sessionMode === 'table' || sessionMode === 'card') {
        this.viewMode.set(sessionMode);
      }
    }

    if (!isNaN(page) && page > 0) {
      this.currentPage.set(page);
    } else {
      const sessionPage = Number(this.getFromSession('currentPage'));
      if (Number.isFinite(sessionPage) && sessionPage > 0) {
        this.currentPage.set(sessionPage);
      }
    }

    const sessionItemsPerPage = Number(this.getFromSession('itemsPerPage'));
    if (
      Number.isFinite(sessionItemsPerPage) &&
      this.itemsPerPageOptions.includes(sessionItemsPerPage as 5 | 10 | 15 | 20)
    ) {
      this.itemsPerPage.set(sessionItemsPerPage);
    }
  }

  private loadTimerNames(channelID: string): void {
    this.http
      .get<{ data?: Array<{ name?: string; timerName?: string; cmd?: string }> }>(
        `${this.linksService.getApiUrl()}/timers/${encodeURIComponent(channelID)}`
      )
      .subscribe({
        next: (response) => {
          const rows = Array.isArray(response.data) ? response.data : [];
          const names = new Set<string>();
          for (const row of rows) {
            for (const key of [row.name, row.timerName, row.cmd]) {
              const value = String(key || '')
                .trim()
                .toLowerCase()
                .replace(/^!/, '');
              if (value) {
                names.add(value);
              }
            }
          }
          this.timerNames.set(names);
        },
        error: () => {
          this.timerNames.set(new Set());
        }
      });
  }

  private saveToSession(key: string, value: unknown): void {
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

  private updateURL(view: ViewMode, page?: number): void {
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

  // ========== Event Handlers ==========

  onDocumentClick(event: Event): void {
    const mode = this.editMode();
    if (mode?.type !== 'cell') return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (
      target.closest('.commands-table__cell--editable') ||
      target.closest('.commands-input') ||
      target.closest('.commands-select')
    ) {
      return;
    }

    this.saveCellEdit();
  }

  onDocumentEscape(): void {
    if (this.editMode()) {
      this.cancelEdit();
    }

    if (this.showCommandModal()) {
      this.closeModal();
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const mode = this.editMode();
      if (mode?.type === 'cell') {
        this.saveCellEdit();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }
}
