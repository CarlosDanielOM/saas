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
  type OwnerWriteResponse,
} from '../../services/channel-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { IconComponent } from '../../shared/icon/icon.component';
import { formatNumber } from '../../shared/format';

export const REPLY_MAX = 10_000;
export const COOLDOWN_MAX = 86_400;
const NEW_COOLDOWN = 10;
/** The description old commands were saved with when nobody typed one. */
const EMPTY_DESCRIPTION = 'No description provided.';
/** The function of a plain reply (what a new command runs). */
const PLAIN = 'custom';
type MatchMode = 'start' | 'anywhere' | 'exact';
type Activation = 'command' | 'keyword';
const MATCH_MODES: ReadonlyArray<{ value: MatchMode; label: string; hint: string }> = [
  { value: 'start', label: 'Starts with', hint: 'A message matches when it starts with the keyword.' },
  { value: 'anywhere', label: 'Contains', hint: 'A message matches when the keyword appears anywhere in it.' },
  { value: 'exact', label: 'Is exactly', hint: 'A message matches only when it is the keyword and nothing else.' },
];
/** What chat accepts as a keyword (`validateKeyword` in the bot): words with single spaces, 60 characters at most. */
const KEYWORD_PATTERN = /^[\p{L}\p{N}\p{M}_]+(?: [\p{L}\p{N}\p{M}_]+)*$/u;
const KEYWORD_MAX = 60;
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
  blocks?: string;
  rule?: string;
}

/** A JSON field: empty, parsed, or why it doesn't parse. */
type Parsed = { empty: true } | { empty: false; value: unknown } | { empty: false; error: string };

function parseJson(text: string): Parsed {
  if (!text.trim()) return { empty: true };
  try {
    return { empty: false, value: JSON.parse(text) };
  } catch (error) {
    return { empty: false, error: error instanceof Error ? error.message : 'invalid JSON' };
  }
}

const pretty = (value: unknown): string => (value === null || value === undefined ? '' : JSON.stringify(value, null, 2));

/**
 * The block tree as a write takes it (`{ type: 'root', children }`). Rows carry the stored `{ v, root }` wrapper,
 * which the server's compiler refuses, so it's shown and sent as its root (a pasted wrapper too).
 */
function blockRoot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const stored = value as Record<string, unknown>;
  return stored['type'] === undefined && stored['root'] && typeof stored['root'] === 'object' ? stored['root'] : value;
}

let nextId = 0;

/**
 * Edit or create one of a channel's chat commands through the owner routes (`/admin-site/users/:id/commands`),
 * which edit like the database: built-in commands, blocks, custom rules, keywords and cooldowns are all editable.
 * Only facts are checked here (chat can't read the trigger, JSON doesn't parse); the server answers the rest.
 * An edit sends only what changed.
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
  /** Function names whose built-in code runs instead of a reply (the list's `meta.builtInActions`). */
  readonly builtInActions = input<readonly string[]>([]);

  readonly saved = output<CommandSaved>();
  readonly closed = output<void>();

  readonly id = `ced-${++nextId}`;
  readonly levels = COMMAND_USER_LEVELS;
  readonly matchModes = MATCH_MODES;
  readonly replyMax = REPLY_MAX;
  readonly formatNumber = formatNumber;

  readonly trigger = signal('');
  readonly activation = signal<Activation>('command');
  readonly matchMode = signal<MatchMode>('start');
  readonly reply = signal('');
  readonly func = signal(PLAIN);
  readonly blocksText = signal('');
  /** Which reply field was edited last: the text (plain reply) or the blocks JSON. */
  readonly source = signal<'text' | 'blocks'>('text');
  readonly level = signal(1);
  /** Who can use it comes from the custom rule (JSON) instead of the level. */
  readonly useRule = signal(false);
  readonly ruleText = signal('');
  readonly cooldown = signal(String(NEW_COOLDOWN));
  readonly enabled = signal(true);
  readonly name = signal('');
  readonly description = signal('');
  private readonly initial = signal({
    trigger: '', activation: 'command' as Activation, matchMode: 'start' as MatchMode, reply: '', authoring: 'text' as 'text' | 'blocks',
    func: PLAIN, blocksText: '', level: 1, useRule: false, ruleBroken: false, ruleText: '', cooldown: String(NEW_COOLDOWN),
    enabled: true, name: '', description: '',
  });

  readonly submitAttempted = signal(false);
  readonly saving = signal(false);
  /** The server refused the trigger (409 taken, or 400 chat can't type it): shown under the trigger. */
  readonly triggerConflict = signal<string | null>(null);
  /** Any other server answer (shown above the footer). */
  readonly serverError = signal<string | null>(null);

  readonly isNew = computed(() => !this.command());
  /** The type as chosen now (More options › Type). */
  readonly isKeyword = computed(() => this.activation() === 'keyword');
  readonly wasBlocks = computed(() => this.initial().authoring === 'blocks');
  readonly typeChanged = computed(() => !this.isNew() && this.activation() !== this.initial().activation);
  readonly triggerChanged = computed(
    () => this.isNew() || this.typeChanged() || this.normTrigger(this.trigger()) !== this.normTrigger(this.initial().trigger),
  );

  readonly who = computed(() => this.login() || this.command()?.channel || '');
  readonly title = computed(() => {
    const cmd = this.command();
    if (!cmd) return 'New command';
    return cmd.activation === 'keyword' ? `Edit keyword “${cmd.cmd}”` : `Edit ${commandTrigger(cmd)}`;
  });
  readonly matchHint = computed(() => MATCH_MODES.find((mode) => mode.value === this.matchMode())?.hint ?? '');
  readonly replyLength = computed(() => this.reply().trim().length);

  /** The stored function when it's neither a plain reply nor a listed built-in action (kept as an option). */
  readonly extraFunc = computed(() => {
    const func = this.initial().func;
    return func === PLAIN || this.builtInActions().includes(func) ? null : func;
  });
  /** Chat runs the bot's own code for this command, so the reply isn't posted. Keywords always post their reply. */
  readonly runsBuiltIn = computed(() => {
    if (this.isKeyword()) return false;
    const func = this.func();
    const cmd = this.command();
    if (cmd && cmd.activation !== 'keyword' && func === this.initial().func && typeof cmd.runsBuiltIn === 'boolean') return cmd.runsBuiltIn;
    return this.builtInActions().includes(func);
  });

  readonly blocksParsed = computed(() => parseJson(this.blocksText()));
  readonly ruleParsed = computed(() => parseJson(this.ruleText()));
  readonly blocksEdited = computed(() => this.blocksText().trim() !== this.initial().blocksText.trim());
  readonly ruleEdited = computed(() => this.ruleText().trim() !== this.initial().ruleText.trim());

  /** What Save writes for the reply: nothing, the text as a plain reply, or the blocks JSON. */
  readonly replyPlan = computed<'none' | 'text' | 'blocks'>(() => {
    const init = this.initial();
    const replyEdited = this.reply().trim() !== init.reply.trim();
    if (this.source() === 'blocks' && this.blocksEdited() && this.blocksText().trim()) return 'blocks';
    if (this.wasBlocks()) return (this.source() === 'text' && replyEdited) || !this.blocksText().trim() ? 'text' : 'none';
    return replyEdited ? 'text' : 'none';
  });
  /** The note under the reply about what Save does with the blocks. */
  readonly replyNote = computed<'to-text' | 'blocks' | null>(() => {
    const plan = this.replyPlan();
    if (plan === 'blocks') return 'blocks';
    return plan === 'text' && this.wasBlocks() ? 'to-text' : null;
  });
  readonly blocksHint = computed(() => {
    if (this.source() === 'text' && this.blocksEdited() && this.blocksText().trim()) {
      return 'Not used: the reply was edited after this. Edit the blocks again to save them.';
    }
    return this.wasBlocks()
      ? 'The blocks behind the reply. The server compiles them when you save. Clear it to keep the reply as plain text.'
      : 'Paste a block tree to turn it into a block command.';
  });

  /** What Save writes for who can use it. */
  readonly permissionPlan = computed<'none' | 'level' | 'to-level' | 'rule'>(() => {
    const init = this.initial();
    if (this.useRule()) return !init.useRule || this.ruleEdited() ? 'rule' : 'none';
    if (init.useRule) return 'to-level';
    return this.level() !== init.level ? 'level' : 'none';
  });
  /** The rule option in "Who can use it": the command has one, or one was typed. */
  readonly ruleOption = computed(() => this.initial().useRule || !!this.ruleText().trim());
  readonly ruleBroken = computed(() => this.initial().ruleBroken && !this.ruleEdited());
  readonly levelNote = computed(() => {
    if (this.useRule()) {
      return this.ruleBroken()
        ? 'The stored rule is broken: chat blocks every use. Fix it in More options › Custom rule (JSON), or pick a level.'
        : 'Set in More options › Custom rule (JSON).';
    }
    return this.initial().useRule ? 'Saving drops the custom rule and uses this level.' : null;
  });
  readonly ruleHint = computed(() => {
    if (!this.useRule() && this.ruleText().trim()) return 'Not used: a level is picked under Who can use it. Edit the rule again to use it.';
    return this.initial().useRule
      ? 'Who can use it, as a rule. Clear it or pick a level to use levels instead.'
      : 'Paste a rule to use it instead of the level, like {"role": "vip"}.';
  });

  /** What Save sends for an edit: only what changed. Unparsed JSON stays text here (validation stops it). */
  readonly changes = computed<CommandWrite>(() => {
    const cmd = this.command();
    const init = this.initial();
    const body: CommandWrite = {};
    if (!cmd) return body;
    const keyword = this.isKeyword();
    const trigger = this.normTrigger(this.trigger());
    if (this.typeChanged() ? trigger !== (cmd.cmd ?? '') : trigger !== this.normTrigger(init.trigger)) body.cmd = trigger;
    if (this.typeChanged()) body.activation = this.activation();
    if (keyword && (this.typeChanged() || this.matchMode() !== init.matchMode)) body.keywordSettings = { matchMode: this.matchMode() };
    if (!keyword && this.func() !== init.func) body.func = this.func();
    Object.assign(body, this.replyFields());
    Object.assign(body, this.permissionFields());
    if (this.cooldown().trim() !== init.cooldown) body.cooldown = Number(this.cooldown().trim());
    if (this.enabled() !== init.enabled) body.enabled = this.enabled();
    if (this.name().trim() !== init.name.trim()) body.name = this.name().trim();
    if (this.description().trim() !== init.description.trim()) body.description = this.description().trim();
    return body;
  });
  readonly dirty = computed(() => Object.keys(this.changes()).length > 0);
  readonly canSave = computed(() => !this.saving() && (this.isNew() || this.dirty()));

  readonly errors = computed<FieldErrors>(() => {
    const errors: FieldErrors = {};
    const keyword = this.isKeyword();
    const trigger = this.normTrigger(this.trigger());
    // Format checks run when the trigger is new or changed, so an old trigger never blocks other edits.
    const changed = this.triggerChanged();
    if (!trigger) errors.trigger = keyword ? 'Type the keyword.' : 'Type the trigger viewers use in chat.';
    else if (changed && !keyword && /\s/.test(trigger)) errors.trigger = 'No spaces: a command is one word.';
    // Chat only matches letters and numbers after "!" (`commandsRegex` in the bot): "my_cmd" would run "!my".
    else if (changed && !keyword && !/^[\p{L}\p{N}]+$/u.test(trigger)) {
      errors.trigger = 'Letters and numbers only: chat stops reading the trigger at the first symbol.';
    } else if (changed && keyword && (trigger.length > KEYWORD_MAX || !KEYWORD_PATTERN.test(trigger))) {
      errors.trigger = 'Words with single spaces only, up to 60 characters: no “!” or other symbols.';
    }

    const plan = this.replyPlan();
    const length = this.replyLength();
    if (plan === 'text' || (this.isNew() && plan === 'none')) {
      if (length > REPLY_MAX) errors.reply = `The reply is too long (${formatNumber(length)} of ${formatNumber(REPLY_MAX)} characters).`;
      // A block command needs text to become a plain reply; a plain reply that chat posts needs something to post.
      else if (!length && (this.wasBlocks() || !this.runsBuiltIn())) errors.reply = 'Type what the bot replies.';
    }
    if (plan === 'blocks') {
      const parsed = this.blocksParsed();
      if ('error' in parsed) errors.blocks = `This isn't valid JSON: ${parsed.error}`;
    }
    if (this.permissionPlan() === 'rule') {
      const parsed = this.ruleParsed();
      if (parsed.empty) errors.rule = 'Type the rule as JSON, or pick a level under Who can use it.';
      else if ('error' in parsed) errors.rule = `This isn't valid JSON: ${parsed.error}`;
      else if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) errors.rule = 'A rule is a JSON object, like {"role": "vip"}.';
    }
    const cooldown = this.cooldown().trim();
    if (!/^\d+$/.test(cooldown) || Number(cooldown) > COOLDOWN_MAX) errors.cooldown = 'Use whole seconds from 0 to 86,400 (24 hours).';
    if (!this.isNew() && this.initial().name.trim() && !this.name().trim()) errors.name = "The name can't be empty.";
    return errors;
  });
  /**
   * Errors on screen: field checks after the first submit, plus the server's answer about the trigger. A switched
   * type checks the trigger right away (a keyword phrase needs a one-word trigger to become a command).
   */
  readonly shown = computed<FieldErrors>(() => {
    const errors = this.submitAttempted() ? { ...this.errors() } : {};
    if (!errors.trigger && this.typeChanged() && this.errors().trigger) errors.trigger = this.errors().trigger;
    if (!errors.trigger && this.triggerConflict()) errors.trigger = this.triggerConflict()!;
    return errors;
  });
  /** The owner saved this cooldown here, so chat uses it as stored. */
  readonly cooldownSetHere = computed(() => this.command()?.cooldownOverride === true);
  /** The reply's descriptions: count, error and the notes under it. */
  readonly replyDescribedBy = computed(() => {
    const ids = [`${this.id}-reply-hint`];
    if (this.shown().reply) ids.push(`${this.id}-reply-error`);
    if (this.wasBlocks()) ids.push(`${this.id}-reply-built`);
    if (this.replyNote()) ids.push(`${this.id}-reply-note`);
    if (this.runsBuiltIn()) ids.push(`${this.id}-reply-runs`);
    return ids.join(' ');
  });

  ngOnInit(): void {
    const cmd = this.command();
    if (cmd) {
      const keyword = cmd.activation === 'keyword';
      const mode = cmd.keywordMatch;
      const useRule = cmd.permissionMode === 'tags' || cmd.permissionMode === 'invalid';
      this.initial.set({
        trigger: keyword ? (cmd.cmd ?? '') : (cmd.cmd ?? '').replace(/^!+/, ''),
        activation: keyword ? 'keyword' : 'command',
        matchMode: mode === 'anywhere' || mode === 'exact' ? mode : 'start',
        reply: cmd.message ?? '',
        authoring: cmd.authoring === 'blocks' ? 'blocks' : 'text',
        func: cmd.func ?? '',
        blocksText: cmd.authoring === 'blocks' ? pretty(blockRoot(cmd.blocks)) : '',
        level: commandLevel(cmd) ?? 1,
        useRule,
        ruleBroken: cmd.permissionMode === 'invalid',
        ruleText: useRule ? pretty(cmd.permissionExpression) : '',
        cooldown: String(Number.isFinite(Number(cmd.cooldown)) ? Number(cmd.cooldown) : NEW_COOLDOWN),
        enabled: cmd.enabled !== false,
        name: cmd.name ?? '',
        description: cmd.description?.trim() === EMPTY_DESCRIPTION ? '' : (cmd.description ?? ''),
      });
    }
    const init = this.initial();
    this.trigger.set(init.trigger);
    this.activation.set(init.activation);
    this.matchMode.set(init.matchMode);
    this.reply.set(init.reply);
    this.func.set(init.func);
    this.blocksText.set(init.blocksText);
    this.source.set(init.authoring === 'blocks' ? 'blocks' : 'text');
    this.level.set(init.level);
    this.useRule.set(init.useRule);
    this.ruleText.set(init.ruleText);
    this.cooldown.set(init.cooldown);
    this.enabled.set(init.enabled);
    this.name.set(init.name);
    this.description.set(init.description);
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

  onActivation(event: Event): void {
    this.activation.set(this.value(event) === 'keyword' ? 'keyword' : 'command');
    this.triggerConflict.set(null);
  }

  onMatch(event: Event): void {
    const value = this.value(event);
    this.matchMode.set(value === 'anywhere' || value === 'exact' ? value : 'start');
  }

  onReply(event: Event): void {
    this.reply.set(this.value(event));
    this.source.set('text');
  }

  onBlocks(event: Event): void {
    const text = this.value(event);
    this.blocksText.set(text);
    this.source.set(text.trim() ? 'blocks' : 'text');
  }

  /** A level switches a custom-rule command to level mode; "Custom rule" goes back to the rule. */
  onLevel(event: Event): void {
    const value = this.value(event);
    if (value === 'rule') {
      this.useRule.set(true);
      return;
    }
    this.level.set(Number(value));
    this.useRule.set(false);
  }

  onRule(event: Event): void {
    const text = this.value(event);
    this.ruleText.set(text);
    this.useRule.set(!!text.trim());
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
    const request: Observable<OwnerWriteResponse<ChannelCommand>> = cmd
      ? this.api.ownerUpdateCommand(channelID, cmd.id, this.changes())
      : this.api.ownerCreateCommand(channelID, this.createBody());
    this.triggerConflict.set(null);
    this.saving.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (response?.error) {
          this.fail(response.status, response.message);
          return;
        }
        this.saving.set(false);
        this.saved.emit({ command: this.result(response?.data), created });
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

  /** The reply as Save writes it: a plain text (replacing blocks when there were some) or the blocks JSON. */
  private replyFields(): CommandWrite {
    const plan = this.replyPlan();
    if (plan === 'blocks') {
      const parsed = this.blocksParsed();
      return { authoring: 'blocks', blocks: 'value' in parsed ? blockRoot(parsed.value) : this.blocksText() };
    }
    if (plan === 'text') return this.wasBlocks() ? { authoring: 'text', message: this.reply().trim() } : { message: this.reply().trim() };
    return {};
  }

  /** Who can use it as Save writes it: a level, a switch from the rule to a level, or the rule JSON. */
  private permissionFields(): CommandWrite {
    const plan = this.permissionPlan();
    const level = { userLevel: this.level(), userLevelName: this.levelName(this.level()) };
    if (plan === 'level') return level;
    if (plan === 'to-level') return { permissionExpression: null, ...level };
    if (plan === 'rule') {
      const parsed = this.ruleParsed();
      return { permissionExpression: 'value' in parsed ? parsed.value : this.ruleText() };
    }
    return {};
  }

  private createBody(): CommandWrite & { cmd: string } {
    const cmd = this.normTrigger(this.trigger());
    const keyword = this.isKeyword();
    const description = this.description().trim();
    const reply = this.replyFields();
    const rule = this.permissionPlan() === 'rule' ? this.permissionFields() : {};
    return {
      name: this.name().trim() || cmd,
      cmd,
      // A plain text reply by default. The trigger is never used as the function: a name like "promo" would run
      // the bot's built-in promo code instead of this reply (the bot dispatches on `func`).
      func: keyword ? PLAIN : this.func(),
      ...(reply.authoring === 'blocks' ? reply : { message: this.reply().trim() }),
      channel: this.login(),
      cooldown: Number(this.cooldown().trim()),
      enabled: this.enabled(),
      userLevel: this.level(),
      userLevelName: this.levelName(this.level()),
      ...rule,
      ...(keyword ? { activation: 'keyword' as const, keywordSettings: { matchMode: this.matchMode() } } : {}),
      ...(description ? { description } : {}),
    };
  }

  /** The saved row as the owner route returns it (the list's shape); the old row when an answer has none. */
  private result(data: ChannelCommand | null | undefined): ChannelCommand {
    if (data && typeof data === 'object' && typeof data.id === 'string' && data.id) return data;
    // No row in the answer (an older API): the list reloads a new command without an id.
    const base: ChannelCommand = this.command() ?? {
      id: '', name: '', cmd: '', func: PLAIN, message: '', enabled: true, cooldown: NEW_COOLDOWN, userLevelName: 'everyone', userLevel: 1,
      activation: 'command', keywordMatch: null, reserved: false, authoring: 'text', permissionMode: 'level', description: '', channel: this.login(),
    };
    return {
      ...base,
      name: this.name().trim() || this.normTrigger(this.trigger()),
      cmd: this.normTrigger(this.trigger()),
      activation: this.activation(),
      message: this.reply().trim(),
      enabled: this.enabled(),
      cooldown: Number(this.cooldown().trim()),
      userLevel: this.level(),
      userLevelName: this.levelName(this.level()),
      description: this.description().trim(),
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
    // A trigger chat can't match (e.g. a keyword phrase switched to a command): the server's words, under the trigger.
    if (status === 400 && /can't be typed as a chat command/i.test(message)) {
      this.triggerConflict.set(message);
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
