import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import {
  Command,
  KeywordMatchMode,
  CreateCommandRequest,
  USER_LEVELS,
  USER_LEVEL_NAMES,
  whoCanUsePhrase
} from '../../models/command.model';
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
import { CommandsApiService, type CommandSaveError } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';
import { TwitchAccountLookupService } from '../../services/twitch-account-lookup.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { BlocksEditorComponent } from './blocks/blocks-editor.component';
import { type CommandDraft, clearDraft, draftKey, markResume, readDraft, writeDraft } from './blocks/blocks.draft';
import { type RootNode, emptyRoot, rootFromStored } from './blocks/blocks.model';
import { BlocksStore } from './blocks/blocks.store';

export type PlanTier = 'free' | 'premium' | 'pro';

export interface CommandModalSavePayload {
  command: CreateCommandRequest;
  timer: {
    enabled: boolean;
    minutes: number | null;
  };
}

const FREE_INTERVALS: readonly number[] = [10, 20, 30, 40, 50, 60];
/** Website saves allow long replies; chat !ec keeps its own short limit. */
export const MAX_REPLY_LENGTH = 10_000;
const DRAFT_DELAY_MS = 600;
const PREMIUM_QUICK = [5, 10, 15, 30, 45, 60, 90, 120, 180] as const;
const PRO_QUICK = [1, 5, 7, 12, 15, 30, 45, 60, 90, 120, 180] as const;

@Component({
  selector: 'app-command-modal',
  imports: [ReactiveFormsModule, NgTemplateOutlet, LfIconComponent, BlocksEditorComponent],
  providers: [BlocksStore],
  templateUrl: './command-modal.component.html',
  styleUrl: './command-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommandModalComponent {
  private readonly fb = inject(FormBuilder);
  private readonly languageService = inject(LanguageService);
  private readonly accountLookup = inject(TwitchAccountLookupService);
  private readonly commandsApi = inject(CommandsApiService);
  private readonly upgradeService = inject(UpgradeService);
  readonly blocks = inject(BlocksStore);
  private accessSession = 0;
  private draftTimer: number | null = null;
  /** Set once the dialog is filled in, so loading doesn't count as a change. */
  private tracking = false;
  private readonly mobileAccessTrigger = viewChild<ElementRef<HTMLButtonElement>>('mobileAccessTrigger');
  private readonly mobileTagsBackButton = viewChild<ElementRef<HTMLButtonElement>>('mobileTagsBackButton');
  private readonly mobileAccountsBackButton = viewChild<ElementRef<HTMLButtonElement>>('mobileAccountsBackButton');
  private readonly desktopAccountsTrigger = viewChild<ElementRef<HTMLButtonElement>>('desktopAccountsTrigger');
  private readonly desktopAccountsClose = viewChild<ElementRef<HTMLButtonElement>>('desktopAccountsClose');

  readonly isOpen = input.required<boolean>();
  readonly command = input<Command | null>(null);
  readonly selectedActivation = signal<'command' | 'keyword'>('command');
  readonly isKeyword = computed(() => (this.command()
    ? this.command()?.activation ?? 'command' : this.selectedActivation()) === 'keyword');
  readonly planTier = input<PlanTier>('free');
  readonly commands = input<Command[]>([]);
  readonly allowTimer = input(true);
  readonly zeroCooldownAvailable = computed(() => !this.isKeyword() && (this.command()?.reserved ? this.command()?.cooldown === 0 : !this.commands().some(item =>
    !item.reserved && item.cooldown === 0 && (item._id || item.id) !== (this.command()?._id || this.command()?.id))));
  readonly isSpeech = computed(() => ['speach', 'speech'].includes(this.command()?.func || ''));
  /** Existing timer interval for this command (minutes), if linked. */
  readonly existingTimerMinutes = input<number | null>(null);
  /** Tab a new item opens on. */
  readonly startAs = input<'command' | 'keyword'>('command');
  readonly channelID = input<string | null>(null);
  /** The channel owner (not a helper) is the one who can upgrade. */
  readonly isOwner = input(true);
  /** Reopening after the upgrade checkout: restore the draft without asking. */
  readonly resumeDraft = input(false);
  /** Why the last block save failed (set by the commands page). */
  readonly saveError = input<CommandSaveError | null>(null);

  readonly modalTab = signal<'details' | 'blocks'>('details');
  readonly authoring = signal<'text' | 'blocks'>('text');
  readonly blocksAllowed = computed(() => this.planTier() === 'premium' || this.planTier() === 'pro');
  /** A block command on a channel that no longer has Premium/Pro: keeps running, read-only. */
  readonly blocksLocked = computed(() => this.authoring() === 'blocks' && this.command()?.authoring === 'blocks' && !this.blocksAllowed());
  readonly showUpgrade = signal(false);
  readonly converting = signal(false);
  readonly convertError = signal<string | null>(null);
  readonly confirmToText = signal(false);
  readonly draftOffer = signal<CommandDraft | null>(null);
  readonly draftSaved = signal(false);
  readonly blockErrorMessage = signal<string | null>(null);
  readonly maxReplyLength = MAX_REPLY_LENGTH;

  readonly isEditMode = signal(false);
  readonly isSaving = signal(false);
  readonly formError = signal<string | null>(null);
  readonly accessDraft = signal<AccessDraft>(emptyAccessDraft());
  readonly accessMode = signal<'level' | 'tags'>('level');
  readonly mobileAccessView = signal<'main' | 'tags' | 'accounts'>('main');
  readonly accountsOpen = signal(false);
  readonly lookupInput = signal({ allow: '', exclude: '' });
  readonly lookupPending = signal<'allow' | 'exclude' | null>(null);
  readonly lookupError = signal<string | null>(null);
  readonly accessTags = ACCESS_TAGS;
  readonly maxUsersPerList = 5;

  readonly accountCount = computed(() => {
    const draft = this.accessDraft();
    return draft.allowUsers.length + draft.excludeUsers.length;
  });

  readonly save = output<CommandModalSavePayload>();
  readonly cancel = output<void>();

  readonly freeIntervals = FREE_INTERVALS;
  readonly premiumQuick = PREMIUM_QUICK;
  readonly proQuick = PRO_QUICK;

  readonly commandForm = this.fb.group({
    name: ['', [Validators.required]],
    cmd: ['', [Validators.required]],
    message: ['', [Validators.required]],
    description: [''],
    cooldown: [10, [Validators.required, Validators.min(5), Validators.max(60)]],
    userLevel: [1, [Validators.required, Validators.min(1), Validators.max(10)]],
    enabled: [true],
    matchMode: ['start' as KeywordMatchMode, Validators.required],
    timerEnabled: [false],
    timerMinutes: [15 as number | null]
  });

  readonly minCooldown = computed(() => this.planTier() === 'pro' ? 1 : this.planTier() === 'premium' ? 3 : 5);

  readonly isReserved = computed(() => Boolean(this.command()?.reserved));

  readonly intervalHint = computed(() => {
    const tier = this.planTier();
    if (tier === 'pro') {
      return this.t('commands.modal.timerHintPro');
    }
    if (tier === 'premium') {
      return this.t('commands.modal.timerHintPremium');
    }
    return this.t('commands.modal.timerHintFree');
  });

  readonly timerLimitLabel = computed(() => {
    const tier = this.planTier();
    if (tier === 'pro') return '50';
    if (tier === 'premium') return '15';
    return '5';
  });

  constructor() {
    // Block replies have no text to validate.
    effect(() => {
      const message = this.commandForm.controls.message;
      message.setValidators(this.authoring() === 'blocks' ? [] : [Validators.required, Validators.maxLength(MAX_REPLY_LENGTH)]);
      message.updateValueAndValidity({ emitEvent: false });
    });
    // The preview and warnings follow the command's "who can use it" (unknown for tag rules).
    const syncLevel = () => this.blocks.commandLevel.set(
      this.accessMode() === 'level' ? Number(this.commandForm.controls.userLevel.value) || 1 : null);
    this.commandForm.controls.userLevel.valueChanges.subscribe(syncLevel);
    effect(() => {
      this.accessMode();
      untracked(syncLevel);
    });
    // Keep a draft in this browser while something is unsaved.
    this.commandForm.valueChanges.subscribe(() => this.queueDraft());
    effect(() => {
      this.blocks.editCount();
      this.authoring();
      untracked(() => this.queueDraft());
    });
    // Show the server's complaint where it belongs.
    effect(() => {
      const error = this.saveError();
      untracked(() => this.applySaveError(error));
    });
    effect(() => {
      const trigger = this.commandForm.controls.cmd;
      trigger.setValidators(this.isKeyword()
        ? [Validators.required, Validators.maxLength(60), Validators.pattern(/^[\p{L}\p{N}\p{M}_]+(?:\s+[\p{L}\p{N}\p{M}_]+)*$/u)]
        : [Validators.required]);
      trigger.updateValueAndValidity({ emitEvent: false });
    });
    effect(() => {
      const cooldown = this.commandForm.controls.cooldown;
      const minimum = this.minCooldown();
      const zeroAllowed = this.zeroCooldownAvailable();
      cooldown.setValidators([Validators.required, Validators.max(60), control =>
        (Number(control.value) === 0 && zeroAllowed) || Number(control.value) >= minimum
          ? null : { cooldown: true }]);
      cooldown.updateValueAndValidity({ emitEvent: false });
    });
    effect(() => {
      if (!this.isOpen()) {
        this.accessSession += 1;
        this.isSaving.set(false);
        this.formError.set(null);
        this.tracking = false;
        this.flushDraft();
        return;
      }
      untracked(() => this.setupForm());
    });
  }

  // ---------- blocks ----------

  setModalTab(tab: 'details' | 'blocks'): void {
    this.modalTab.set(tab);
    this.formError.set(null);
  }

  onModalTabKeydown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'details' : event.key === 'End' ? 'blocks' : this.modalTab() === 'details' ? 'blocks' : 'details';
    this.setModalTab(next);
    const list = (event.currentTarget as HTMLElement).parentElement;
    list?.querySelector<HTMLButtonElement>(`#modal-tab-${next}`)?.focus();
  }

  /** Start building: empty, or from the reply typed in Details. */
  async useBlocks(from: 'empty' | 'reply'): Promise<void> {
    this.convertError.set(null);
    if (from === 'empty') {
      this.blocks.load(emptyRoot());
      this.authoring.set('blocks');
      return;
    }
    const text = String(this.commandForm.controls.message.value || '').trim();
    const channelID = this.channelID();
    if (!text || !channelID) return;
    this.converting.set(true);
    const { result, error } = await firstValueFrom(this.commandsApi.importBlocks(channelID, text));
    this.converting.set(false);
    if (!result) {
      this.convertError.set(error?.code === 'too_long' ? this.t('commandBlocks.import.tooLong') : this.t('commandBlocks.import.failed'));
      return;
    }
    this.blocks.load(result.root);
    this.blocks.editCount.update((n) => n + 1);
    this.authoring.set('blocks');
  }

  /** Back to a text reply: the blocks stay here until saving, but the reply starts empty. */
  switchToText(): void {
    if (this.command()?.authoring === 'blocks' && !this.confirmToText()) {
      this.confirmToText.set(true);
      return;
    }
    this.confirmToText.set(false);
    this.authoring.set('text');
    this.commandForm.controls.message.setValue('');
    this.modalTab.set('details');
  }

  async seePlans(): Promise<void> {
    const channelID = this.channelID();
    if (channelID) {
      this.flushDraft(true);
      markResume(channelID, this.currentDraftKey());
    }
    await this.upgradeService.promptUpgradeForAnyPlan('command_blocks');
  }

  restoreDraft(): void {
    const draft = this.draftOffer();
    if (draft) this.applyDraft(draft);
    this.draftOffer.set(null);
  }

  discardDraft(): void {
    clearDraft(this.currentDraftKey());
    this.draftOffer.set(null);
  }

  draftAge(draft: CommandDraft): string {
    const minutes = Math.max(0, Math.round((Date.now() - draft.savedAt) / 60000));
    if (minutes < 1) return this.t('commandBlocks.draft.justNow');
    if (minutes < 60) return this.t('commandBlocks.draft.minutes', { count: minutes });
    const hours = Math.round(minutes / 60);
    return hours < 48 ? this.t('commandBlocks.draft.hours', { count: hours }) : this.t('commandBlocks.draft.days', { count: Math.round(hours / 24) });
  }

  currentDraftKey(): string {
    const cmd = this.command();
    return draftKey({ channelID: this.channelID() ?? 'unknown', commandId: cmd ? cmd._id || cmd.id : null, activation: this.isKeyword() ? 'keyword' : 'command' });
  }

  private applySaveError(error: CommandSaveError | null): void {
    if (!error) return;
    this.isSaving.set(false);
    if (error.code === 'plan_required') {
      this.showUpgrade.set(true);
      return;
    }
    if (error.blockId) {
      this.blockErrorMessage.set(error.message || this.t('commandBlocks.errors.block'));
      this.blocks.errorBlockId.set(error.blockId);
      this.modalTab.set('blocks');
      this.formError.set(this.t('commandBlocks.errors.fixBlock'));
      return;
    }
    this.formError.set(error.code === 'too_long' ? this.t('commandBlocks.errors.tooLong', { max: MAX_REPLY_LENGTH })
      : error.message || this.t('commandBlocks.errors.save'));
  }

  private queueDraft(): void {
    if (!this.tracking || !this.isOpen()) return;
    this.draftSaved.set(false);
    if (this.draftTimer !== null) window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => this.flushDraft(), DRAFT_DELAY_MS);
  }

  /** Writes the pending draft now (also on close, so an accidental close keeps the work). */
  private flushDraft(force = false): void {
    if (this.draftTimer !== null) {
      window.clearTimeout(this.draftTimer);
      this.draftTimer = null;
    } else if (!force) {
      return;
    }
    if (!this.channelID()) return;
    const saved = writeDraft(this.currentDraftKey(), {
      authoring: this.authoring(),
      root: this.authoring() === 'blocks' || !this.blocks.isEmpty() ? this.blocks.root() : null,
      form: this.commandForm.getRawValue(),
      access: { mode: this.accessMode(), draft: this.accessDraft() }
    });
    this.draftSaved.set(saved);
  }

  private applyDraft(draft: CommandDraft): void {
    this.tracking = false;
    const { message, ...rest } = draft.form as Record<string, unknown>;
    this.commandForm.patchValue({ ...rest, ...(this.isReserved() ? {} : { message: typeof message === 'string' ? message : '' }) } as never);
    const access = draft.access as { mode?: 'level' | 'tags'; draft?: AccessDraft } | undefined;
    if (access?.mode) this.accessMode.set(access.mode);
    if (access?.draft) this.accessDraft.set(access.draft);
    if (draft.root) this.blocks.load(draft.root);
    this.authoring.set(draft.authoring === 'blocks' && !this.isReserved() ? 'blocks' : 'text');
    if (draft.authoring === 'blocks') this.modalTab.set('blocks');
    this.tracking = true;
    this.queueDraft();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  getUserLevelName(level: number): string {
    return USER_LEVEL_NAMES[level] || 'commands.userLevels.everyone';
  }

  whoCanUse(level: number): string {
    return whoCanUsePhrase(level, (key, params) => this.t(key, params));
  }

  onOverlayClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.onCancel();
    }
  }

  onCancel(): void {
    this.cancel.emit();
  }

  selectActivation(activation: 'command' | 'keyword'): void {
    if (this.isEditMode()) return;
    this.selectedActivation.set(activation);
    this.formError.set(null);
  }

  onTypeTabKeydown(event: KeyboardEvent, activation: 'command' | 'keyword'): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'command' : event.key === 'End' ? 'keyword'
      : activation === 'command' ? 'keyword' : 'command';
    this.selectActivation(next);
    const list = (event.currentTarget as HTMLElement).parentElement;
    list?.querySelector<HTMLButtonElement>(`#${next}-type-tab`)?.focus();
  }

  tagDecision(tag: AccessTag): TagDecision {
    return this.accessDraft().tags[tag];
  }

  tagLabel(tag: AccessTag): string {
    return this.t(`commands.access.tags.${tag}`);
  }

  cycleTag(tag: AccessTag): void {
    const draft = this.accessDraft();
    if (!draft.editable) return;
    this.accessDraft.set(cycleAccessTag(draft, tag));
  }

  setAccessMode(mode: 'level' | 'tags'): void {
    if (mode === this.accessMode()) return;
    this.accessSession += 1;
    this.lookupPending.set(null);
    this.lookupInput.set({ allow: '', exclude: '' });
    this.lookupError.set(null);
    this.accountsOpen.set(false);
    this.accessMode.set(mode);
    this.formError.set(null);
  }

  setBaseLevel(raw: string): void {
    const level = Number(raw);
    if (!Number.isInteger(level) || level < 1 || level > 10) return;
    this.commandForm.controls.userLevel.setValue(level);
  }

  resetAdvancedAccess(): void {
    this.accessDraft.set(emptyAccessDraft());
    this.lookupError.set(null);
  }

  openMobileTags(): void {
    this.mobileAccessView.set('tags');
    setTimeout(() => this.mobileTagsBackButton()?.nativeElement.focus());
  }

  openMobileAccounts(): void {
    this.mobileAccessView.set('accounts');
    this.lookupError.set(null);
    setTimeout(() => this.mobileAccountsBackButton()?.nativeElement.focus());
  }

  backMobileAccess(): void {
    const next = this.mobileAccessView() === 'accounts' ? 'tags' : 'main';
    this.mobileAccessView.set(next);
    this.lookupError.set(null);
    setTimeout(() => (next === 'tags' ? this.mobileTagsBackButton() : this.mobileAccessTrigger())?.nativeElement.focus());
  }

  openDesktopAccounts(): void {
    this.accountsOpen.set(true);
    this.lookupError.set(null);
    setTimeout(() => this.desktopAccountsClose()?.nativeElement.focus());
  }

  closeDesktopAccounts(): void {
    this.accountsOpen.set(false);
    setTimeout(() => this.desktopAccountsTrigger()?.nativeElement.focus());
  }

  setLookupInput(kind: 'allow' | 'exclude', value: string): void {
    this.lookupInput.update((current) => ({ ...current, [kind]: value }));
    this.lookupError.set(null);
  }

  canAddAccount(kind: 'allow' | 'exclude'): boolean {
    return this.accessDraft()[kind === 'allow' ? 'allowUsers' : 'excludeUsers'].length < this.maxUsersPerList;
  }

  async addAccount(kind: 'allow' | 'exclude'): Promise<void> {
    if (this.lookupPending() || !this.canAddAccount(kind) || !this.accessDraft().editable) return;
    const input = this.lookupInput()[kind];
    const session = this.accessSession;
    this.lookupPending.set(kind);
    this.lookupError.set(null);
    try {
      const resolved = await firstValueFrom(this.accountLookup.lookup(input));
      if (!this.isOpen() || session !== this.accessSession) return;
      const draft = this.accessDraft();
      const target = kind === 'allow' ? 'allowUsers' : 'excludeUsers';
      const opposite = kind === 'allow' ? 'excludeUsers' : 'allowUsers';
      if (draft[target].some((user) => user.id === resolved.id)) {
        this.lookupError.set(this.t('commands.access.alreadyAdded'));
        return;
      }
      this.accessDraft.set({
        ...draft,
        [target]: [...draft[target], resolved],
        [opposite]: draft[opposite].filter((user) => user.id !== resolved.id)
      });
      this.lookupInput.update((current) => ({ ...current, [kind]: '' }));
    } catch {
      if (this.isOpen() && session === this.accessSession) {
        this.lookupError.set(this.t('commands.access.lookupError'));
      }
    } finally {
      if (session === this.accessSession) this.lookupPending.set(null);
    }
  }

  removeAccount(kind: 'allow' | 'exclude', user: TwitchAccountRef): void {
    const key = kind === 'allow' ? 'allowUsers' : 'excludeUsers';
    this.accessDraft.update((draft) => ({
      ...draft,
      [key]: draft[key].filter((entry) => entry.id !== user.id)
    }));
  }

  accessSummary(): string {
    const draft = this.accessDraft();
    if (this.accessMode() === 'level') return this.whoCanUse(Number(this.commandForm.controls.userLevel.value) || 1);
    if (!draft.editable) return this.t(draft.legacyCombined ? 'commands.access.legacyCombined' : 'commands.access.advancedRule');
    return this.t('commands.access.customSummary', { count: this.accountCount() });
  }

  setTimerEnabled(enabled: boolean): void {
    this.commandForm.patchValue({ timerEnabled: enabled });
    if (enabled && !this.commandForm.value.timerMinutes) {
      this.commandForm.patchValue({
        timerMinutes: this.planTier() === 'free' ? 10 : this.planTier() === 'premium' ? 15 : 5
      });
    }
    this.formError.set(null);
  }

  setTimerMinutes(minutes: number): void {
    this.commandForm.patchValue({ timerMinutes: minutes });
    this.formError.set(null);
  }

  onSubmit(): void {
    if (this.accessMode() === 'tags' && this.accessDraft().legacyCombined) {
      this.formError.set(this.t('commands.access.chooseMethod'));
      return;
    }
    if (this.accessMode() === 'tags' &&
      (this.lookupPending() || this.lookupInput().allow.trim() || this.lookupInput().exclude.trim())) {
      this.formError.set(this.t('commands.access.finishUsername'));
      return;
    }
    if (this.accessMode() === 'tags' && this.accessDraft().editable && !hasAccessRules(this.accessDraft())) {
      this.formError.set(this.t('commands.access.chooseRule'));
      return;
    }
    if (this.commandForm.invalid) {
      this.commandForm.markAllAsTouched();
      this.formError.set(this.t('commands.modal.validationRequired'));
      this.modalTab.set('details');
      return;
    }

    const usesBlocks = this.authoring() === 'blocks' && !this.isReserved();
    const wasBlocks = this.command()?.authoring === 'blocks';
    const blocksChanged = usesBlocks && (!wasBlocks || this.blocks.editCount() > 0);
    if (usesBlocks && this.blocks.isEmpty()) {
      this.formError.set(this.t('commandBlocks.errors.empty'));
      this.modalTab.set('blocks');
      return;
    }
    if (blocksChanged && !this.blocksAllowed()) {
      this.flushDraft(true);
      this.showUpgrade.set(true);
      return;
    }

    const formValue = this.commandForm.getRawValue();
    const timerEnabled = Boolean(formValue.timerEnabled) && !this.isReserved() && this.allowTimer() && !this.isKeyword();
    const timerMinutes = Number(formValue.timerMinutes);

    if (timerEnabled) {
      const validation = this.validateTimerMinutes(timerMinutes, this.planTier());
      if (!validation.valid) {
        this.formError.set(validation.error || this.t('commands.modal.timerInvalid'));
        return;
      }
    }

    this.isSaving.set(true);
    this.formError.set(null);

    const request: CreateCommandRequest = {
      ...(this.isKeyword() ? { activation: 'keyword', keywordSettings: { matchMode: formValue.matchMode ?? 'start' } } : {}),
      name: String(formValue.name || '').trim(),
      cmd: this.isKeyword() ? String(formValue.cmd || '').normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ')
        : String(formValue.cmd || '').trim().replace(/^!/, ''),
      func: this.command()?.func || String(formValue.cmd || '')
        .trim()
        .replace(/^!/, ''),
      message: usesBlocks ? '' : String(formValue.message || '').trim(),
      ...(usesBlocks ? { authoring: 'blocks' as const, ...(blocksChanged ? { blocks: this.blocks.root() } : {}) }
        : wasBlocks ? { authoring: 'text' as const } : {}),
      description: formValue.description ? String(formValue.description).trim() : null,
      cooldown: Number(formValue.cooldown ?? 10),
      userLevel: Number(formValue.userLevel) || 1,
      userLevelName: USER_LEVELS[Number(formValue.userLevel) || 1],
      enabled: formValue.enabled !== false,
      channel: ''
    };

    if (this.accessMode() === 'level') {
      request.permissionExpression = null;
    } else if (this.accessDraft().editable) {
      request.permissionExpression = buildAccessExpression(this.accessDraft());
    }

    this.save.emit({
      command: request,
      timer: {
        enabled: timerEnabled,
        minutes: timerEnabled ? timerMinutes : null
      }
    });

    this.showUpgrade.set(false);
    this.blockErrorMessage.set(null);
    // Block saves wait for the server; the page closes the dialog or reports the error.
    if (!usesBlocks) setTimeout(() => this.isSaving.set(false), 500);
  }

  private setupForm(): void {
    this.accessSession += 1;
    this.tracking = false;
    const cmd = this.command();
    this.isEditMode.set(!!cmd);
    this.formError.set(null);
    this.modalTab.set('details');
    this.showUpgrade.set(false);
    this.convertError.set(null);
    this.confirmToText.set(false);
    this.blockErrorMessage.set(null);
    this.draftOffer.set(null);
    this.draftSaved.set(false);
    this.authoring.set(cmd?.authoring === 'blocks' ? 'blocks' : 'text');
    const storedRoot: RootNode | null = cmd?.authoring === 'blocks' ? rootFromStored(cmd.blocks) : null;
    this.blocks.load(storedRoot ?? emptyRoot());
    this.blocks.readOnly.set(cmd?.authoring === 'blocks' && !this.blocksAllowed());
    if (cmd?.authoring === 'blocks') this.modalTab.set('blocks');
    this.mobileAccessView.set('main');
    this.accountsOpen.set(false);
    this.lookupInput.set({ allow: '', exclude: '' });
    this.lookupError.set(null);
    this.lookupPending.set(null);

    const existingMinutes = this.existingTimerMinutes();
    const hasTimer = existingMinutes !== null && existingMinutes !== undefined && existingMinutes > 0;

    if (cmd) {
      const access = parseAccessDraft(cmd.permissionExpression);
      this.accessDraft.set(access);
      this.accessMode.set(cmd.permissionExpression == null ? 'level' : 'tags');
      this.commandForm.patchValue({
        name: cmd.name,
        cmd: cmd.cmd,
        message: cmd.message,
        description: cmd.description || '',
        cooldown: cmd.cooldown,
        userLevel: cmd.userLevel || 1,
        enabled: cmd.enabled,
        matchMode: cmd.keywordSettings?.matchMode ?? 'start',
        timerEnabled: hasTimer && !cmd.reserved,
        timerMinutes: hasTimer ? existingMinutes : this.defaultTimerMinutes()
      });

      if (cmd.reserved) {
        this.commandForm.get('cmd')?.disable({ emitEvent: false });
        this.commandForm.get('message')?.disable({ emitEvent: false });
        this.commandForm.get('timerEnabled')?.disable({ emitEvent: false });
        this.commandForm.get('timerMinutes')?.disable({ emitEvent: false });
      } else {
        this.commandForm.get('cmd')?.enable({ emitEvent: false });
        this.commandForm.get('message')?.enable({ emitEvent: false });
        this.commandForm.get('timerEnabled')?.enable({ emitEvent: false });
        this.commandForm.get('timerMinutes')?.enable({ emitEvent: false });
      }
    } else {
      this.selectedActivation.set(this.startAs());
      this.accessDraft.set(emptyAccessDraft());
      this.accessMode.set('level');
      this.commandForm.reset({
        name: '',
        cmd: '',
        message: '',
        description: '',
        cooldown: 10,
        userLevel: 1,
        enabled: true,
        matchMode: 'start',
        timerEnabled: false,
        timerMinutes: this.defaultTimerMinutes()
      });
      this.commandForm.enable({ emitEvent: false });
    }
    this.finishSetup();
  }

  /** After the form is filled in: offer (or, after checkout, apply) a saved draft, then start tracking. */
  private finishSetup(): void {
    const draft = this.channelID() ? readDraft(this.currentDraftKey()) : null;
    if (draft && this.resumeDraft()) this.applyDraft(draft);
    else if (draft) this.draftOffer.set(draft);
    this.tracking = true;
  }

  private defaultTimerMinutes(): number {
    return this.planTier() === 'free' ? 10 : 15;
  }

  private validateTimerMinutes(
    minutes: number,
    tier: PlanTier
  ): { valid: boolean; error?: string } {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      return { valid: false, error: this.t('commands.modal.timerInvalid') };
    }

    if (tier === 'pro') {
      if (minutes > 180) {
        return { valid: false, error: this.t('commands.modal.timerHintPro') };
      }
      return { valid: true };
    }

    if (tier === 'premium') {
      if (minutes < 5 || minutes > 180 || minutes % 5 !== 0) {
        return { valid: false, error: this.t('commands.modal.timerHintPremium') };
      }
      return { valid: true };
    }

    if (!FREE_INTERVALS.includes(minutes)) {
      return { valid: false, error: this.t('commands.modal.timerHintFree') };
    }
    return { valid: true };
  }
}
