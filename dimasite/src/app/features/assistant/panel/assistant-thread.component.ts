import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, output, untracked } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { ThrottleClickDirective } from '../../../shared/directives/throttle-click.directive';
import { LfIconComponent } from '../../../shared/lf-icon/lf-icon.component';
import { ASSISTANT_ROUTES } from '../assistant-routes';
import { AssistantStore } from '../assistant.store';
import type { NavigateItem, NoticeItem, UiItem } from '../assistant-view';
import { AssistantUiFrameComponent } from '../ui-frame/assistant-ui-frame.component';
import { AssistantApprovalCardComponent } from './assistant-approval-card.component';
import { AssistantMarkdownComponent } from './assistant-markdown.component';
import { AssistantToolGroupComponent } from './assistant-tool-group.component';

const EXAMPLES = ['command', 'setting', 'explain', 'overview'] as const;

/** Notice codes shown as a calm note instead of a problem. */
const CALM_NOTICES = new Set(['stopped', 'cancelled', 'superseded', 'compacted', 'queued']);

/** The open chat: messages, progress, tool rows, cards, status line. Scrolls itself. */
@Component({
  selector: 'app-assistant-thread',
  imports: [
    AssistantApprovalCardComponent,
    AssistantMarkdownComponent,
    AssistantToolGroupComponent,
    AssistantUiFrameComponent,
    LfIconComponent,
    ThrottleClickDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './assistant-thread.component.html',
  styleUrl: './assistant-thread.component.css',
  host: { '(scroll)': 'onScroll()' },
})
export class AssistantThreadComponent {
  readonly openChanges = output<void>();
  readonly example = output<string>();

  readonly store = inject(AssistantStore);
  private readonly i18n = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private stick = true;

  readonly examples = EXAMPLES;
  readonly lastTurnId = computed(() => {
    const turns = this.store.turns();
    return turns.length ? turns[turns.length - 1].turnId : null;
  });
  readonly statusText = computed(() => {
    const line = this.store.statusLine();
    if (this.store.stopping()) return this.t('assistant.status.stopping');
    if (!this.store.running()) return '';
    if (this.store.connection() === 'reconnecting') return this.t('assistant.status.reconnecting');
    if (!line) return this.store.waitingForUser() ? this.t('assistant.status.waiting') : '';
    if (line.phase === 'tool') return line.label || this.t('assistant.status.tool');
    if (line.phase === 'waiting') return this.t('assistant.status.waiting');
    if (line.phase === 'compacting') return this.t('assistant.status.compacting');
    return line.label || this.t('assistant.status.thinking');
  });
  /** Seconds since the current phase started, shown after 4 s (not announced). */
  readonly elapsed = computed(() => {
    const line = this.store.statusLine();
    if (!line || !this.store.running() || line.phase === 'waiting') return '';
    const seconds = Math.round((this.store.now() - line.since) / 1000);
    return seconds >= 4 ? this.t('assistant.status.seconds', { count: seconds }) : '';
  });

  constructor() {
    // Follow the conversation while the user is at the bottom.
    effect(() => {
      this.store.items();
      this.store.pending();
      this.store.statusLine();
      untracked(() => {
        if (!this.stick) return;
        requestAnimationFrame(() => this.scrollToEnd());
      });
    });
    // Opening another chat jumps to its end.
    effect(() => {
      this.store.sessionId();
      this.stick = true;
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  onScroll(): void {
    const element = this.host.nativeElement;
    this.stick = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }

  scrollToEnd(): void {
    const element = this.host.nativeElement;
    element.scrollTop = element.scrollHeight;
  }

  reopen(): void {
    const sessionId = this.store.sessionId();
    if (sessionId) void this.store.openSession(sessionId);
  }

  exampleText(key: string): string {
    return this.t(`assistant.empty.examples.${key}`);
  }

  noticeText(item: NoticeItem): string {
    const key = `assistant.notice.${item.code}`;
    const text = this.t(key);
    if (text !== key) return text;
    // Model problems arrive as `model_<kind>` (timeout, overloaded, …).
    const code = item.code.startsWith('model_') ? item.code.slice(6) : item.code;
    const error = this.t(`assistant.errors.${code}`);
    return error !== `assistant.errors.${code}` ? error : this.t('assistant.notice.unknown');
  }

  noticeCalm(item: NoticeItem): boolean {
    return CALM_NOTICES.has(item.code);
  }

  knownRoute(item: NavigateItem): boolean {
    return Object.prototype.hasOwnProperty.call(ASSISTANT_ROUTES, item.action.route);
  }

  openRoute(item: NavigateItem): void {
    this.store.navigateTo(item.action.route, item.action.anchor, item.action.label);
  }

  /** `dima.navigate(routeKey)` from a UI block (the frame already checked the key). */
  frameNavigate(routeKey: string): void {
    this.store.navigateTo(routeKey);
  }

  submitUi(item: UiItem, values: unknown): void {
    void this.store.submitUi(item, values);
  }

  uiError(item: UiItem): string {
    const error = this.store.callErrors()[item.callId];
    if (!error) return '';
    const key = `assistant.errors.${error.code}`;
    const text = this.t(key);
    return text === key ? error.message || this.t('assistant.errors.unknown') : text;
  }

  /** Thumbs on the latest finished answer only (older ones keep their "Thanks" once rated). */
  showFeedback(turnId: string): boolean {
    if (this.feedbackGiven(turnId) !== undefined) return true;
    return turnId === this.lastTurnId() && !this.store.running();
  }

  feedbackGiven(turnId: string): boolean | undefined {
    return this.store.feedbackGiven()[turnId];
  }

  pendingNote(mode: string, state: string): string {
    if (state === 'sending') return this.t('assistant.pending.sending');
    if (mode === 'queue') return this.t('assistant.pending.queued');
    if (mode === 'steer') return this.t('assistant.pending.steer');
    return this.t('assistant.pending.sent');
  }
}
