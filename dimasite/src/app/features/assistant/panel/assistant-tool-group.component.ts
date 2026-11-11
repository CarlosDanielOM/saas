import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { LfIconComponent, type LfIconName } from '../../../shared/lf-icon/lf-icon.component';
import { summarizeTools, type ToolItem } from '../assistant-view';

/** One compact row per run of tool calls ("Checked 3 docs pages"); open it to see each step. */
@Component({
  selector: 'app-assistant-tool-group',
  imports: [LfIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details class="tg" [attr.data-state]="summary().state">
      <summary class="tg-sum">
        <span class="tg-mark" aria-hidden="true">
          @if (summary().state === 'running') {
            <span class="tg-spin"></span>
          } @else {
            <app-lf-icon [name]="markIcon()" [size]="13" />
          }
        </span>
        <span class="tg-text">{{ title() }}</span>
        @if (summary().problems) {
          <span class="tg-problem">{{ t('assistant.tools.problems', { count: summary().problems }) }}</span>
        }
        <app-lf-icon class="tg-chev" name="chevron-down" [size]="14" />
      </summary>
      <ol class="tg-list">
        @for (tool of items(); track tool.id) {
          <li class="tg-row" [attr.data-state]="tool.state">
            <span class="tg-row__label">{{ tool.label }}</span>
            <span class="tg-row__state">{{ stateText(tool.state) }}</span>
            @if (tool.summary) {
              <span class="tg-row__sum">{{ tool.summary }}</span>
            }
          </li>
        }
      </ol>
    </details>
  `,
  styles: `
    :host { display: block; }
    .tg { border-radius: 0.75rem; }
    .tg-sum {
      display: flex; align-items: center; gap: 0.45rem; min-height: 36px; padding: 0.2rem 0.5rem;
      border-radius: 0.75rem; color: var(--muted); font-size: 0.83rem; font-weight: 600; cursor: pointer; list-style: none;
    }
    .tg-sum::-webkit-details-marker { display: none; }
    .tg-sum:hover { background: var(--btn); }
    .tg-sum:focus-visible { outline: 2px solid var(--kicker); outline-offset: 1px; }
    .tg-mark { display: grid; place-items: center; width: 1.25rem; height: 1.25rem; border-radius: 999px; background: var(--btn); color: var(--muted); flex-shrink: 0; }
    .tg[data-state='done'] .tg-mark { color: var(--ok); }
    .tg[data-state='problem'] .tg-mark { color: var(--warn); }
    .tg-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tg[data-state='running'] .tg-text { color: var(--fg); }
    .tg-problem { color: var(--warn); font-size: 0.76rem; white-space: nowrap; }
    .tg-chev { margin-left: auto; transition: transform 160ms ease; }
    .tg[open] .tg-chev { transform: rotate(180deg); }
    .tg-spin { width: 0.75rem; height: 0.75rem; border-radius: 999px; border: 2px solid var(--line); border-top-color: var(--kicker); animation: tg-spin 0.8s linear infinite; }
    .tg-list { display: grid; gap: 0.3rem; margin: 0.25rem 0 0.2rem 1.15rem; padding: 0 0 0 0.75rem; border-left: 2px solid var(--line); list-style: none; }
    .tg-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.05rem 0.5rem; font-size: 0.8rem; }
    .tg-row__label { color: var(--fg); overflow-wrap: anywhere; }
    .tg-row__state { color: var(--muted); white-space: nowrap; }
    .tg-row[data-state='error'] .tg-row__state, .tg-row[data-state='denied'] .tg-row__state { color: var(--warn); }
    .tg-row__sum { grid-column: 1 / -1; color: var(--muted); overflow-wrap: anywhere; }
    @keyframes tg-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .tg-spin { animation: none; border-top-color: var(--line); background: var(--kicker); } .tg-chev { transition: none; } }
  `,
})
export class AssistantToolGroupComponent {
  readonly items = input.required<ToolItem[]>();

  private readonly i18n = inject(LanguageService);
  readonly summary = computed(() => summarizeTools(this.items()));
  readonly title = computed(() => {
    const summary = this.summary();
    if (summary.state === 'running' && summary.runningLabel) return summary.runningLabel;
    if (summary.key === 'single') return String(summary.params['label'] ?? '');
    return this.t(`assistant.tools.${summary.key}`, summary.params);
  });
  readonly markIcon = computed<LfIconName>(() => {
    const state = this.summary().state;
    return state === 'problem' ? 'alert' : state === 'waiting' ? 'pause' : 'check';
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(key, params);
  }

  stateText(state: ToolItem['state']): string {
    return this.t(`assistant.tools.state.${state}`);
  }
}
