import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { AssistantTurn } from '../../services/assistants-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { formatDuration, formatUSD, plural, relativeTime } from '../../shared/format';
import { errorLabel, lowerFirst, metaLine, turnStatus } from './assistants-format';

/** One Dima assistant message as a dense row: the question first, then who, where, how it went. Tap opens the exchange. */
@Component({
  selector: 'app-assistant-turn',
  template: `
    @let t = turn();
    <button type="button" class="tn" [attr.data-tone]="status().tone" data-turn-row [attr.data-turn-id]="t.id" (click)="opened.emit(t)" aria-haspopup="dialog">
      <span class="tn__main">
        @if (t.question) {
          <span class="tn__q" data-turn-question>{{ t.question }}</span>
        } @else {
          <span class="tn__q tn__q--none">{{ t.textKept === false ? 'Text no longer kept (3 days)' : 'No text recorded' }}</span>
        }
        <span class="tn__who-line"><b class="tn__who">{{ t.user.name || t.user.login || 'Someone' }}</b>{{ who() }}</span>
        <span class="tn__meta">
          <span class="tn__tag tn__tag--status" data-turn-status>{{ status().label }}</span>
          <span class="tn__tag" [class.tn__tag--expert]="t.level === 'expert'">{{ t.level === 'expert' ? 'Expert' : 'Standard' }}</span>
          @if (t.fellBack) {
            <span class="tn__tag tn__tag--warn" data-fell-back>fell back to Standard</span>
          }
          <span>{{ steps() }}</span>
        </span>
      </span>
      <span class="tn__end">
        <b class="tn__cost">{{ formatUSD(t.providerUSD) }}</b>
        <app-icon name="chevron" class="tn__chev" />
      </span>
    </button>
  `,
  styleUrl: './assistant-turn.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
})
export class AssistantTurnComponent {
  readonly turn = input.required<AssistantTurn>();
  readonly showChannel = input(true);
  readonly opened = output<AssistantTurn>();

  readonly status = computed(() => turnLabel(this.turn()));
  readonly when = computed(() => relativeTime(this.turn().at));
  /** ", editor · luna_plays · 5 h ago": the dots stick to the word before them, so a wrapped line never starts with one. */
  readonly who = computed(() => {
    const turn = this.turn();
    return `, ${metaLine([turn.user.role === 'admin' ? 'editor' : 'owner', this.showChannel() ? turn.channel || 'unknown channel' : null, this.when()])}`;
  });
  readonly steps = computed(() => {
    const turn = this.turn();
    const steps = turn.tools.length ? `${plural(turn.steps, 'step')}, ${plural(turn.tools.length, 'tool')}` : plural(turn.steps, 'step');
    return metaLine([steps, formatDuration(turn.durationMs)]);
  });
  readonly formatDuration = formatDuration;
  readonly formatUSD = formatUSD;
}

/** "Failed: the model took too long", "Answered", "Stopped by the person". */
export function turnLabel(turn: Pick<AssistantTurn, 'status' | 'errorCode'>): { label: string; tone: string } {
  const status = turnStatus(turn.status);
  return turn.errorCode && status.tone === 'danger' ? { ...status, label: `${status.label}: ${lowerFirst(errorLabel(turn.errorCode))}` } : status;
}
