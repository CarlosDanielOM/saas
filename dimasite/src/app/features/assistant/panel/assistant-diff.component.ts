import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { LanguageService } from '../../../services/language.service';
import { diffFields, type FieldValue } from '../assistant-view';

/** Changed fields only: "Cooldown 5 s → 10 s"; command bodies and long text as monospace blocks. */
@Component({
  selector: 'app-assistant-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length) {
      <dl class="ad">
        @for (row of rows(); track row.key) {
          <div class="ad-row" [class.ad-row--block]="row.block">
            <dt class="ad-key">{{ row.label }}</dt>
            <dd class="ad-val">
              @if (row.block) {
                @if (row.before && !row.before.empty) {
                  <div class="ad-block ad-block--before">
                    <span class="ad-tag">{{ row.after ? t('assistant.diff.before') : t('assistant.diff.removed') }}</span>
                    <pre>{{ show(row.before) }}</pre>
                  </div>
                }
                @if (row.after && !row.after.empty) {
                  <div class="ad-block ad-block--after">
                    <span class="ad-tag">{{ row.before ? t('assistant.diff.after') : t('assistant.diff.new') }}</span>
                    <pre>{{ show(row.after) }}</pre>
                  </div>
                } @else if (row.after) {
                  <span class="ad-empty">{{ t('assistant.diff.empty') }}</span>
                }
              } @else {
                @if (row.before) {
                  <span class="ad-old" [class.ad-old--gone]="!row.after">{{ show(row.before) }}</span>
                }
                @if (row.before && row.after) {
                  <span class="ad-arrow" aria-hidden="true">→</span>
                  <span class="sr-only">{{ t('assistant.diff.to') }}</span>
                }
                @if (row.after) {
                  <span class="ad-new">{{ show(row.after) }}</span>
                }
              }
            </dd>
          </div>
        }
      </dl>
    } @else {
      <p class="ad-none">{{ t('assistant.diff.none') }}</p>
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .ad { display: grid; gap: 0.45rem; margin: 0; }
    .ad-row { display: grid; grid-template-columns: minmax(5.5rem, 34%) minmax(0, 1fr); gap: 0.15rem 0.6rem; align-items: baseline; }
    .ad-row--block { grid-template-columns: minmax(0, 1fr); }
    .ad-key { color: var(--muted); font-size: 0.8rem; font-weight: 650; }
    .ad-val { margin: 0; min-width: 0; font-size: 0.86rem; overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 0.15rem 0.4rem; align-items: baseline; }
    .ad-row--block .ad-val { display: grid; gap: 0.35rem; }
    .ad-old { color: var(--muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 70%, transparent); }
    .ad-old--gone { color: var(--danger); }
    .ad-new { color: var(--fg); font-weight: 650; }
    .ad-arrow { color: var(--muted); }
    .ad-block { position: relative; border: 1px solid var(--line); border-radius: 0.65rem; background: var(--code-bg); overflow: hidden; }
    .ad-block--before { border-style: dashed; }
    .ad-block--before pre { color: var(--muted); }
    .ad-tag { display: block; padding: 0.25rem 0.6rem 0; color: var(--muted); font-size: 0.68rem; font-weight: 750; letter-spacing: 0.04em; text-transform: uppercase; }
    .ad-block--after .ad-tag { color: var(--ok); }
    pre { margin: 0; padding: 0.3rem 0.6rem 0.5rem; max-height: 14rem; overflow: auto; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 0.8rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
    .ad-empty, .ad-none { color: var(--muted); font-size: 0.84rem; margin: 0; }
  `,
})
export class AssistantDiffComponent {
  readonly before = input<Record<string, unknown> | null>(null);
  readonly after = input<Record<string, unknown> | null>(null);

  private readonly i18n = inject(LanguageService);
  readonly rows = computed(() => diffFields(this.before(), this.after(), this.i18n.currentLanguage() === 'es' ? 'es-MX' : 'en'));

  t(key: string): string {
    return this.i18n.translate(key);
  }

  show(value: FieldValue): string {
    if (value.empty) return this.t('assistant.diff.empty');
    if (value.bool) return this.t(value.bool === 'on' ? 'assistant.diff.on' : 'assistant.diff.off');
    return value.text;
  }
}
