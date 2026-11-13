import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { DocsAnswer } from '../../services/assistants-api.service';
import { IconComponent } from '../../shared/icon/icon.component';
import { dateTime, formatDuration, formatNumber, formatUSD, relativeTime } from '../../shared/format';
import { NORMAL_STOPS, docsFailureLabel, lowerFirst, metaLine, langName, safeHref, sourceLabel, toolLabel } from './assistants-format';

/**
 * One "Ask the docs" question: the question first, tap for the answer. The answer may contain Markdown and is
 * shown as text (line breaks kept), never as HTML.
 */
@Component({
  selector: 'app-docs-answer',
  template: `
    @let a = row();
    <details class="da" [attr.data-failed]="failed() ? 'true' : null" data-docs-row [attr.data-docs-id]="a.id">
      <summary class="da__sum">
        <span class="da__main">
          <span class="da__q" data-docs-question>{{ a.question || 'No question text' }}</span>
          <span class="da__meta">
            @if (failed()) {
              <span class="da__tag da__tag--bad" data-docs-failed>Not answered: {{ failure() }}</span>
            }
            <span>{{ meta() }}</span>
            @if (a.turn > 1) {
              <span class="da__tag">follow-up</span>
            }
            @if (a.feedback === 'helpful') {
              <span class="da__rate da__rate--ok" data-docs-rating="helpful"><app-icon name="thumb-up" />helpful</span>
            } @else if (a.feedback === 'unhelpful') {
              <span class="da__rate da__rate--bad" data-docs-rating="unhelpful"><app-icon name="thumb-down" />not helpful</span>
            }
          </span>
        </span>
        <span class="da__end">
          <b class="da__cost">{{ formatUSD(a.providerUSD) }}</b>
          <app-icon name="down" class="da__chev" />
        </span>
      </summary>
      <div class="da__body" data-docs-body>
        @if (failed()) {
          <p class="lf-notice da__why" data-docs-why>Not answered: {{ failure() }}. The visitor saw an error and could ask again.</p>
        } @else {
          <h3 class="da__h">Answer</h3>
          @if (a.answer.trim()) {
            <p class="lf-quote da__answer" data-docs-answer>{{ a.answer }}</p>
          } @else {
            <p class="lf-note">The answer was empty.</p>
          }
          @if (sources().length) {
            <h3 class="da__h">Sources</h3>
            <ul class="da__sources" data-docs-sources>
              @for (source of sources(); track source.href) {
                <li><a [href]="source.href" target="_blank" rel="noopener">{{ source.label }}<app-icon name="external" /></a></li>
              }
            </ul>
          }
        }
        <dl class="lf-dl da__dl">
          <div><dt>When</dt><dd>{{ dateTime(a.at) }}</dd></div>
          <div><dt>Question in the chat</dt><dd>{{ a.turn === 1 ? 'First' : 'Number ' + a.turn }}</dd></div>
          @if (!failed()) {
            <div><dt>Tools</dt><dd>{{ tools() }}</dd></div>
            <div><dt>Tokens</dt><dd>{{ formatNumber(a.inputTokens) }} in · {{ formatNumber(a.outputTokens) }} out</dd></div>
          }
          <div><dt>Cost to us</dt><dd>{{ formatUSD(a.providerUSD) }}</dd></div>
          @if (unusualStop()) {
            <div><dt>Stopped because</dt><dd class="da__mono">{{ a.stopReason }}</dd></div>
          }
          <div><dt>Rating</dt><dd>{{ a.feedback === 'helpful' ? 'Helpful' : a.feedback === 'unhelpful' ? 'Not helpful' : 'Not rated' }}</dd></div>
        </dl>
      </div>
    </details>
  `,
  styleUrl: './docs-answer.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
})
export class DocsAnswerComponent {
  readonly row = input.required<DocsAnswer>();

  /** The failure reason; a response without the field (older API) counts as not failed. */
  readonly failed = computed(() => this.row().failed ?? null);
  readonly failure = computed(() => lowerFirst(docsFailureLabel(this.row().failed ?? null)));
  /** "13 min ago · English · /en/commands/ · 5.2 s", dots kept with the word before them. */
  readonly meta = computed(() => {
    const row = this.row();
    return metaLine([relativeTime(row.at), langName(row.lang), row.page, formatDuration(row.durationMs)]);
  });
  readonly sources = computed(() =>
    this.row()
      .sources.map((url) => ({ href: safeHref(url), label: sourceLabel(url) }))
      .filter((source): source is { href: string; label: string } => source.href !== null),
  );
  readonly tools = computed(() => {
    const { tools, rounds } = this.row();
    const names = tools.length ? tools.map(toolLabel).join(', ') : 'none';
    return rounds && rounds > 1 ? `${names} (${rounds} rounds)` : names;
  });
  readonly unusualStop = computed(() => {
    const { stopReason } = this.row();
    return !this.failed() && !!stopReason && !NORMAL_STOPS.has(stopReason);
  });

  readonly formatDuration = formatDuration;
  readonly formatNumber = formatNumber;
  readonly formatUSD = formatUSD;
  readonly dateTime = dateTime;
}
