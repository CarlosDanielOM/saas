import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../../services/language.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { BitsRuleDialogComponent } from './bits-rule-dialog.component';
import { BitsRuleEditor } from './bits-rule-editor';
import { BitsRulesService } from './bits-rules.service';
import { amountText, matchBitsRule, sortRules, type BitsRule, type BitsRuleInput } from './bits-rules.model';

/** The Bits rules list inside the Cheers chat event: what happens for each amount, with a live tester. */
@Component({
  selector: 'app-bits-rules-panel',
  imports: [LfIconComponent, RouterLink, BitsRuleDialogComponent],
  templateUrl: './bits-rules-panel.component.html',
  styleUrls: ['./bits-rules-shared.css', './bits-rules-panel.component.css'],
  providers: [BitsRuleEditor],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BitsRulesPanelComponent {
  protected readonly service = inject(BitsRulesService);
  protected readonly editor = inject(BitsRuleEditor);
  private readonly language = inject(LanguageService);

  readonly channelId = input.required<string>();
  readonly canManage = input(false);
  /** Router link to Overlay Studio, only for the channel owner (the editor is owner-only). */
  readonly overlayLink = input<string[] | null>(null);

  readonly view = this.service.view;
  readonly rules = computed(() => sortRules(this.view()?.rules ?? []));
  readonly canEdit = computed(() => this.canManage() && !!this.view()?.canManage);
  readonly atLimit = computed(() => (this.view()?.rules.length ?? 0) >= (this.view()?.maxRules ?? 50));
  readonly testAmount = signal('100');
  readonly tested = computed(() => {
    const n = Number(this.testAmount());
    return Number.isSafeInteger(n) && n >= 1 ? { amount: n, rule: matchBitsRule(this.view()?.rules ?? [], n) } : null;
  });

  readonly suggestions: { key: string; preset: Partial<BitsRuleInput> }[] = [
    { key: 'suggest.big', preset: { min: 1000, max: null } },
    { key: 'suggest.exact', preset: { min: 100, max: 100, chat: { mode: 'custom', message: '' } } },
    { key: 'suggest.range', preset: { min: 500, max: 999 } }
  ];

  constructor() {
    effect(() => { const channel = this.channelId(); if (channel) void this.service.load(channel); });
  }

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('bitsRules.' + key, params); }
  amount(rule: Pick<BitsRule, 'min' | 'max'>): string { return amountText(rule, this.language.currentLanguage() === 'es' ? 'es' : 'en'); }
  number(value: number): string { return value.toLocaleString(this.language.currentLanguage() === 'es' ? 'es' : 'en'); }
  value(event: Event): string { return (event.target as HTMLInputElement).value; }

  chatKey(rule: BitsRule | null): string {
    if (!this.view()?.chat.enabled) return 'result.chatOff';
    if (!rule || rule.chat.mode === 'default') return this.view()?.chat.defaultMessage.trim() ? 'result.chatDefault' : 'result.chatNone';
    return rule.chat.mode === 'custom' ? 'result.chatCustom' : 'result.chatNone';
  }
  alertKey(rule: BitsRule | null): string {
    if (rule && !rule.alert) return 'result.alertNone';
    return rule && (this.view()?.looks[rule.id] ?? 0) > 0 ? 'result.alertOwn' : 'result.alertDefault';
  }
  hasOwnLook(rule: BitsRule): boolean { return (this.view()?.looks[rule.id] ?? 0) > 0; }

  async save(input: BitsRuleInput): Promise<void> { await this.editor.save(input); }
  async remove(): Promise<void> { await this.editor.remove(); }
}
