import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, afterNextRender, computed, inject, input, output, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import {
  MAX_BITS_AMOUNT, MAX_RULE_MESSAGE, MAX_RULE_NAME, amountKind, amountText, overlapping,
  type AmountKind, type BitsChatMode, type BitsRule, type BitsRuleInput
} from './bits-rules.model';

let nextDialogId = 0;

/** Create/edit one shared Bits rule: amount → chat → overlay alert. Used by Chat events and Overlay Studio. */
@Component({
  selector: 'app-bits-rule-dialog',
  imports: [LfIconComponent],
  templateUrl: './bits-rule-dialog.component.html',
  styleUrls: ['./bits-rules-shared.css', './bits-rule-dialog.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape($event)' }
})
export class BitsRuleDialogComponent implements OnInit, OnDestroy {
  protected readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly uid = `bits-rule-${++nextDialogId}`;

  /** The rule being edited; null creates a new one (optionally from `preset`). */
  readonly rule = input<BitsRule | null>(null);
  readonly preset = input<Partial<BitsRuleInput> | null>(null);
  readonly rules = input<BitsRule[]>([]);
  readonly defaultMessage = input('');
  readonly chatOn = input(true);
  readonly context = input<'chat' | 'overlay'>('chat');
  readonly busy = input(false);
  readonly error = input<string | null>(null);

  readonly saved = output<BitsRuleInput>();
  readonly deleted = output<void>();
  readonly closed = output<void>();

  readonly kind = signal<AmountKind>('atLeast');
  readonly from = signal('');
  readonly to = signal('');
  readonly name = signal('');
  readonly chatMode = signal<BitsChatMode>('default');
  readonly message = signal('');
  readonly alert = signal(true);
  readonly enabled = signal(true);
  readonly submitted = signal(false);
  readonly confirmingDelete = signal(false);

  readonly maxName = MAX_RULE_NAME;
  readonly maxMessage = MAX_RULE_MESSAGE;
  readonly quickAmounts = [100, 500, 1000, 5000];
  readonly kinds: AmountKind[] = ['exact', 'range', 'atLeast'];
  private opener: HTMLElement | null = null;

  constructor() {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('[data-autofocus]')?.focus());
  }

  ngOnInit(): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const source = this.rule() ?? this.preset();
    if (!source) return;
    if (source.min !== undefined) {
      this.from.set(String(source.min));
      this.kind.set(amountKind({ min: source.min, max: source.max ?? null }));
      if (source.max !== null && source.max !== undefined && source.max !== source.min) this.to.set(String(source.max));
    }
    this.name.set(source.name ?? '');
    if (source.chat) { this.chatMode.set(source.chat.mode); this.message.set(source.chat.message); }
    if (source.alert !== undefined) this.alert.set(source.alert);
    if (source.enabled !== undefined) this.enabled.set(source.enabled);
  }

  ngOnDestroy(): void { this.opener?.focus?.(); }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('bitsRules.' + key, params); }
  private locale(): string { return this.language.currentLanguage() === 'es' ? 'es' : 'en'; }

  private parse(value: string): number | null {
    const n = Number(value.trim());
    return value.trim() && Number.isSafeInteger(n) && n >= 1 && n <= MAX_BITS_AMOUNT ? n : null;
  }
  readonly min = computed(() => this.parse(this.from()));
  readonly max = computed(() => this.kind() === 'atLeast' ? null : this.kind() === 'exact' ? this.min() : this.parse(this.to()));

  readonly fromError = computed(() => this.min() === null ? this.t('errors.amount', { max: MAX_BITS_AMOUNT.toLocaleString(this.locale()) }) : null);
  readonly toError = computed(() => {
    if (this.kind() !== 'range') return null;
    const max = this.parse(this.to()), min = this.min();
    if (max === null) return this.t('errors.amount', { max: MAX_BITS_AMOUNT.toLocaleString(this.locale()) });
    return min !== null && max <= min ? this.t('errors.rangeOrder') : null;
  });
  readonly messageError = computed(() => this.chatMode() === 'custom' && !this.message().trim() ? this.t('errors.message') : null);
  readonly valid = computed(() => !this.fromError() && !this.toError() && !this.messageError());

  /** Plain sentence of what the amount matches, e.g. "Cheers of 100 to 499 Bits". */
  readonly summary = computed(() => {
    const min = this.min(), max = this.max();
    if (min === null || (this.kind() === 'range' && (max === null || max <= min))) return '';
    const n = (value: number) => value.toLocaleString(this.locale());
    if (this.kind() === 'exact') return this.t('summary.exact', { amount: n(min) });
    if (this.kind() === 'atLeast') return this.t('summary.atLeast', { amount: n(min) });
    return this.t('summary.range', { from: n(min), to: n(max!) });
  });

  readonly autoName = computed(() => {
    const min = this.min();
    return min === null ? this.t('namePlaceholder') : this.t('autoName', { amount: amountText({ min, max: this.max() }, this.locale()) });
  });

  /** Other rules that share amounts with this one, and which rule wins there. */
  readonly overlaps = computed(() => {
    const min = this.min(), max = this.max();
    if (min === null || (max !== null && max < min)) return [];
    const candidate: BitsRule = { id: this.rule()?.id ?? '__new__', name: '', enabled: true, min, max, chat: { mode: 'default', message: '' }, alert: true };
    return overlapping(candidate, this.rules()).map(other => other.name || amountText(other, this.locale()));
  });

  setKind(kind: AmountKind): void {
    this.kind.set(kind);
    if (kind === 'range' && !this.to().trim() && this.min() !== null) this.to.set(String(Math.min(MAX_BITS_AMOUNT, this.min()! * 5 - 1)));
  }
  value(event: Event): string { return (event.target as HTMLInputElement | HTMLTextAreaElement).value; }
  insert(token: string): void {
    const field = this.host.nativeElement.querySelector<HTMLTextAreaElement>(`#${this.uid}-message`);
    const text = this.message(), start = field?.selectionStart ?? text.length, end = field?.selectionEnd ?? text.length;
    const next = (text.slice(0, start) + token + text.slice(end)).slice(0, MAX_RULE_MESSAGE);
    this.message.set(next);
    queueMicrotask(() => { field?.focus(); field?.setSelectionRange(start + token.length, start + token.length); });
  }

  submit(): void {
    this.submitted.set(true);
    if (!this.valid() || this.busy()) {
      queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    this.saved.emit({
      name: this.name().trim(), enabled: this.enabled(), min: this.min()!, max: this.max(),
      chat: { mode: this.chatMode(), message: this.chatMode() === 'custom' ? this.message() : '' }, alert: this.alert()
    });
  }

  close(): void { if (!this.busy()) this.closed.emit(); }
  onEscape(event: Event): void {
    event.preventDefault();
    if (this.confirmingDelete()) this.confirmingDelete.set(false); else this.close();
  }
}
