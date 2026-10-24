import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { BitsRuleDialogComponent } from '../bits-rules/bits-rule-dialog.component';
import { BitsRuleEditor } from '../bits-rules/bits-rule-editor';
import { BitsRulesService } from '../bits-rules/bits-rules.service';
import { amountText, sortRules, type BitsRule, type BitsRuleInput } from '../bits-rules/bits-rules.model';
import type { AlertVariant } from './overlay.model';

/**
 * Bits tab of an alert design: the shared Bits rules (same list as Chat events) and which of them
 * play their own look. Tabs only list editable looks; rules on the default look sit in a list below.
 */
@Component({
  selector: 'app-overlay-bits-looks',
  imports: [LfIconComponent, BitsRuleDialogComponent],
  templateUrl: './overlay-bits-looks.component.html',
  styleUrls: ['../bits-rules/bits-rules-shared.css', './overlay-bits-looks.component.css'],
  providers: [BitsRuleEditor],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OverlayBitsLooksComponent {
  protected readonly service = inject(BitsRulesService);
  protected readonly editor = inject(BitsRuleEditor);
  private readonly language = inject(LanguageService);

  readonly looks = input<AlertVariant[]>([]);
  readonly selected = input<string | null>(null);
  readonly selectedChange = output<string | null>();
  /** Give a rule its own look (the editor copies the default look). */
  readonly lookAdded = output<string>();
  /** Drop a rule's look (Use the default look, or the rule was deleted). */
  readonly lookRemoved = output<string>();

  readonly view = this.service.view;
  readonly rules = computed(() => sortRules(this.view()?.rules ?? []));
  readonly atLimit = computed(() => (this.view()?.rules.length ?? 0) >= (this.view()?.maxRules ?? 50));
  /** Looks whose rule still exists, in rule order. */
  readonly tabs = computed(() => this.rules().flatMap(rule => {
    const look = this.looks().find(v => v.ruleId === rule.id);
    return look ? [{ rule, look }] : [];
  }));
  readonly withoutLook = computed(() => this.rules().filter(rule => !this.looks().some(v => v.ruleId === rule.id)));
  readonly current = computed(() => this.tabs().find(tab => tab.look.id === this.selected()) ?? null);

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('bitsRules.' + key, params); }
  amount(rule: BitsRule): string { return amountText(rule, this.language.currentLanguage() === 'es' ? 'es' : 'en'); }
  chatText(rule: BitsRule): string { return this.t('chip.' + rule.chat.mode); }

  async save(input: BitsRuleInput): Promise<void> {
    const creating = !this.editor.dialog()?.rule;
    const id = await this.editor.save(input);
    // A rule made here is meant for a look: start it from the default look right away.
    if (id && creating && input.alert) this.lookAdded.emit(id);
  }
  async remove(): Promise<void> {
    const rule = this.editor.dialog()?.rule;
    if (rule && await this.editor.remove() && this.looks().some(v => v.ruleId === rule.id)) this.lookRemoved.emit(rule.id);
  }
}
