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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  ChannelApiService,
  EDITABLE_EVENTSUB_FIELDS,
  chatEventFieldKey,
  type ChannelEventsub,
  type ChatEventControl,
  type ChatEventDefinition,
} from '../../services/channel-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { plural } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';

/** Watch streaks and mod anniversaries: an empty message means the default one in the streamer's language. */
export const CHAT_NOTIFICATION_TYPE = 'channel.chat.notification';
/** The longest chat message the editor accepts (Twitch's chat limit; the site assistant uses the same). */
export const MESSAGE_MAX = 500;
/** Raids accept only these settings (plus enabled/delay, which the editor doesn't offer). */
const RAID_FIELDS = new Set(['message', 'clipEnabled', 'minViewers']);
const EDITABLE = new Set<string>(EDITABLE_EVENTSUB_FIELDS);

/** The control whose text the bot posts for this event: the one saved as `message`, else the first text control. */
export function messageControl(definition: ChatEventDefinition | null | undefined): ChatEventControl | null {
  const controls = (definition?.config ?? []).filter((control) => control.type === 'text');
  return controls.find((control) => chatEventFieldKey(control) === 'message') ?? controls[0] ?? null;
}

/** English label of a catalog control (the admin is English-only). */
export function controlLabel(control: Pick<ChatEventControl, 'id' | 'label'>): string {
  return control.label?.EN || control.label?.en || control.id;
}

/** The site's Chat events page for a channel, where Bits rules (and anything the console can't edit) live. */
export function chatEventsSiteUrl(login: string | null | undefined): string {
  return login ? `https://domdimabot.com/${encodeURIComponent(login)}/modules/chat-events` : 'https://domdimabot.com';
}

type FieldKind = 'text' | 'number' | 'checkbox' | 'select' | 'bits' | 'site';

interface EditorField {
  /** The catalog control id (what `showIf` refers to). */
  id: string;
  /** The stored field it is saved to. */
  key: string;
  kind: FieldKind;
  label: string;
  control: ChatEventControl;
  /** The stored value, typed for its kind. */
  original: unknown;
  options: { value: string; label: string }[];
}

@Component({
  selector: 'app-eventsub-editor',
  templateUrl: './eventsub-editor.component.html',
  styleUrl: './eventsub-editor.component.css',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EventsubEditorComponent implements AfterViewInit {
  private readonly channelApi = inject(ChannelApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly eventsub = input.required<ChannelEventsub>();
  readonly definition = input.required<ChatEventDefinition>();
  readonly eventName = input.required<string>();
  readonly channelID = input.required<string>();
  readonly channelLogin = input<string | null>(null);

  readonly saved = output<void>();
  readonly closed = output<void>();

  protected readonly max = MESSAGE_MAX;
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);
  protected readonly serverError = signal<string | null>(null);
  /** Edited values by control id; a field without an entry still has its stored value. */
  private readonly edits = signal<Record<string, unknown>>({});

  protected readonly login = computed(() => this.channelLogin() || this.channelID());
  protected readonly siteUrl = computed(() => chatEventsSiteUrl(this.channelLogin()));
  private readonly isNotification = computed(() => this.eventsub().type === CHAT_NOTIFICATION_TYPE);

  /** The type's catalog controls in catalog order, each with its stored value. */
  protected readonly fields = computed<EditorField[]>(() => {
    const es = this.eventsub();
    const settings = (es.settings ?? {}) as unknown as Record<string, unknown>;
    const raid = es.rawType === 'channel.raid' || es.type.startsWith('channel.raid');
    const seen = new Set<string>();
    const fields: EditorField[] = [];
    for (const control of this.definition().config ?? []) {
      const key = chatEventFieldKey(control);
      if (seen.has(key)) continue;
      seen.add(key);
      const editable = EDITABLE.has(key) && (!raid || RAID_FIELDS.has(key));
      const kind: FieldKind =
        control.type === 'message-tiers' || key === 'cheerTiers'
          ? 'bits'
          : editable && ['text', 'number', 'checkbox', 'select'].includes(control.type)
            ? (control.type as FieldKind)
            : 'site';
      const stored = key in settings ? settings[key] : key === 'message' && es.message !== undefined ? es.message : control.value;
      fields.push({ id: control.id, key, kind, label: controlLabel(control), control, original: typed(kind, stored), options: selectOptions(control, stored) });
    }
    return fields;
  });

  /** Settings this dialog can't change: listed with a link to the site instead of a control that would be ignored. */
  protected readonly siteOnly = computed(() => this.fields().filter((field) => field.kind === 'site' && this.isVisible(field)).map((field) => field.label));

  /** Only the changed, visible, editable fields: exactly what the PATCH sends. */
  private readonly changes = computed(() => {
    const body: Record<string, unknown> = {};
    for (const field of this.fields()) {
      if (field.kind === 'bits' || field.kind === 'site' || !this.isVisible(field)) continue;
      const value = this.parsed(field);
      if (!Object.is(value, field.original)) body[field.key] = value;
    }
    return body;
  });
  protected readonly dirty = computed(() => Object.keys(this.changes()).length > 0);

  /** Inline problems of the changed fields by control id (shown after the first Save). */
  protected readonly errors = computed(() => {
    const errors: Record<string, string> = {};
    const changes = this.changes();
    for (const field of this.fields()) {
      if (!(field.key in changes)) continue;
      if (field.kind === 'number') {
        const value = this.parsed(field) as number;
        if (!Number.isInteger(value) || value < 0 || value > 1_000_000) errors[field.id] = 'Enter a whole number of 0 or more.';
      } else if (field.kind === 'text' && String(this.value(field)).length > MESSAGE_MAX) {
        errors[field.id] = `Keep it to ${MESSAGE_MAX} characters.`;
      }
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
    const rule = field.control.showIf;
    if (!rule) return true;
    const source = this.fields().find((candidate) => candidate.id === rule.controlId);
    if (!source) return false;
    const value = this.parsed(source);
    return typeof rule.is === 'boolean' ? Boolean(value) === rule.is : value === rule.is;
  }

  protected fieldId(field: EditorField): string {
    return `ed-${field.id.replace(/[^\w-]/g, '-')}`;
  }

  /** What an empty message means for this field. */
  protected emptyHint(field: EditorField): string {
    return this.isNotification() && ['message', 'modiversaryMessage'].includes(field.key)
      ? `Leave it empty to use the default message in ${this.login()}'s language.`
      : 'Leave it empty to post nothing in chat.';
  }

  protected bitsRules(): string {
    return plural(this.eventsub().cheerTierCount ?? 0, 'Bits rule');
  }

  protected save(): void {
    if (this.saving() || !this.dirty()) return;
    this.submitted.set(true);
    if (Object.keys(this.errors()).length) return;
    const name = this.eventName();
    this.saving.set(true);
    this.serverError.set(null);
    this.channelApi
      .patchChannelEventsub(this.channelID(), this.eventsub().id, this.changes())
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
    if (!this.saving()) this.closed.emit();
  }

  /**
   * The browser can close a modal dialog itself (a second Escape without a click in between ignores
   * `preventDefault`). While saving it opens again; otherwise the parent removes it.
   */
  protected onNativeClose(): void {
    if (this.destroyed) return;
    if (this.saving()) this.dialog().nativeElement.showModal();
    else this.closed.emit();
  }

  /** The value as it would be saved (numbers parsed). */
  private parsed(field: EditorField): unknown {
    const value = this.value(field);
    if (field.kind === 'number') return String(value ?? '').trim() === '' ? Number.NaN : Number(value);
    if (field.kind === 'select' && typeof field.original === 'number') return Number(value);
    return value;
  }
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
