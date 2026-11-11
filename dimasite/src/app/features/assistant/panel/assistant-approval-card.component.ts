import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { AssistantStore } from '../assistant.store';
import { approvalProblem, approvalView, countdown, type ApprovalItem } from '../assistant-view';
import { AssistantDiffComponent } from './assistant-diff.component';

/** A change waiting for the user's OK: what, where, before → after, what it can do, Apply / Skip. */
@Component({
  selector: 'app-assistant-approval-card',
  imports: [AssistantDiffComponent, LfIconComponent, ThrottleClickDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let card = item();
    @let p = card.proposal;
    <article class="ac" [attr.data-state]="viewState()" [attr.aria-labelledby]="'ac-title-' + card.id" data-assistant-approval>
      <header class="ac-head">
        <span class="ac-icon" aria-hidden="true"><app-lf-icon [name]="icon()" [size]="16" /></span>
        <div class="ac-title">
          <p class="ac-kicker">{{ kicker() }}</p>
          <h3 class="ac-name" [id]="'ac-title-' + card.id" tabindex="-1">{{ p.title }}</h3>
          @if (p.target.label) {
            <p class="ac-target">{{ p.target.label }}</p>
          }
        </div>
        @switch (viewState()) {
          @case ('pending') {
            <span class="ac-chip ac-chip--time" [attr.aria-label]="t('assistant.approval.expiresIn', { time: timeLeft() })">
              <app-lf-icon name="timer" [size]="13" />{{ timeLeft() }}
            </span>
          }
          @case ('applied') { <span class="ac-chip ac-chip--ok">{{ t('assistant.approval.state.applied') }}</span> }
          @case ('failed') { <span class="ac-chip ac-chip--danger">{{ t('assistant.approval.state.failed') }}</span> }
          @case ('unknown') { <span class="ac-chip ac-chip--warn">{{ t('assistant.approval.state.unknown') }}</span> }
          @default { <span class="ac-chip">{{ t('assistant.approval.state.' + viewState()) }}</span> }
        }
      </header>

      <div class="ac-diff">
        <app-assistant-diff [before]="p.before" [after]="p.after" />
      </div>

      @if (p.effects.length) {
        <div class="ac-effects" role="note">
          <p class="ac-effects__title"><app-lf-icon name="alert" [size]="15" />{{ t('assistant.approval.effects') }}</p>
          <ul>
            @for (effect of p.effects; track $index) {
              <li>{{ effect }}</li>
            }
          </ul>
        </div>
      }
      @if (p.warnings?.length) {
        <ul class="ac-warnings">
          @for (warning of p.warnings; track $index) {
            <li><app-lf-icon name="alert" [size]="13" />{{ warning }}</li>
          }
        </ul>
      }

      @if (error()) {
        <p class="ac-error" role="alert">{{ errorText() }}</p>
      }

      @if (viewState() === 'pending') {
        <div class="ac-actions">
          <button type="button" class="ac-btn" [disabled]="busy()" (appThrottleClick)="decide('skip')">{{ t('assistant.approval.skip') }}</button>
          <button type="button" class="ac-btn ac-btn--primary" [disabled]="busy()" (appThrottleClick)="decide('apply')" data-assistant-apply>
            {{ busy() ? t('assistant.approval.applying') : t('assistant.approval.apply') }}
          </button>
        </div>
      } @else if (viewState() === 'applied') {
        <p class="ac-foot">
          {{ t('assistant.approval.appliedNote') }}
          <button type="button" class="ac-link" (click)="openChanges.emit()">{{ t('assistant.approval.seeChanges') }}</button>
        </p>
      } @else if (problemText()) {
        <p class="ac-problem" [class.ac-problem--unknown]="viewState() === 'unknown'" data-assistant-approval-problem>
          <app-lf-icon name="alert" [size]="15" /><span>{{ problemText() }}</span>
        </p>
        @if (viewState() === 'unknown') {
          <p class="ac-foot">
            <button type="button" class="ac-link" (click)="openChanges.emit()">{{ t('assistant.approval.openChanges') }}</button>
          </p>
        }
      } @else {
        <p class="ac-foot">{{ t('assistant.approval.note.' + viewState()) }}</p>
      }
    </article>
  `,
  styleUrl: './assistant-approval-card.component.css',
})
export class AssistantApprovalCardComponent {
  readonly item = input.required<ApprovalItem>();
  readonly openChanges = output<void>();

  private readonly store = inject(AssistantStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(LanguageService);

  readonly busy = computed(() => this.store.busyCalls().has(this.item().callId));
  readonly error = computed(() => this.store.callErrors()[this.item().callId] ?? null);
  readonly remainingMs = computed(() => this.item().expiresAt - this.store.now());
  /** Expired locally as soon as the countdown ends (the server confirms a moment later); `unknown` = result unknown. */
  readonly viewState = computed(() => approvalView(this.item().state, this.item().error, this.remainingMs() <= 0));
  readonly icon = computed(() => {
    const view = this.viewState();
    return view === 'applied' ? 'check' : view === 'unknown' || view === 'failed' ? 'alert' : 'shield';
  });
  readonly timeLeft = computed(() => countdown(this.remainingMs()));
  readonly kicker = computed(() => {
    const p = this.item().proposal;
    if (!p.before) return this.t('assistant.approval.kind.create');
    if (!p.after) return this.t('assistant.approval.kind.delete');
    return this.t('assistant.approval.kind.change');
  });
  readonly errorText = computed(() => {
    const error = this.error();
    if (!error) return '';
    const key = `assistant.errors.${error.code}`;
    const text = this.t(key);
    return text === key ? error.message || this.t('assistant.errors.unknown') : text;
  });

  /** Why it didn't apply (or that the result is unknown): a runner code or the tool's own sentence (conflicts). */
  readonly problemText = computed(() => {
    const problem = approvalProblem(this.item().state, this.item().error);
    if (!problem) return '';
    return 'text' in problem ? problem.text : this.t(problem.key);
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  async decide(decision: 'apply' | 'skip'): Promise<void> {
    const element = this.host.nativeElement;
    const hadFocus = element.contains(document.activeElement);
    await this.store.decide(this.item(), decision);
    // Apply/Skip are gone now: keep focus on the card so the new state is read next.
    if (hadFocus) setTimeout(() => element.querySelector<HTMLElement>('.ac-name')?.focus());
  }
}
