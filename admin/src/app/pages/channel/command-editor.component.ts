import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';

import {
  COMMAND_USER_LEVELS,
  ChannelApiService,
  type ChannelCommand,
  type CommandWrite,
  type CommandWriteResponse,
} from '../../services/channel-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { IconComponent } from '../../shared/icon/icon.component';
import { formatNumber } from '../../shared/format';

export const REPLY_MAX = 10_000;
export const COOLDOWN_MAX = 86_400;
const NEW_COOLDOWN = 10;
/** The description old commands were saved with when nobody typed one. */
const EMPTY_DESCRIPTION = 'No description provided.';
const KEYWORD_MATCH: Record<string, string> = { start: 'starts with it', anywhere: 'contains it', exact: 'is exactly it' };
/** Old stored level names and labels → level, for rows saved before `userLevel` was sent. */
const LEGACY_LEVELS: Record<string, number> = {
  everyone: 1, subscriber: 2, subscribers: 2, sub: 2, subs: 2, tier1: 2, tier2: 3, tier3: 4, vip: 5, vips: 5, founder: 6, founders: 6,
  mod: 7, mods: 7, moderator: 7, moderators: 7, editor: 8, editors: 8, admin: 9, admins: 9, broadcaster: 10, streamer: 10,
};

/** "!lurk" for a command, the phrase for a keyword. Stored triggers have no "!" (older ones may). */
export function commandTrigger(cmd: Pick<ChannelCommand, 'cmd' | 'activation'>): string {
  const raw = cmd.cmd ?? '';
  return cmd.activation === 'keyword' ? raw : `!${raw.replace(/^!+/, '')}`;
}

/** How a toast or title names it: "!lurk" or "keyword “gg”". */
export function commandLabel(cmd: Pick<ChannelCommand, 'cmd' | 'activation'>): string {
  return cmd.activation === 'keyword' ? `keyword “${cmd.cmd}”` : commandTrigger(cmd);
}

/** The command's level (1–10), from `userLevel` or, on old rows, its stored name. */
export function commandLevel(cmd: Pick<ChannelCommand, 'userLevel' | 'userLevelName'>): number | null {
  const level = Number(cmd.userLevel);
  if (Number.isInteger(level) && level >= 1 && level <= 10) return level;
  return LEGACY_LEVELS[(cmd.userLevelName ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')] ?? null;
}

export interface CommandSaved {
  command: ChannelCommand;
  created: boolean;
}

interface FieldErrors {
  trigger?: string;
  reply?: string;
  cooldown?: string;
  name?: string;
}

let nextId = 0;

/**
 * Edit or create one of a channel's chat commands through the site's commands API (owner access).
 * Fields the API would refuse or ignore are locked with the reason; an edit sends only what changed.
 */
@Component({
  selector: 'app-command-editor',
  templateUrl: './command-editor.component.html',
  styleUrl: './command-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
})
export class CommandEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(ChannelApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly more = viewChild<ElementRef<HTMLDetailsElement>>('more');
  private readonly returnFocus = document.activeElement as HTMLElement | null;

  /** Null = a new command. */
  readonly command = input<ChannelCommand | null>(null);
  readonly channelID = input.required<string>();
  /** The channel login (sent as `channel` on create). */
  readonly login = input.required<string>();

  readonly saved = output<CommandSaved>();
  readonly closed = output<void>();

  readonly id = `ced-${++nextId}`;
  readonly levels = COMMAND_USER_LEVELS;
  readonly replyMax = REPLY_MAX;
  readonly formatNumber = formatNumber;

  readonly trigger = signal('');
  readonly reply = signal('');
  readonly level = signal(1);
  readonly cooldown = signal(String(NEW_COOLDOWN));
  readonly enabled = signal(true);
  readonly name = signal('');
  readonly description = signal('');
  private readonly initial = signal({ trigger: '', reply: '', level: 1, cooldown: String(NEW_COOLDOWN), enabled: true, name: '', description: '' });

  readonly submitAttempted = signal(false);
  readonly saving = signal(false);
  /** 409: the trigger is taken (shown under the trigger). */
  readonly triggerConflict = signal<string | null>(null);
  /** Any other server answer (shown above the footer). */
  readonly serverError = signal<string | null>(null);

  readonly isNew = computed(() => !this.command());
  readonly isKeyword = computed(() => this.command()?.activation === 'keyword');
  readonly isBuiltIn = computed(() => this.command()?.reserved === true);
  readonly isBlocks = computed(() => this.command()?.authoring === 'blocks');
  readonly permissionMode = computed(() => this.command()?.permissionMode ?? 'level');
  /** Not a built-in, but named after a built-in action (`func`), so chat runs that code and ignores the reply. */
  readonly runsBuiltIn = computed(() => !this.isBuiltIn() && this.command()?.runsBuiltIn === true);
  readonly replyLocked = computed(() => this.isBuiltIn() || this.isBlocks() || this.runsBuiltIn());
  readonly levelLocked = computed(() => this.permissionMode() !== 'level');

  readonly who = computed(() => this.login() || this.command()?.channel || '');
  readonly siteUrl = computed(() => (this.who() ? `https://domdimabot.com/${encodeURIComponent(this.who())}/commands` : 'https://domdimabot.com'));
  readonly title = computed(() => {
    const cmd = this.command();
    if (!cmd) return 'New command';
    return cmd.activation === 'keyword' ? `Edit keyword “${cmd.cmd}”` : `Edit ${commandTrigger(cmd)}`;
  });
  readonly keywordHint = computed(() => `Keyword · matches when a message ${KEYWORD_MATCH[this.command()?.keywordMatch ?? 'start'] ?? KEYWORD_MATCH['start']}`);
  readonly replyLength = computed(() => this.reply().trim().length);

  /** Something differs from what was loaded (only fields this dialog may send). */
  readonly dirty = computed(() => {
    const init = this.initial();
    return (
      (!this.isBuiltIn() && this.normTrigger(this.trigger()) !== this.normTrigger(init.trigger)) ||
      (!this.replyLocked() && this.reply().trim() !== init.reply.trim()) ||
      (!this.levelLocked() && this.level() !== init.level) ||
      this.cooldown().trim() !== init.cooldown ||
      this.enabled() !== init.enabled ||
      this.name().trim() !== init.name.trim() ||
      (!this.isBuiltIn() && this.description().trim() !== init.description.trim())
    );
  });
  readonly canSave = computed(() => !this.saving() && (this.isNew() || this.dirty()));

  readonly errors = computed<FieldErrors>(() => {
    const errors: FieldErrors = {};
    if (!this.isBuiltIn()) {
      const trigger = this.normTrigger(this.trigger());
      if (!trigger) errors.trigger = this.isKeyword() ? 'Type the keyword.' : 'Type the trigger viewers use in chat.';
      else if (!this.isKeyword() && /\s/.test(trigger)) errors.trigger = 'No spaces: a command is one word.';
      // Chat only matches letters and numbers after "!" (`commandsRegex` in the bot): "my_cmd" would run "!my".
      // Checked when the trigger is new or changed, so an old trigger doesn't block other edits.
      else if (!this.isKeyword() && (this.isNew() || trigger !== this.normTrigger(this.initial().trigger)) && !/^[\p{L}\p{N}]+$/u.test(trigger)) {
        errors.trigger = 'Letters and numbers only: chat stops reading the trigger at the first symbol.';
      }
    }
    if (!this.replyLocked()) {
      const length = this.replyLength();
      if (!length) errors.reply = 'Type what the bot replies.';
      else if (length > REPLY_MAX) errors.reply = `The reply is too long (${formatNumber(length)} of ${formatNumber(REPLY_MAX)} characters).`;
    }
    const cooldown = this.cooldown().trim();
    if (!/^\d+$/.test(cooldown) || Number(cooldown) > COOLDOWN_MAX) errors.cooldown = 'Use whole seconds from 0 to 86,400 (24 hours).';
    if (!this.isNew() && this.initial().name.trim() && !this.name().trim()) errors.name = "The name can't be empty.";
    return errors;
  });
  /** Errors on screen: field checks after the first submit, plus a taken trigger. */
  readonly shown = computed<FieldErrors>(() => {
    const errors = this.submitAttempted() ? { ...this.errors() } : {};
    if (!errors.trigger && this.triggerConflict()) errors.trigger = this.triggerConflict()!;
    return errors;
  });

  ngOnInit(): void {
    const cmd = this.command();
    const description = cmd?.description?.trim() === EMPTY_DESCRIPTION ? '' : (cmd?.description ?? '');
    const initial = cmd
      ? {
          trigger: cmd.activation === 'keyword' ? (cmd.cmd ?? '') : (cmd.cmd ?? '').replace(/^!+/, ''),
          reply: cmd.message ?? '',
          level: commandLevel(cmd) ?? 1,
          cooldown: String(Number.isFinite(Number(cmd.cooldown)) ? Number(cmd.cooldown) : NEW_COOLDOWN),
          enabled: cmd.enabled !== false,
          name: cmd.name ?? '',
          description,
        }
      : this.initial();
    this.initial.set(initial);
    this.trigger.set(initial.trigger);
    this.reply.set(initial.reply);
    this.level.set(initial.level);
    this.cooldown.set(initial.cooldown);
    this.enabled.set(initial.enabled);
    this.name.set(initial.name);
    this.description.set(initial.description);
  }

  ngAfterViewInit(): void {
    this.dialog().nativeElement.showModal();
  }

  ngOnDestroy(): void {
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  onTrigger(event: Event): void {
    this.trigger.set(this.value(event));
    this.triggerConflict.set(null);
  }

  /** Escape, Cancel and the close button; ignored while saving. */
  requestClose(event?: Event): void {
    event?.preventDefault();
    if (this.saving()) return;
    const dialog = this.dialog().nativeElement;
    if (dialog.open) dialog.close();
  }

  /** The native dialog closed. A second Escape can force it shut while saving: keep it open until the answer. */
  onClosed(): void {
    if (this.saving()) {
      this.dialog().nativeElement.showModal();
      return;
    }
    this.closed.emit();
  }

  save(event?: Event): void {
    event?.preventDefault();
    if (this.saving()) return;
    this.submitAttempted.set(true);
    this.serverError.set(null);
    if (Object.keys(this.errors()).length) {
      this.focusFirstInvalid();
      return;
    }
    const cmd = this.command();
    if (cmd && !this.dirty()) return;
    const channelID = this.channelID();
    const created = !cmd;
    let body: CommandWrite;
    let request: Observable<CommandWriteResponse>;
    if (cmd) {
      body = this.updateBody();
      request = this.api.updateCommand(channelID, cmd.id, body);
    } else {
      const create = this.createBody();
      body = create;
      request = this.api.createCommand(channelID, create);
    }
    this.saving.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (response?.error) {
          this.fail(response.status, response.message);
          return;
        }
        this.saving.set(false);
        this.saved.emit({ command: this.result(body, response), created });
        this.requestClose();
      },
      error: (error: unknown) => this.fail(error instanceof HttpErrorResponse ? error.status : 0, apiErrorMessage(error, '')),
    });
  }

  /** What a field's aria-describedby points at: its hint (when it has one) and its error (when shown). */
  describedBy(field: keyof FieldErrors, hint = true): string | null {
    const ids = [hint ? `${this.id}-${field}-hint` : '', this.shown()[field] ? `${this.id}-${field}-error` : ''].filter(Boolean);
    return ids.length ? ids.join(' ') : null;
  }

  private normTrigger(value: string): string {
    if (this.isKeyword()) return value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
    return value.trim().replace(/^!+/, '');
  }

  private levelName(level: number): string {
    return COMMAND_USER_LEVELS.find((item) => item.level === level)?.name ?? 'everyone';
  }

  private createBody(): CommandWrite & { name: string; cmd: string; func: string; message: string; channel: string } {
    const cmd = this.normTrigger(this.trigger());
    const description = this.description().trim();
    return {
      name: this.name().trim() || cmd,
      cmd,
      // A plain text reply. The trigger is not used as the function: a name like "promo" would run the bot's
      // built-in promo code instead of this reply (the bot dispatches on `func`).
      func: 'custom',
      message: this.reply().trim(),
      channel: this.login(),
      cooldown: Number(this.cooldown().trim()),
      enabled: this.enabled(),
      userLevel: this.level(),
      userLevelName: this.levelName(this.level()),
      ...(description ? { description } : {}),
    };
  }

  /** Only the changed fields, and never one the API would ignore for this command. */
  private updateBody(): CommandWrite {
    const init = this.initial();
    const body: CommandWrite = {};
    const trigger = this.normTrigger(this.trigger());
    if (!this.isBuiltIn() && trigger !== this.normTrigger(init.trigger)) body.cmd = trigger;
    if (!this.replyLocked() && this.reply().trim() !== init.reply.trim()) body.message = this.reply().trim();
    if (!this.levelLocked() && this.level() !== init.level) {
      body.userLevel = this.level();
      body.userLevelName = this.levelName(this.level());
    }
    if (this.cooldown().trim() !== init.cooldown) body.cooldown = Number(this.cooldown().trim());
    if (this.enabled() !== init.enabled) body.enabled = this.enabled();
    if (this.name().trim() !== init.name.trim()) body.name = this.name().trim();
    if (!this.isBuiltIn() && this.description().trim() !== init.description.trim()) body.description = this.description().trim();
    return body;
  }

  /** The command as it now is: the old row with what was sent, or the new one the API returned. */
  private result(body: CommandWrite, response: CommandWriteResponse | null): ChannelCommand {
    const raw = (response?.command ?? {}) as Record<string, unknown>;
    const text = (key: string, fallback: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : fallback);
    const old = this.command();
    if (old) {
      const next: ChannelCommand = { ...old };
      if (body.cmd !== undefined) next.cmd = text('cmd', body.cmd);
      if (body.message !== undefined) next.message = body.message;
      if (body.userLevel !== undefined) {
        next.userLevel = body.userLevel;
        next.userLevelName = body.userLevelName ?? this.levelName(body.userLevel);
      }
      if (body.cooldown !== undefined) next.cooldown = body.cooldown;
      if (body.enabled !== undefined) next.enabled = body.enabled;
      if (body.name !== undefined) next.name = body.name;
      if (body.description !== undefined) next.description = body.description;
      return next;
    }
    return {
      id: String(raw['_id'] ?? raw['id'] ?? ''),
      name: text('name', body.name ?? ''),
      cmd: text('cmd', body.cmd ?? ''),
      func: text('func', body.func ?? ''),
      message: body.message ?? '',
      enabled: typeof raw['enabled'] === 'boolean' ? (raw['enabled'] as boolean) : body.enabled !== false,
      cooldown: Number(raw['cooldown'] ?? body.cooldown ?? NEW_COOLDOWN),
      userLevelName: text('userLevelName', body.userLevelName ?? 'everyone'),
      userLevel: Number(raw['userLevel'] ?? body.userLevel ?? 1),
      activation: 'command',
      keywordMatch: null,
      reserved: false,
      authoring: 'text',
      permissionMode: 'level',
      description: body.description ?? '',
      channel: body.channel ?? this.login(),
      createdAt: new Date().toISOString(),
    };
  }

  private fail(status: number, message: string): void {
    this.saving.set(false);
    if (status === 409) {
      const trigger = this.normTrigger(this.trigger());
      this.triggerConflict.set(this.isKeyword() ? `Another keyword already uses “${trigger}”.` : `Another command already uses !${trigger}.`);
      this.focusFirstInvalid();
      return;
    }
    this.serverError.set(message || "Couldn't save the command. Try again.");
  }

  private focusFirstInvalid(): void {
    afterNextRender(
      () => {
        const field = this.dialog().nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]');
        if (!field) return;
        const more = this.more()?.nativeElement;
        if (more?.contains(field)) more.open = true;
        field.focus();
      },
      { injector: this.injector },
    );
  }
}
