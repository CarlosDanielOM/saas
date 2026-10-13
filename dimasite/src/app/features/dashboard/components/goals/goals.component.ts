import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, exhaustMap, interval, of, startWith, Subject, merge } from 'rxjs';
import { LanguageService } from '../../../../services/language.service';
import { LinksService } from '../../../../services/links.service';

interface Goal {
  id: string; name: string; metric: string; mode: string; target: number; current: number; percent: number;
  startsAt: number; endsAt?: number; windowSeconds?: number; status: string;
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
  readonly mode = signal('total');
  readonly metric = signal('follows');
  readonly attempted = signal(false);
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]], metric: ['follows'], mode: ['total'],
    target: [100, [Validators.required, Validators.min(1), Validators.max(1_000_000_000), Validators.pattern(/^\d+$/)]],
    startsAt: [''], endsAt: [''], windowAmount: [1], windowUnit: [3600]
  });
  constructor() {
    this.form.controls.mode.valueChanges.pipe(takeUntilDestroyed()).subscribe(mode => this.mode.set(mode));
    this.form.controls.metric.valueChanges.pipe(takeUntilDestroyed()).subscribe(metric => {
      this.metric.set(metric);
      if (metric === 'bits' && this.form.controls.mode.value === 'current') this.form.controls.mode.setValue('total');
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
  open(goal: Goal | null = null, remove = false): void {
    this.editing.set(goal); this.deleting.set(remove); this.saveError.set(''); this.attempted.set(false);
    const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    this.form.reset({ name: goal?.name ?? '', target: goal?.target ?? 100, metric: goal?.metric ?? 'follows', mode: goal?.mode ?? 'total', startsAt: date.toISOString().slice(0, 16), endsAt: '', windowAmount: 1, windowUnit: 3600 });
    this.mode.set(goal?.mode ?? 'total');
    this.dialog().nativeElement.showModal();
  }
  close(): void { if (!this.saving()) this.dialog().nativeElement.close(); }
  cancel(event: Event): void { if (this.saving()) event.preventDefault(); }
  invalidTime(): boolean {
    if (this.editing()) return false;
    const value = this.form.getRawValue();
    if (value.mode === 'fixed') {
      const start = Date.parse(value.startsAt), end = Date.parse(value.endsAt);
      return !Number.isFinite(start) || !Number.isFinite(end) || start < Date.now() - 60_000 || end <= Math.max(start, Date.now());
    }
    const duration = Number(value.windowAmount) * Number(value.windowUnit);
    return value.mode === 'rolling' && (!Number.isSafeInteger(duration) || duration < 1 || duration > 90 * 86400);
  }
  save(): void {
    if (this.saving()) return;
    this.attempted.set(true); this.saveError.set('');
    const state = this.data(); if (!state) return;
    if (!this.deleting() && (this.form.invalid || !this.form.controls.name.value.trim() || this.invalidTime())) return;
    const goal = this.editing(), value = this.form.getRawValue();
    const body = goal ? { name: value.name, target: value.target } : {
      name: value.name, target: value.target, metric: value.metric, mode: value.mode,
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
