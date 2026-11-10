import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BotAccessService } from '../../../../services/bot-access.service';
import { LanguageService } from '../../../../services/language.service';
import { FullAccessNoteComponent } from '../../../../shared/full-access-note/full-access-note.component';
import { LinksService } from '../../../../services/links.service';

export const TWITCH_GOAL_TYPES = ['follow', 'subscription_count', 'new_subscription_count', 'subscription', 'new_subscription', 'new_bit', 'new_cheerer'] as const;
export type TwitchGoalType = typeof TWITCH_GOAL_TYPES[number];
interface TwitchAction { type: 'message' | 'ast'; text: string }
export interface TwitchGoalRule { type: TwitchGoalType; completion?: TwitchAction; failure?: TwitchAction }
export interface TwitchGoal {
  id: string; type: TwitchGoalType; description: string; current: number; target: number; percent: number;
  status: 'active' | 'reached' | 'ended'; achieved: boolean | null; startedAt: number; endedAt: number | null;
  outcome?: { phase: 'completed' | 'failed'; actionStatus: string; actionSuppressed?: string };
}
export interface TwitchGoals { access: 'ok' | 'permission' | 'unknown'; goals: TwitchGoal[]; rules: TwitchGoalRule[]; actionTypes: TwitchGoalType[] }

/**
 * Goals the streamer makes on Twitch: read-only progress (free on every plan, never a goal slot) and, per Twitch goal
 * type, a chat message or AST action when one is reached or ends without being reached.
 */
@Component({
  selector: 'app-twitch-goals',
  imports: [ReactiveFormsModule, DecimalPipe, RouterLink, FullAccessNoteComponent],
  templateUrl: './twitch-goals.component.html', styleUrl: './twitch-goals.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TwitchGoalsComponent {
  readonly twitch = input.required<TwitchGoals>();
  readonly revision = input.required<number>();
  readonly channelID = input.required<string>();
  readonly streamer = input('');
  readonly canManage = input(false);
  /** The new goals snapshot after a save, or null when the parent should reload (conflict). */
  readonly saved = output<unknown>();
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  readonly language = inject(LanguageService);
  private readonly destroy = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);
  private readonly botAccess = inject(BotAccessService);
  /**
   * The owner hasn't given full access: DomDimaBot can't read their Twitch goals yet, so "they show up on their own"
   * would not be true. Managers can't see the owner's flag: no change there.
   */
  readonly needsFullAccess = computed(() => this.botAccess.needsFullAccess(this.channelID()));
  readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('twitchEditor');
  readonly types = TWITCH_GOAL_TYPES;
  readonly kinds = ['completion', 'failure'] as const;
  readonly editing = signal<TwitchGoalType | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly attempted = signal(false);
  readonly form = this.fb.nonNullable.group({ completionType: ['none'], completionText: [''], failureType: ['none'], failureText: [''] });
  readonly ruleCount = computed(() => this.twitch().rules.filter(rule => rule.completion || rule.failure).length);
  readonly managerUrl = computed(() => `https://dashboard.twitch.tv/u/${encodeURIComponent(this.streamer())}/stream-manager`);
  readonly reconnectUrl = computed(() => `${this.links.getApiUrl()}/auth/authorize?${new URLSearchParams({ state: this.streamer(), action: 'reauthenticate' })}`);
  /** Bits and cheerer goal actions need Premium (the goals themselves are free). */
  readonly locked = computed(() => { const type = this.editing(); return !!type && !this.twitch().actionTypes.includes(type); });
  readonly existing = computed(() => this.rule(this.editing()));

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('channelGoals.twitch.' + key, params); }
  count(value: number): string { return new Intl.NumberFormat(this.language.currentLanguage()).format(value); }
  rule(type: TwitchGoalType | null): TwitchGoalRule | undefined { return type ? this.twitch().rules.find(rule => rule.type === type) : undefined; }
  name(goal: TwitchGoal): string { return goal.description || this.t('types.' + goal.type); }
  /** "When reached: chat message · If it ends first: nothing". */
  summary(type: TwitchGoalType): string {
    const rule = this.rule(type), part = (kind: 'completion' | 'failure') => this.t('summary.' + kind, { action: this.t('actionNames.' + (rule?.[kind]?.type ?? 'none')) });
    return `${part('completion')} · ${part('failure')}`;
  }
  outcomeText(goal: TwitchGoal): string {
    const outcome = goal.outcome; if (!outcome) return '';
    const status = outcome.actionSuppressed ? this.t('suppressed.' + outcome.actionSuppressed) : this.language.translate('channelGoals.actionStatus.' + outcome.actionStatus);
    return `${this.t('outcomes.' + outcome.phase)} · ${status}`;
  }
  progressText(goal: TwitchGoal): string { return this.language.translate('channelGoals.progressValue', { current: this.count(goal.current), target: this.count(goal.target) }); }

  open(type: TwitchGoalType): void {
    const rule = this.rule(type);
    this.editing.set(type); this.saveError.set(''); this.attempted.set(false);
    this.form.reset({ completionType: rule?.completion?.type ?? 'none', completionText: rule?.completion?.text ?? '', failureType: rule?.failure?.type ?? 'none', failureText: rule?.failure?.text ?? '' });
    if (this.locked()) this.form.disable(); else this.form.enable();
    this.dialog().nativeElement.showModal();
  }
  close(): void { if (!this.saving()) this.dialog().nativeElement.close(); }
  cancel(event: Event): void { if (this.saving()) event.preventDefault(); }
  invalid(kind: 'completion' | 'failure'): boolean {
    const value = this.form.getRawValue(), type = value[`${kind}Type`], text = value[`${kind}Text`];
    return type !== 'none' && (!text.trim() || text.length > (type === 'message' ? 500 : 4000));
  }
  /** Saves the rule; on a locked (Premium) type the only change allowed is removing it. */
  save(remove = false): void {
    const type = this.editing(); if (!type || this.saving()) return;
    this.attempted.set(true); this.saveError.set('');
    if (!remove && (this.locked() || this.invalid('completion') || this.invalid('failure'))) return;
    const value = this.form.getRawValue(), actions: Partial<Record<'completion' | 'failure', TwitchAction>> = {};
    if (!remove) for (const kind of this.kinds) {
      const action = value[`${kind}Type`];
      if (action === 'message' || action === 'ast') actions[kind] = { type: action, text: value[`${kind}Text`] };
    }
    this.saving.set(true);
    this.http.put<{ data: unknown }>(`${this.links.getApiUrl()}/goals/${encodeURIComponent(this.channelID())}/twitch/${type}`, { actions }, {
      headers: { 'If-Match': String(this.revision()) }
    }).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: response => { this.saving.set(false); this.saved.emit(response.data); this.close(); },
      error: (error: HttpErrorResponse) => {
        const code = error.error?.code;
        this.saveError.set(['conflict', 'plan_required', 'permission_required', 'invalid'].includes(code) ? code : 'save');
        this.saving.set(false);
        if (code === 'conflict') this.saved.emit(null);
      }
    });
  }
}
