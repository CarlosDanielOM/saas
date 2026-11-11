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
import { ActivatedRoute, Router, RouterLink, convertToParamMap, type ParamMap } from '@angular/router';
import { catchError, combineLatest, map, of, switchMap } from 'rxjs';

import { Command, CreateCommandRequest, UpdateCommandRequest, USER_LEVELS, USER_LEVEL_NAMES, whoCanUsePhrase } from '../../models/command.model';
import { BotAccessService } from '../../services/bot-access.service';
import { CommandsApiService, type CommandSaveError, type CommandSaveResult, type ReservedCatalogCommand } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { TimersApiService } from '../../services/timers-api.service';
import { AssistantPresenceService } from '../assistant/assistant-presence.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmationModalComponent } from '../../shared/confirmation-modal/confirmation-modal.component';
import { FullAccessNoteComponent } from '../../shared/full-access-note/full-access-note.component';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { ThrottleClickDirective } from '../../shared/directives/throttle-click.directive';
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
import { CommandModalComponent, CommandModalSavePayload, CommandPrefill, PlanTier } from './command-modal.component';
import { BlocksViewerDialogComponent } from './blocks/blocks-viewer-dialog.component';
import { RandomUserSettingsComponent } from './randomuser-settings.component';
import { clearDraft, draftKey, takeResume } from './blocks/blocks.draft';
import { commandBlocksRoot, commandReplyText, isBlockCommand, timerMessageFor } from './blocks/command-blocks.util';

export type CommandFilter = 'all' | 'custom' | 'keyword' | 'timer' | 'builtin' | 'off';
type CommandKind = 'reserved' | 'timer' | 'normal' | 'keyword';
type PendingOperation = 'create' | 'update' | 'enable' | 'disable' | 'delete';
type CommandFeedbackState = 'success' | 'error';

interface CommandListItem extends Command {
  pendingOperation?: PendingOperation;
  optimistic?: boolean;
}

/** Reads a "Make a command" link once; the values only fill in the form (nothing is saved until the streamer saves). */
function readCommandPrefill(params: ParamMap): CommandPrefill | null {
  if (params.get('new') !== 'command') return null;
  const text = (key: string, max: number) => (params.get(key) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const prefill = { cmd: text('cmd', 40).replace(/^!+/, '').replace(/\s+/g, '').toLowerCase().slice(0, 30), name: text('name', 40), message: text('message', 500), description: text('description', 200) };
  return prefill.cmd || prefill.message ? prefill : null;
}

@Component({
  selector: 'app-commands-page',
  imports: [ReactiveFormsModule, NgTemplateOutlet, RouterLink, ConfirmationModalComponent, CommandModalComponent, LfIconComponent, BlocksViewerDialogComponent, RandomUserSettingsComponent, FullAccessNoteComponent, ThrottleClickDirective],
  templateUrl: './commands-page.component.html',
  styleUrl: './commands-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onDocumentEscape()'
  }
})
export class CommandsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly commandsApi = inject(CommandsApiService);
  private readonly timersApi = inject(TimersApiService);
  private readonly assistantPresence = inject(AssistantPresenceService);
  /** The assistant change (AssistantPresenceService.changedAt) this page has already loaded. */
  private assistantRevisionLoaded = 0;
  /** Counts list loads, so an answer that arrives after a newer load started is ignored. */
  private commandsLoadSeq = 0;
  /** Same for the repeat (timer) names: an older answer must not replace what a newer load showed. */
  private timersLoadSeq = 0;
  private readonly toastService = inject(ToastService);
  readonly botAccess = inject(BotAccessService);

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
  /** Why the last block save failed; the modal shows it in place. */
  readonly modalSaveError = signal<CommandSaveError | null>(null);
  /** Reopened after the upgrade checkout: the modal restores its draft directly. */
  readonly resumeDraft = signal(false);
  private resumeChecked: string | null = null;
  /** Read-only block view. */
  readonly viewingBlocks = signal<Command | null>(null);
  readonly isOwner = computed(() => !!this.channelID() && this.channelID() === this.sessionAuth.getPrimaryChannelID());

  isBlockCommand = isBlockCommand;
  commandBlocksRoot = commandBlocksRoot;

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

  /** Built-in rows: the real ones plus, before full access, the locked ones. */
  readonly builtinCount = computed(() => this.builtinList().length + this.lockedBuiltins().length);

  /** Real built-ins first, then the locked ones of the same group. `on` counts real rows only. */
  readonly builtinGroups = computed(() => {
    const groups = new Map<BuiltinGroup, { items: CommandListItem[]; locked: CommandListItem[] }>();
    const slot = (command: CommandListItem) => {
      const group = builtinInfo(command).group;
      let entry = groups.get(group);
      if (!entry) groups.set(group, (entry = { items: [], locked: [] }));
      return entry;
    };
    for (const command of this.builtinList()) slot(command).items.push(command);
    for (const command of this.lockedBuiltins()) slot(command).locked.push(command);
    const byCmd = (a: CommandListItem, b: CommandListItem) => a.cmd.localeCompare(b.cmd);
    return BUILTIN_GROUP_ORDER
      .filter((group) => groups.has(group))
      .map((group) => {
        const { items, locked } = groups.get(group)!;
        items.sort(byCmd);
        locked.sort(byCmd);
        return { group, items, locked, on: items.filter((c) => c.enabled !== false).length };
      });
  });

  readonly filterCounts = computed<Record<CommandFilter, number>>(() => ({
    all: this.totalCommands(),
    custom: this.customList().length,
    keyword: this.keywordList().length,
    timer: this.timerList().length,
    builtin: this.builtinCount(),
    off: this.offList().length
  }));

  private readonly searchQuery = computed(() => this.searchInput().trim().toLowerCase().replace(/^!/, ''));

  /** Flat results while searching: name, trigger, reply or built-in description. */
  readonly searchResults = computed(() => {
    const query = this.searchQuery();
    if (!query) return [];
    return this.byName(this.commands().filter((command) =>
      [command.name, command.cmd, commandReplyText(command), command.reserved ? this.builtinDescription(command) : '']
        .join(' ')
        .toLowerCase()
        .includes(query)));
  });

  /** Locked built-ins that match the search (shown after the real results). */
  readonly searchLockedResults = computed(() => {
    const query = this.searchQuery();
    if (!query) return [];
    return this.byName(this.lockedBuiltins().filter((command) =>
      [this.builtinTitle(command), command.cmd, this.builtinDescription(command)].join(' ').toLowerCase().includes(query)));
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

  /**
   * The assistant created, changed, deleted or undid a command or a repeat on this channel: read the
   * list again (past the cache), so it shows up here without a reload. Also runs when the page opens
   * after such a change, so a list cached before it is not what the streamer sees.
   */
  private readonly assistantChangeEffect = effect(() => {
    const revision = this.assistantPresence.changedAt('commands', 'timers');
    // While a save made on this page is still on its way, wait: the effect runs again when it settles.
    const saving = this.commands().some((command) => !!command.pendingOperation);
    const channelID = this.channelID();
    if (revision <= this.assistantRevisionLoaded || saving || !channelID) return;
    untracked(() => {
      this.assistantRevisionLoaded = revision;
      this.loadCommands(channelID, { skipCache: true });
      this.loadTimerNames(channelID);
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
    const seq = ++this.commandsLoadSeq;
    this.commandsApi.getCommands(channelID, { skipCache: options.skipCache, activation: 'all', limit: 1000 }).subscribe({
      next: (cmds) => {
        if (seq !== this.commandsLoadSeq) return;
        this.commands.set(this.keepPendingRows(this.normalizeCommands(cmds)));
        this.commandsLoadedFor.set(channelID);
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

  /**
   * A fresh list must not drop what is being saved on this page right now: rows with a pending
   * operation (a new command still being created, an edit, a toggle, a delete) stay as they are
   * shown, so the save's own answer still finds its row.
   */
  private keepPendingRows(fresh: CommandListItem[]): CommandListItem[] {
    const pending = this.commands().filter((command) => !!command.pendingOperation);
    if (pending.length === 0) return fresh;
    const ids = new Set(pending.map((command) => this.getCommandId(command)));
    return [...fresh.filter((command) => !ids.has(this.getCommandId(command))), ...pending];
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

  /** Once commands and edit access are both known, reopen a draft left for the upgrade checkout. */
  private readonly resumeEffect = effect(() => {
    const channelID = this.channelID();
    if (!channelID || !this.canManage() || this.commands().length === 0) return;
    untracked(() => this.resumeAfterCheckout(channelID));
  });

  /** Starting values for the create dialog, from a "Make a command" link (?new=command&cmd=…&message=…). */
  readonly modalPrefill = signal<CommandPrefill | null>(null);
  private readonly commandsLoadedFor = signal<string | null>(null);

  // ========== Built-ins before full access ==========

  /** The bot's default commands; the ones that need the Twitch approval are shown locked until then. */
  private readonly reservedCatalog = signal<{ language: string; items: ReservedCatalogCommand[] } | null>(null);
  private catalogRequested: string | null = null;

  /**
   * The API says this channel has no full access (owners and managers alike). Built-ins that need
   * no Twitch approval are already real commands; only the rest show locked. Unknown counts as unlocked.
   */
  readonly builtinsLocked = computed(() => {
    const channelID = this.channelID();
    return !!channelID && this.commandsApi.fullAccessByChannel()[channelID] === false;
  });

  /**
   * Catalog entries that need full access, as read-only rows. Skips a default whose name or job the
   * channel already has (full access won't add those either).
   */
  readonly lockedBuiltins = computed<CommandListItem[]>(() => {
    const catalog = this.reservedCatalog();
    if (!catalog || !this.builtinsLocked()) return [];
    const channelID = this.channelID() ?? '';
    const takenCmds = new Set<string>();
    const takenFuncs = new Set<string>();
    for (const command of this.commands()) {
      if (command.activation === 'keyword') continue;
      takenCmds.add((command.cmd || '').toLowerCase());
      if (command.func) takenFuncs.add(command.func);
    }
    return catalog.items
      .filter((entry) => entry.requiresFullAccess === true && entry.func && entry.cmd
        && !takenCmds.has(entry.cmd.toLowerCase()) && !takenFuncs.has(entry.func))
      .map((entry): CommandListItem => ({
        id: `catalog:${entry.func}`,
        channel: '',
        channelID,
        cmd: entry.cmd,
        activation: 'command',
        func: entry.func,
        cooldown: Number(entry.cooldown) || 0,
        createdAt: '',
        description: typeof entry.description === 'string' ? entry.description : null,
        enabled: false,
        message: typeof entry.message === 'string' ? entry.message : '',
        name: entry.name || entry.cmd,
        // Shown as built-ins: catalog name, description and usage.
        reserved: true,
        userLevel: Number(entry.userLevel) || 0,
        userLevelName: entry.userLevelName || 'everyone'
      }));
  });

  private readonly catalogEffect = effect(() => {
    if (!this.builtinsLocked()) return;
    const language = this.languageService.currentLanguage();
    untracked(() => this.loadReservedCatalog(language));
  });

  private loadReservedCatalog(language: string): void {
    if (this.reservedCatalog()?.language === language || this.catalogRequested === language) return;
    this.catalogRequested = language;
    this.commandsApi.getReservedCatalog(language).subscribe((items) => {
      if (this.catalogRequested === language) this.catalogRequested = null;
      if (items.length) this.reservedCatalog.set({ language, items });
    });
  }

  /** Timers start and stop with the stream (Twitch events), so they wait for full access. */
  readonly allowTimers = computed(() => {
    const channelID = this.channelID();
    return !channelID || this.commandsApi.fullAccessByChannel()[channelID] !== false;
  });

  /** Owner only: the bot isn't in their chat, so no command answers yet. */
  readonly showChatNote = computed(() => this.botAccess.isOwnChannel(this.channelID()) && !this.botAccess.chatEnabled());

  readonly ttsPath = computed(() => ['/', this.streamer(), 'modules', 'tts']);

  /** Quick start: a `!tts` command that reads the viewer's message aloud (nothing is saved until they save). */
  openTtsCommand(): void {
    const spanish = this.languageService.getCurrentLanguage() === 'es';
    this.newItemKind.set('command');
    this.openCreateModal({
      cmd: 'tts',
      name: this.t('commands.quickStart.ttsName'),
      message: spanish ? '$(tts $(user) dice: &t)' : '$(tts $(user) says: &t)',
      description: this.t('commands.quickStart.ttsDescription')
    });
  }
  private linkPrefill = readCommandPrefill(this.route.snapshot.queryParamMap);
  private readonly prefillEffect = effect(() => {
    const channelID = this.channelID();
    // Waits for a successful list load (an empty list counts); after a failed load, Retry brings it back.
    if (!this.linkPrefill || !channelID || !this.canManage() || this.commandsLoadedFor() !== channelID) return;
    untracked(() => {
      const prefill = this.linkPrefill;
      this.linkPrefill = null;
      void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
      if (this.showCommandModal() || !prefill) return;
      this.newItemKind.set('command');
      this.openCreateModal(prefill);
    });
  });

  /** Back from the upgrade checkout: reopen the command that was being built. */
  private resumeAfterCheckout(channelID: string): void {
    if (this.resumeChecked === channelID) return;
    this.resumeChecked = channelID;
    const key = takeResume(channelID);
    if (!key) return;
    const id = key.split('.').pop() ?? '';
    const command = id.startsWith('new-') ? null : this.commands().find((item) => this.getCommandId(item) === id) ?? null;
    if (!id.startsWith('new-') && !command) return;
    if (id === 'new-keyword') this.newItemKind.set('keyword');
    this.resumeDraft.set(true);
    this.modalSaveError.set(null);
    this.editingCommand.set(command);
    this.showCommandModal.set(true);
  }

  viewBlocks(command: Command): void {
    this.viewingBlocks.set(command);
  }

  openCreateModal(prefill: CommandPrefill | null = null): void {
    if (!this.canManage()) return;
    if (!this.checkRateLimit()) return;
    this.modalPrefill.set(prefill);
    this.editingCommand.set(null);
    this.resumeDraft.set(false);
    this.modalSaveError.set(null);
    this.showCommandModal.set(true);
  }

  openEditModal(command: Command): void {
    if (!this.canManage()) return;
    if (!this.checkRateLimit()) return;
    this.editingCommand.set(command);
    this.resumeDraft.set(false);
    this.modalSaveError.set(null);
    this.showCommandModal.set(true);
  }

  closeModal(): void {
    this.showCommandModal.set(false);
    this.modalPrefill.set(null);
    this.editingCommand.set(null);
    this.resumeDraft.set(false);
  }

  private modalDraftKey(channelID: string, editing: Command | null, activation: 'command' | 'keyword' | undefined): string {
    return draftKey({ channelID, commandId: editing ? this.getCommandId(editing) : null, activation: activation === 'keyword' ? 'keyword' : 'command' });
  }

  /** Block saves wait for the server so problems can be shown on the block itself. */
  private saveBlocksCommand(channelID: string, payload: CommandModalSavePayload, editing: Command | null, session: { twitchUser: { login?: string } }): void {
    const request = payload.command;
    const key = this.modalDraftKey(channelID, editing, editing?.activation ?? request.activation);
    const previousTimerName = editing ? this.resolveTimerName(editing) : null;
    this.recordRequest();
    const request$ = editing
      ? this.commandsApi.updateCommandDetailed(channelID, this.getCommandId(editing), {
          ...(request.keywordSettings ? { keywordSettings: request.keywordSettings } : {}),
          name: request.name,
          cmd: request.cmd,
          authoring: 'blocks',
          ...(request.blocks ? { blocks: request.blocks } : {}),
          description: request.description || null,
          cooldown: request.cooldown,
          userLevel: request.userLevel,
          userLevelName: USER_LEVELS[request.userLevel],
          enabled: request.enabled,
          ...(request.permissionExpression !== undefined ? { permissionExpression: request.permissionExpression } : {})
        })
      : this.commandsApi.createCommandDetailed(channelID, { ...request, channel: session.twitchUser.login || channelID });

    request$.subscribe((result: CommandSaveResult) => {
      if (!result.command) {
        this.modalSaveError.set({ ...result.error });
        return;
      }
      const saved = result.command;
      clearDraft(key);
      if (editing) this.replaceCommandItem(this.getCommandId(editing), saved);
      else this.commands.update((cmds) => [...cmds, ...this.normalizeCommands([saved])]);
      this.setCommandFeedbackState(this.getCommandId(saved), 'success');
      this.closeModal();
      this.toastService.success(
        this.t(editing ? 'commands.toast.savedTitle' : 'commands.toast.createdTitle'),
        this.t(editing ? 'commands.toast.savedMessage' : 'commands.toast.createdMessage')
      );
      if (saved.activation !== 'keyword') {
        this.syncCommandTimer(channelID, saved.cmd || request.cmd, previousTimerName, timerMessageFor(saved, ''), payload.timer);
      }
    });
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
    this.modalSaveError.set(null);
    if (request.authoring === 'blocks') {
      this.saveBlocksCommand(channelID, payload, editingCmd, session);
      return;
    }
    const savedDraftKey = this.modalDraftKey(channelID, editingCmd, editingCmd?.activation ?? request.activation);

    if (editingCmd) {
      const commandId = this.getCommandId(editingCmd);
      const updates: UpdateCommandRequest = {
        ...(request.keywordSettings ? { keywordSettings: request.keywordSettings } : {}),
        name: request.name,
        cmd: request.cmd,
        message: request.message,
        ...(request.authoring ? { authoring: request.authoring } : {}),
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
        blocks: updates.authoring === 'text' ? null : cmd.blocks,
        permissionMode: updates.permissionExpression === undefined
          ? cmd.permissionMode
          : updates.permissionExpression === null ? 'level' : 'tags',
        pendingOperation: 'update'
      }));
      this.closeModal();

      this.commandsApi.updateCommand(channelID, commandId, updates).subscribe((updated) => {
        if (updated) {
          clearDraft(savedDraftKey);
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
          clearDraft(savedDraftKey);
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
    const savedId = this.getCommandId(normalizedCommand);

    this.commands.update((commands) => {
      if (!commands.some((currentCommand) => this.matchesCommand(currentCommand, commandId))) return commands;
      // A list refresh can bring the saved command in under its real id while its row here still has
      // the temporary one: keep a single row for it, the one this save's answer replaces.
      return commands
        .filter((currentCommand) => this.matchesCommand(currentCommand, commandId) || this.getCommandId(currentCommand) !== savedId)
        .map((currentCommand) => (this.matchesCommand(currentCommand, commandId) ? normalizedCommand : currentCommand));
    });
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
    const args = command.reserved ? builtinInfo(command).usage : customUsage(commandReplyText(command));
    return args ? `!${command.cmd} ${formatUsage(args, (key, params) => this.t(key, params))}` : null;
  }

  replyParts(command: Command): ReplyPart[] {
    return replyParts(command.message || '');
  }

  groupLabel(group: BuiltinGroup): string {
    return this.t(`commands.builtin.groups.${group}`);
  }

  groupPreview(real: Command[], locked: Command[] = []): string {
    const items = [...real, ...locked];
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
    const seq = ++this.timersLoadSeq;
    this.timersApi.listTimers(channelID).subscribe({
      next: (rows) => {
        if (seq !== this.timersLoadSeq) return;
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
        if (seq !== this.timersLoadSeq) return;
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
