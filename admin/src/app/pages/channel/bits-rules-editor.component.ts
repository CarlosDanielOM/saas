import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';

import {
  ChannelApiService,
  type BitsRule,
  type BitsRuleWrite,
  type BitsRules,
  type OwnerWriteResponse,
} from '../../services/channel-api.service';
import { apiErrorMessage } from '../../services/api-util';
import { formatNumber, plural } from '../../shared/format';
import { IconComponent } from '../../shared/icon/icon.component';

type ChatMode = BitsRule['chat']['mode'];

/** The open sub-form: a new rule (`id` null) or an existing one, with the values as typed. */
interface RuleForm {
  id: string | null;
  name: string;
  min: string;
  max: string;
  mode: ChatMode;
  message: string;
  alert: boolean;
}

/** "100–499 bits", "1,000+ bits", "100 bits". */
export function bitsRange(rule: Pick<BitsRule, 'min' | 'max'>): string {
  if (rule.max === null) return `${formatNumber(rule.min)}+ bits`;
  return rule.max === rule.min ? `${formatNumber(rule.min)} bits` : `${formatNumber(rule.min)}–${formatNumber(rule.max)} bits`;
}

/** Lowest amount first, exact amounts before ranges (as the site lists them). */
const sortRules = (rules: readonly BitsRule[]) => [...rules].sort((a, b) => a.min - b.min || (a.max ?? Infinity) - (b.max ?? Infinity));

/**
 * The channel's shared Bits rules (cheers in chat + Overlay Studio alert looks), edited through the site's
 * `/bits-rules/:channelID` API. Every change saves right away and the API answers the whole new state.
 */
@Component({
  selector: 'app-bits-rules-editor',
  templateUrl: './bits-rules-editor.component.html',
  styleUrl: './bits-rules-editor.component.css',
  imports: [IconComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BitsRulesEditorComponent implements OnInit {
  private readonly channelApi = inject(ChannelApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly channelID = input.required<string>();

  protected readonly state = signal<BitsRules | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly form = signal<RuleForm | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly confirmingDelete = signal(false);
  /** A row switch that failed (the form has its own error line). */
  protected readonly listError = signal<string | null>(null);
  /** What the last write did, read out politely ("Rule added."). */
  protected readonly done = signal('');
  /** A write is on its way: the dialog around it waits before closing. */
  readonly busy = signal(false);

  protected readonly rules = computed(() => sortRules(this.state()?.rules ?? []));
  protected readonly editingRule = computed(() => {
    const id = this.form()?.id;
    return id ? (this.state()?.rules.find((rule) => rule.id === id) ?? null) : null;
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loadError.set(null);
    this.channelApi
      .getBitsRules(this.channelID())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (response?.error || !response?.data) {
            this.loadError.set(response?.message || "Couldn't load the Bits rules");
            return;
          }
          this.state.set(response.data);
        },
        error: (err) => this.loadError.set(apiErrorMessage(err, "Couldn't load the Bits rules")),
      });
  }

  protected range(rule: BitsRule): string {
    return bitsRange(rule);
  }

  /** The rule's name, or its amounts when it has none. */
  protected title(rule: BitsRule): string {
    return rule.name || bitsRange(rule);
  }

  protected looks(rule: BitsRule): number {
    return this.state()?.looks?.[rule.id] ?? 0;
  }

  protected looksText(rule: BitsRule): string {
    return plural(this.looks(rule), 'Studio look');
  }

  protected defaultMessage(): string {
    return this.state()?.chat?.defaultMessage?.trim() ?? '';
  }

  protected add(): void {
    this.openForm({ id: null, name: '', min: '', max: '', mode: 'default', message: '', alert: true });
  }

  protected edit(rule: BitsRule): void {
    this.openForm({
      id: rule.id,
      name: rule.name,
      min: String(rule.min),
      max: rule.max === null ? '' : String(rule.max),
      mode: rule.chat.mode,
      message: rule.chat.message,
      alert: rule.alert,
    });
  }

  protected cancelForm(): void {
    if (this.busy()) return;
    const id = this.form()?.id ?? null;
    this.form.set(null);
    this.formError.set(null);
    this.confirmingDelete.set(false);
    this.focusAfterForm(id);
  }

  /**
   * Escape here closes the topmost open layer: the delete question (back to its Delete button), then the form
   * (back to the rule's Edit button or Add rule). While a write is on its way it waits. True when Escape was used.
   */
  closeLayer(): boolean {
    if (!this.form()) return false;
    if (this.busy()) return true;
    if (this.confirmingDelete()) this.keepRule();
    else this.cancelForm();
    return true;
  }

  /** Delete asks first; focus moves into the question so it scrolls into view. */
  protected askDelete(): void {
    this.confirmingDelete.set(true);
    this.focusLater('.br-confirm .lf-btn');
  }

  protected keepRule(): void {
    this.confirmingDelete.set(false);
    this.focusLater('.br-delete');
  }

  protected setText(key: 'name' | 'min' | 'max' | 'message' | 'mode', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    this.form.update((form) => (form ? { ...form, [key]: value } : form));
    this.formError.set(null);
  }

  protected setAlert(event: Event): void {
    const value = (event.target as HTMLInputElement).checked;
    this.form.update((form) => (form ? { ...form, alert: value } : form));
    this.formError.set(null);
  }

  protected save(): void {
    const form = this.form();
    if (!form || this.busy()) return;
    const min = whole(form.min);
    const max = form.max.trim() === '' ? null : whole(form.max);
    if (min === null || Number.isNaN(min) || (max !== null && Number.isNaN(max))) {
      this.formError.set('Enter the amounts as whole numbers of bits.');
      return;
    }
    const chat = { mode: form.mode, message: form.message };
    const rule = this.editingRule();
    if (!form.id) {
      this.write(this.channelApi.createBitsRule(this.channelID(), { name: form.name.trim(), enabled: true, min, max, chat, alert: form.alert }), 'Rule added.');
      return;
    }
    if (!rule) {
      this.formError.set('This rule was deleted. Close the form to see the current rules.');
      return;
    }
    // Only what changed (the API merges it onto the stored rule).
    const body: BitsRuleWrite = {};
    if (form.name.trim() !== rule.name) body.name = form.name.trim();
    if (min !== rule.min) body.min = min;
    if (max !== rule.max) body.max = max;
    if (chat.mode !== rule.chat.mode || chat.message !== rule.chat.message) body.chat = chat;
    if (form.alert !== rule.alert) body.alert = form.alert;
    if (!Object.keys(body).length) {
      this.cancelForm();
      return;
    }
    this.write(this.channelApi.updateBitsRule(this.channelID(), rule.id, body), 'Rule saved.');
  }

  protected remove(): void {
    const rule = this.editingRule();
    if (!rule || this.busy()) return;
    this.write(this.channelApi.deleteBitsRule(this.channelID(), rule.id), 'Rule deleted.');
  }

  /** On/off from a row: shows the new state at once and goes back if the save fails. */
  protected toggle(rule: BitsRule): void {
    if (this.busy()) return;
    const enabled = !rule.enabled;
    const flip = (value: boolean) =>
      this.state.update((state) => (state ? { ...state, rules: state.rules.map((item) => (item.id === rule.id ? { ...item, enabled: value } : item)) } : state));
    flip(enabled);
    this.listError.set(null);
    this.busy.set(true);
    this.channelApi
      .updateBitsRule(this.channelID(), rule.id, { enabled })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.busy.set(false);
          if (response?.error || !response?.data) {
            flip(rule.enabled);
            this.listError.set(response?.message || `Couldn't turn ${this.title(rule)} ${enabled ? 'on' : 'off'}.`);
            return;
          }
          this.state.set(response.data);
          this.done.set(`${this.title(rule)} turned ${enabled ? 'on' : 'off'}.`);
        },
        error: (err) => {
          this.busy.set(false);
          flip(rule.enabled);
          this.listError.set(apiErrorMessage(err, `Couldn't turn ${this.title(rule)} ${enabled ? 'on' : 'off'}.`));
        },
      });
  }

  protected fieldId(name: string): string {
    return `br-${this.form()?.id ?? 'new'}-${name}`;
  }

  private openForm(form: RuleForm): void {
    if (this.busy()) return;
    this.form.set(form);
    this.formError.set(null);
    this.listError.set(null);
    this.confirmingDelete.set(false);
    this.done.set('');
    this.focusLater('.br-form input');
  }

  /** After the form closes, back to its rule's Edit button (or Add rule when the rule is gone). */
  private focusAfterForm(id: string | null): void {
    this.focusLater(id ? `[data-rule="${id}"] .lf-btn` : '.br-add', '.br-add');
  }

  /** Focuses the first match once the view shows it (zoneless: after the next render). */
  private focusLater(selector: string, fallback?: string): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const target = root.querySelector<HTMLElement>(selector) ?? (fallback ? root.querySelector<HTMLElement>(fallback) : null);
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  private write(request: Observable<OwnerWriteResponse<BitsRules>>, doneText: string): void {
    this.busy.set(true);
    this.formError.set(null);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        this.busy.set(false);
        if (response?.error || !response?.data) {
          this.formError.set(response?.message || "Couldn't save the rule. Try again.");
          return;
        }
        const id = this.form()?.id ?? (response.data as BitsRules & { created?: string }).created ?? null;
        this.state.set(response.data);
        this.form.set(null);
        this.confirmingDelete.set(false);
        this.done.set(doneText);
        this.focusAfterForm(id);
      },
      error: (err) => {
        this.busy.set(false);
        this.formError.set(apiErrorMessage(err, "Couldn't save the rule. Try again."));
      },
    });
  }
}

/** A whole number typed in a field, NaN when it isn't one (null for an empty field). */
function whole(text: string): number | null {
  const value = text.trim();
  if (value === '') return null;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}
