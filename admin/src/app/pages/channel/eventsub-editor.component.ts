import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  ChannelApiService,
  EDITABLE_EVENTSUB_FIELDS,
  EVENTSUB_SETTING_LABELS,
  chatEventFieldKey,
  type ChannelEventsub,
  type ChatEventControl,
  type ChatEventDefinition,
  type EventsubSettings,
} from '../../services/channel-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { IconComponent } from '../../shared/icon/icon.component';
import { BitsRulesEditorComponent } from './bits-rules-editor.component';

/** Watch streaks and mod anniversaries: an empty message means the default one in the streamer's language. */
export const CHAT_NOTIFICATION_TYPE = 'channel.chat.notification';
/** Twitch doesn't post chat messages longer than this: the editor warns, it doesn't stop the save. */
export const MESSAGE_MAX = 500;
/** The owner route's own limit for a stored text (`dimabot/src/server/routes/admin_site/channel_edit.route.ts`). */
const TEXT_MAX = 10_000;
/** The owner route's limit for a stored number. */
const NUMBER_MAX = 1_000_000;
const BITS_TYPE = 'channel.bits.use';

/** The control type of every stored setting, for the "All stored settings" section (the owner route checks the same types). */
const SETTING_KINDS: Record<keyof EventsubSettings, 'text' | 'number' | 'checkbox'> = {
  message: 'text',
  endMessage: 'text',
  endEnabled: 'checkbox',
  minViewers: 'number',
  clipEnabled: 'checkbox',
  delay: 'number',
  modiversaryMessage: 'text',
  modiversaryEnabled: 'checkbox',
  watchStreakEnabled: 'checkbox',
  temporalBanMessage: 'text',
  todayFollows: 'checkbox',
};

/** The control whose text the bot posts for this event: the one saved as `message`, else the first text control. */
export function messageControl(definition: ChatEventDefinition | null | undefined): ChatEventControl | null {
  const controls = (definition?.config ?? []).filter((control) => control.type === 'text');
  return controls.find((control) => chatEventFieldKey(control) === 'message') ?? controls[0] ?? null;
}

/** English label of a catalog control (the admin is English-only). */
export function controlLabel(control: Pick<ChatEventControl, 'id' | 'label'>): string {
  return control.label?.EN || control.label?.en || control.id;
}

type FieldKind = 'text' | 'number' | 'checkbox' | 'select' | 'bits';

interface EditorField {
  /** The catalog control id (what `showIf` refers to), or `stored-<key>` for a stored setting. */
  id: string;
  /** The stored field it is saved to. */
  key: string;
  kind: FieldKind;
  label: string;
  /** The catalog control; null for a field of "All stored settings". */
  control: ChatEventControl | null;
  /** The stored value, typed for its kind. */
  original: unknown;
  options: { value: string; label: string }[];
}

@Component({
  selector: 'app-eventsub-editor',
  templateUrl: './eventsub-editor.component.html',
  styleUrl: './eventsub-editor.component.css',
  imports: [IconComponent, NgTemplateOutlet, BitsRulesEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EventsubEditorComponent implements AfterViewInit {
  private readonly channelApi = inject(ChannelApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly bitsRules = viewChild(BitsRulesEditorComponent);

  readonly eventsub = input.required<ChannelEventsub>();
  readonly definition = input.required<ChatEventDefinition>();
  readonly eventName = input.required<string>();
  readonly channelID = input.required<string>();
  readonly channelLogin = input<string | null>(null);
  /** A second stored row of the event that the bot doesn't read. */
  readonly duplicate = input(false);
  /** The chat event catalog didn't load, so only the stored fields can be shown. */
  readonly catalogMissing = input(false);

  readonly saved = output<void>();
  readonly closed = output<void>();

  protected readonly max = MESSAGE_MAX;
  protected readonly textMax = TEXT_MAX;
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);
  protected readonly serverError = signal<string | null>(null);
  /** Edited values by field id; a field without an entry still has its stored value. */
  private readonly edits = signal<Record<string, unknown>>({});

  protected readonly login = computed(() => this.channelLogin() || this.channelID());
  private readonly isNotification = computed(() => this.eventsub().type === CHAT_NOTIFICATION_TYPE);
  /** Saving here, or a Bits rule write on its way: the dialog waits before closing. */
  protected readonly busy = computed(() => this.saving() || (this.bitsRules()?.busy() ?? false));

  /** The type's catalog controls in catalog order, each with its stored value. */
  protected readonly fields = computed<EditorField[]>(() => {
    const es = this.eventsub();
    const settings = this.settings();
    const seen = new Set<string>();
    const fields: EditorField[] = [];
    for (const control of this.definition().config ?? []) {
      const key = chatEventFieldKey(control);
      if (seen.has(key)) continue;
      seen.add(key);
      const kind: FieldKind =
        control.type === 'message-tiers' || key === 'cheerTiers'
          ? 'bits'
          : ['text', 'number', 'checkbox', 'select'].includes(control.type)
            ? (control.type as FieldKind)
            : (SETTING_KINDS[key as keyof EventsubSettings] ?? kindOf(settings[key]));
      const stored = key in settings ? settings[key] : key === 'message' && es.message !== undefined ? es.message : control.value;
      fields.push({ id: control.id, key, kind, label: controlLabel(control), control, original: typed(kind, stored), options: selectOptions(control, stored) });
    }
    return fields;
  });

  /** Every other stored setting (the ones no catalog control shows), with its plain name and stored field name. */
  protected readonly storedFields = computed<EditorField[]>(() => {
    const settings = this.settings();
    const shown = new Set(this.fields().map((field) => field.key));
    return EDITABLE_EVENTSUB_FIELDS.filter((key) => !shown.has(key)).map((key) => {
      const kind = SETTING_KINDS[key] ?? kindOf(settings[key]);
      return { id: `stored-${key}`, key, kind, label: EVENTSUB_SETTING_LABELS[key] ?? key, control: null, original: typed(kind, settings[key]), options: [] };
    });
  });

  /** No catalog controls for this type: the dialog is its stored fields, open from the start. */
  protected readonly storedOnly = computed(() => this.fields().length === 0);

  /** The Bits rules sit where the catalog puts them; a Bits row without that control gets them after its settings. */
  protected readonly bitsAfterFields = computed(
    () => !this.duplicate() && this.eventsub().type === BITS_TYPE && !this.fields().some((field) => field.kind === 'bits'),
  );

  /** Only the changed, visible fields: exactly what the PATCH sends. */
  private readonly changes = computed(() => {
    const body: Record<string, unknown> = {};
    for (const field of [...this.fields(), ...this.storedFields()]) {
      if (field.kind === 'bits' || !this.isVisible(field)) continue;
      const value = this.parsed(field);
      if (!Object.is(value, field.original)) body[field.key] = value;
    }
    return body;
  });
  protected readonly dirty = computed(() => Object.keys(this.changes()).length > 0);
  /** Stored settings changed below the fold: keeps "All stored settings" open. */
  protected readonly storedDirty = computed(() => this.storedFields().some((field) => field.key in this.changes()));

  /** Inline problems of the changed fields by field id (shown after the first Save). */
  protected readonly errors = computed(() => {
    const errors: Record<string, string> = {};
    const changes = this.changes();
    for (const field of [...this.fields(), ...this.storedFields()]) {
      if (!(field.key in changes) || field.kind !== 'number') continue;
      const value = this.parsed(field) as number;
      if (!Number.isInteger(value) || value < 0 || value > NUMBER_MAX) errors[field.id] = 'Enter a whole number from 0 to 1,000,000.';
    }
    return errors;
  });

  private destroyed = false;

  constructor() {
    this.destroyRef.onDestroy(() => (this.destroyed = true));
  }

  ngAfterViewInit(): void {
    this.dialog().nativeElement.showModal();
  }

  /** The current value of a field as the control shows it. */
  protected value(field: EditorField): unknown {
    const edits = this.edits();
    return field.id in edits ? edits[field.id] : field.kind === 'number' ? String(field.original) : field.original;
  }

  protected text(field: EditorField): string {
    return String(this.value(field) ?? '');
  }

  protected checked(field: EditorField): boolean {
    return this.value(field) === true;
  }

  protected set(field: EditorField, value: unknown): void {
    this.edits.update((edits) => ({ ...edits, [field.id]: value }));
    this.serverError.set(null);
  }

  protected onText(field: EditorField, event: Event): void {
    this.set(field, (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
  }

  protected onCheck(field: EditorField, event: Event): void {
    this.set(field, (event.target as HTMLInputElement).checked);
  }

  /** A dependent control (e.g. the end message) only shows while the control it depends on has the given value. */
  protected isVisible(field: EditorField): boolean {
    const rule = field.control?.showIf;
    if (!rule) return true;
    const source = this.fields().find((candidate) => candidate.id === rule.controlId);
    if (!source) return false;
    const value = this.parsed(source);
    return typeof rule.is === 'boolean' ? Boolean(value) === rule.is : value === rule.is;
  }

  protected fieldId(field: EditorField): string {
    return `ed-${field.id.replace(/[^\w-]/g, '-')}`;
  }

  /** What an empty message means for this field (catalog messages only; a stored setting may not apply to this event). */
  protected emptyHint(field: EditorField): string | null {
    if (!field.control) return null;
    return this.isNotification() && ['message', 'modiversaryMessage'].includes(field.key)
      ? `Leave it empty to use the default message in ${this.login()}'s language.`
      : 'Leave it empty to post nothing in chat.';
  }

  /** The ids the text field's hints have. */
  protected describedBy(field: EditorField): string {
    const id = this.fieldId(field);
    return [this.emptyHint(field) ? `${id}-hint` : '', `${id}-count`, field.control ? '' : `${id}-key`, this.text(field).length > MESSAGE_MAX ? `${id}-long` : '']
      .filter(Boolean)
      .join(' ');
  }

  protected save(): void {
    if (this.busy() || !this.dirty()) return;
    this.submitted.set(true);
    if (Object.keys(this.errors()).length) return;
    const name = this.eventName();
    this.saving.set(true);
    this.serverError.set(null);
    this.channelApi
      .ownerPatchEventsub(this.channelID(), this.eventsub().id, this.changes())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.saving.set(false);
          if (response?.error) {
            this.serverError.set(response.message || `Couldn't save ${name}. Try again.`);
            return;
          }
          this.saved.emit();
        },
        error: (err) => {
          this.saving.set(false);
          this.serverError.set(apiErrorMessage(err, `Couldn't save ${name}. Try again.`));
        },
      });
  }

  protected cancel(): void {
    if (!this.busy()) this.closed.emit();
  }

  /**
   * Escape closes the topmost layer first: a Bits rule's delete question, then its form, then the dialog.
   * Handled on keydown so the dialog never sees the Escape a layer used.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (this.bitsRules()?.closeLayer()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * The browser can close a modal dialog itself (a second Escape without a click in between ignores
   * `preventDefault`). While saving, or when a Bits rule layer was open (that layer closes instead), it opens
   * again; otherwise the parent removes it.
   */
  protected onNativeClose(): void {
    if (this.destroyed) return;
    if (this.busy() || this.bitsRules()?.closeLayer()) this.dialog().nativeElement.showModal();
    else this.closed.emit();
  }

  private settings(): Record<string, unknown> {
    return (this.eventsub().settings ?? {}) as unknown as Record<string, unknown>;
  }

  /** The value as it would be saved (numbers parsed). */
  private parsed(field: EditorField): unknown {
    const value = this.value(field);
    if (field.kind === 'number') return String(value ?? '').trim() === '' ? Number.NaN : Number(value);
    if (field.kind === 'select' && typeof field.original === 'number') return Number(value);
    return value;
  }
}

function kindOf(value: unknown): 'text' | 'number' | 'checkbox' {
  return typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text';
}

function typed(kind: FieldKind, value: unknown): unknown {
  if (kind === 'text') return typeof value === 'string' ? value : value == null ? '' : String(value);
  if (kind === 'number') return typeof value === 'number' ? value : Number(value ?? 0);
  if (kind === 'checkbox') return value === true || value === 'true';
  return value;
}

/** Options of a select control (strings or `{ value, label }`); the stored value is always one of them. */
function selectOptions(control: ChatEventControl, stored: unknown): { value: string; label: string }[] {
  if (control.type !== 'select') return [];
  const raw = (control as { options?: unknown }).options;
  const options = (Array.isArray(raw) ? raw : []).flatMap((option): { value: string; label: string }[] => {
    if (typeof option === 'string' || typeof option === 'number') return [{ value: String(option), label: String(option) }];
    if (option && typeof option === 'object') {
      const source = option as { value?: unknown; id?: unknown; label?: unknown };
      const value = String(source.value ?? source.id ?? '');
      const label = typeof source.label === 'string' ? source.label : controlLabel({ id: value, label: (source.label ?? {}) as ChatEventControl['label'] });
      return [{ value, label }];
    }
    return [];
  });
  const current = String(stored ?? '');
  return options.some((option) => option.value === current) ? options : [{ value: current, label: current || '(none)' }, ...options];
}
