import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, exhaustMap, interval, of, startWith, Subject, merge } from 'rxjs';
import { LanguageService } from '../../../../services/language.service';
import { LinksService } from '../../../../services/links.service';
import { formatGoalCurrency, goalItemNet, goalMoneyInput, parseGoalCount, parseGoalMoney } from './goal-amounts';

interface GoalAction { type: 'message' | 'ast'; text: string }
interface GoalCurrencyItem { key: string; label?: string; unitAmount: number; feeBasisPoints: number }
interface GoalCurrency { code: string; bitValue: number; subscriptionValue: number; items: GoalCurrencyItem[] }
interface CurrencyItemControls { key: FormControl<string>; label: FormControl<string>; unitAmount: FormControl<string>; feePercent: FormControl<string> }
interface Goal {
  id: string; name: string; metric: string; mode: string; target: number; current: number; percent: number;
  actions?: { completion?: GoalAction; failure?: GoalAction };
  outcome?: { phase: string; actionStatus: string };
  startsAt: number; endsAt?: number; windowSeconds?: number; status: string;
  currency?: GoalCurrency; timeZone?: string; period?: { key: string; startsAt: number; endsAt: number };
}
interface Snapshot { plan: string; limit: number; metrics: string[]; revision: number; goals: Goal[]; canManage: boolean }
interface Envelope { data: Snapshot }
@Component({
  selector: 'app-channel-goals',
  imports: [ReactiveFormsModule, DatePipe, DecimalPipe],
  templateUrl: './goals.component.html', styleUrl: './goals.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GoalsComponent {
  readonly channelID = input.required<string>();
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly language = inject(LanguageService);
  private readonly destroy = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);
  private readonly refresh = new Subject<void>();
  readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('editor');
  readonly data = signal<Snapshot | null>(null);
  readonly loadError = signal(false);
  readonly saveError = signal('');
  readonly saving = signal(false);
  readonly editing = signal<Goal | null>(null);
  readonly deleting = signal(false);
  readonly actionKinds = ['completion', 'failure'] as const;
  readonly currencyCodes = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;
  readonly mode = signal('total');
  readonly metric = signal('follows');
  readonly attempted = signal(false);
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]], metric: ['follows'], mode: ['total'],
    target: ['100', [Validators.required]],
    startsAt: [''], endsAt: [''], windowAmount: [1], windowUnit: [3600],
    timeZone: ['UTC'], currencyCode: ['USD'], bitValue: ['0.01'], subscriptionValue: ['1.75'],
    items: this.fb.array<FormGroup<CurrencyItemControls>>([]),
    completionType: ['none'], completionText: [''], failureType: ['none'], failureText: ['']
  });
  constructor() {
    this.form.controls.mode.valueChanges.pipe(takeUntilDestroyed()).subscribe(mode => this.mode.set(mode));
    this.form.controls.metric.valueChanges.pipe(takeUntilDestroyed()).subscribe(metric => {
      this.metric.set(metric);
      if (['bits', 'currency'].includes(metric) && this.form.controls.mode.value === 'current') this.form.controls.mode.setValue('total');
    });
    effect(cleanup => {
      const channel = this.channelID();
      this.data.set(null); this.loadError.set(false);
      const subscription = merge(interval(5000), this.refresh).pipe(startWith(0), exhaustMap(() =>
        this.http.get<Envelope>(this.url(channel)).pipe(catchError(() => of(null)))
      )).subscribe(response => {
        this.loadError.set(!response);
        if (response && (!this.data() || response.data.revision >= this.data()!.revision)) this.data.set(response.data);
      });
      cleanup(() => subscription.unsubscribe());
    });
  }
  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('channelGoals.' + key, params); }
  reload(): void { this.refresh.next(); }
  get items() { return this.form.controls.items; }
  open(goal: Goal | null = null, remove = false): void {
    this.editing.set(goal); this.deleting.set(remove); this.saveError.set(''); this.attempted.set(false);
    const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    this.items.clear();
    this.form.reset({ name: goal?.name ?? '', target: goal?.metric === 'currency' ? goalMoneyInput(goal.target) : String(goal?.target ?? 100), metric: goal?.metric ?? 'follows', mode: goal?.mode ?? 'total', startsAt: date.toISOString().slice(0, 16), endsAt: '', windowAmount: 1, windowUnit: 3600, timeZone: goal?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', currencyCode: goal?.currency?.code ?? 'USD', bitValue: goalMoneyInput(goal?.currency?.bitValue ?? 1), subscriptionValue: goalMoneyInput(goal?.currency?.subscriptionValue ?? 175), completionType: goal?.actions?.completion?.type ?? 'none', completionText: goal?.actions?.completion?.text ?? '', failureType: goal?.actions?.failure?.type ?? 'none', failureText: goal?.actions?.failure?.text ?? '' });
    for (const item of goal?.currency?.items ?? []) this.addItem(item);
    this.mode.set(goal?.mode ?? 'total');
    this.dialog().nativeElement.showModal();
  }
  close(): void { if (!this.saving()) this.dialog().nativeElement.close(); }
  cancel(event: Event): void { if (this.saving()) event.preventDefault(); }
  addItem(item?: GoalCurrencyItem): void {
    if (this.items.length >= 20) return;
    this.items.push(this.fb.nonNullable.group({ key: item?.key ?? '', label: item?.label ?? '', unitAmount: goalMoneyInput(item?.unitAmount ?? 250), feePercent: goalMoneyInput(item?.feeBasisPoints ?? 0) }));
  }
  removeItem(index: number): void { this.items.removeAt(index); }
  targetAmount(): number | null { return this.metric() === 'currency' ? parseGoalMoney(this.form.controls.target.value) : parseGoalCount(this.form.controls.target.value); }
  invalidTarget(): boolean { return this.targetAmount() === null; }
  invalidItem(index: number): boolean {
    const item = this.items.at(index).getRawValue(), key = item.key.trim();
    return !/^[a-z0-9_]{1,48}$/.test(key) || item.label.trim().length > 80 || this.items.controls.some((control, i) => i !== index && control.controls.key.value.trim() === key) || parseGoalMoney(item.unitAmount) === null || parseGoalMoney(item.feePercent, true, 10_000) === null;
  }
  currencyConfig(): GoalCurrency | null {
    const value = this.form.getRawValue(), bits = parseGoalMoney(value.bitValue, true), subs = parseGoalMoney(value.subscriptionValue, true);
    if (!this.currencyCodes.some(code => code === value.currencyCode) || bits === null || subs === null || this.items.controls.some((_, index) => this.invalidItem(index))) return null;
    const items = value.items.map(item => ({ key: item.key.trim(), ...(item.label.trim() ? { label: item.label.trim() } : {}), unitAmount: parseGoalMoney(item.unitAmount)!, feeBasisPoints: parseGoalMoney(item.feePercent, true, 10_000)! }));
    if (bits === 0 && subs === 0 && !items.some(item => item.feeBasisPoints < 10_000)) return null;
    return { code: value.currencyCode, bitValue: bits, subscriptionValue: subs, items };
  }
  invalidCurrency(): boolean { return this.metric() === 'currency' && !this.editing() && !this.currencyConfig(); }
  formatMoney(minor: number, code = this.form.controls.currencyCode.value): string { return formatGoalCurrency(minor, code, this.language.currentLanguage()); }
  formatAmount(goal: Goal, amount: number): string { return goal.metric === 'currency' ? this.formatMoney(amount, goal.currency?.code ?? 'USD') : new Intl.NumberFormat(this.language.currentLanguage()).format(amount); }
  progressValue(goal: Goal, amount: number): number { return goal.metric === 'currency' ? amount / 100 : amount; }
  progressText(goal: Goal): string { return this.t('progressValue', { current: this.formatAmount(goal, goal.current), target: this.formatAmount(goal, goal.target) }); }
  itemNet(item: GoalCurrencyItem, code = this.form.controls.currencyCode.value): string { return this.formatMoney(goalItemNet(item.unitAmount, item.feeBasisPoints), code); }
  itemFee(item: GoalCurrencyItem): string { return new Intl.NumberFormat(this.language.currentLanguage(), { maximumFractionDigits: 2 }).format(item.feeBasisPoints / 100); }
  itemPreview(index: number): string {
    if (this.invalidItem(index)) return this.t('customItemPreviewPending');
    const item = this.items.at(index).getRawValue(), net = goalItemNet(parseGoalMoney(item.unitAmount)!, parseGoalMoney(item.feePercent, true, 10_000)!, 3);
    return this.t('customItemPreview', { amount: this.formatMoney(net) });
  }
  customItemCommand(key: string): string { return `$(goal.add ${key || 'item_name'} 3)`; }
  itemCommand(index: number): string { return this.customItemCommand(this.items.at(index).controls.key.value.trim()); }
  periodLabel(goal: Goal): string { return goal.period ? new Intl.DateTimeFormat(this.language.currentLanguage(), { month: 'long', year: 'numeric', timeZone: goal.timeZone ?? 'UTC' }).format(goal.period.startsAt) : ''; }
  resetLabel(goal: Goal): string { return goal.period ? new Intl.DateTimeFormat(this.language.currentLanguage(), { dateStyle: 'medium', timeStyle: 'short', timeZone: goal.timeZone ?? 'UTC' }).format(goal.period.endsAt) : ''; }
  supportsFailure(): boolean { return ['fixed', 'rolling', 'monthly'].includes(this.mode()); }
  invalidTimeZone(): boolean {
    try { const value = this.form.controls.timeZone.value.trim(); if (!value || /^[+-]/.test(value)) return true; new Intl.DateTimeFormat('en', { timeZone: value }).format(); return false; } catch { return true; }
  }
  invalidTime(): boolean {
    if (this.editing()) return false;
    const value = this.form.getRawValue();
    if (value.mode === 'monthly') return this.invalidTimeZone();
    if (value.mode === 'fixed') {
      const start = Date.parse(value.startsAt), end = Date.parse(value.endsAt);
      return !Number.isFinite(start) || !Number.isFinite(end) || start < Date.now() - 60_000 || end <= Math.max(start, Date.now());
    }
    const duration = Number(value.windowAmount) * Number(value.windowUnit);
    return value.mode === 'rolling' && (!Number.isSafeInteger(duration) || duration < 1 || duration > 90 * 86400);
  }
  invalidAction(kind: 'completion' | 'failure'): boolean {
    const value = this.form.getRawValue(), type = value[`${kind}Type`], text = value[`${kind}Text`];
    if (kind === 'failure' && !this.supportsFailure()) return false;
    return type !== 'none' && (!text.trim() || text.length > (type === 'message' ? 500 : 4000));
  }
  save(): void {
    if (this.saving()) return;
    this.attempted.set(true); this.saveError.set('');
    const state = this.data(); if (!state) return;
    if (!this.deleting() && (this.form.invalid || !this.form.controls.name.value.trim() || this.invalidTarget() || this.invalidCurrency() || this.invalidTime() || this.invalidAction('completion') || this.invalidAction('failure'))) return;
    const goal = this.editing(), value = this.form.getRawValue();
    const actions: { completion?: GoalAction; failure?: GoalAction } = {};
    for (const kind of ['completion', 'failure'] as const) {
      if (kind === 'failure' && !this.supportsFailure()) continue;
      const type = value[`${kind}Type`];
      if (type === 'message' || type === 'ast') actions[kind] = { type, text: value[`${kind}Text`] };
    }
    const body = goal ? { name: value.name, target: this.targetAmount(), actions } : {
      actions,
      name: value.name, target: this.targetAmount(), metric: value.metric, mode: value.mode,
      ...(value.metric === 'currency' ? { currency: this.currencyConfig() } : {}),
      ...(value.mode === 'monthly' ? { timeZone: value.timeZone.trim() } : {}),
      ...(value.mode === 'fixed' ? { startsAt: new Date(value.startsAt).toISOString(), endsAt: new Date(value.endsAt).toISOString() } : {}),
      ...(value.mode === 'rolling' ? { windowSeconds: Number(value.windowAmount) * Number(value.windowUnit) } : {})
    };
    this.saving.set(true);
    this.http.request<Envelope>(this.deleting() ? 'DELETE' : goal ? 'PATCH' : 'POST', this.url(this.channelID()) + (goal ? '/' + goal.id : ''), {
      body, headers: { 'If-Match': String(state.revision) }
    }).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: response => { this.data.set(response.data); this.saving.set(false); this.close(); this.reload(); },
      error: (error: HttpErrorResponse) => {
        const code = error.error?.code;
        this.saveError.set(['conflict', 'limit', 'plan_required', 'permission_required', 'invalid'].includes(code) ? code : 'save');
        this.saving.set(false); this.reload();
      }
    });
  }
  private url(channel: string): string { return `${this.links.getApiUrl()}/goals/${encodeURIComponent(channel)}`; }
}
