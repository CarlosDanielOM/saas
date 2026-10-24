import { Injectable, computed, inject, signal } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { ToastService } from '../../services/toast.service';
import { BitsRulesService, bitsRuleErrorKey } from './bits-rules.service';
import { amountText, type BitsRule, type BitsRuleInput } from './bits-rules.model';

interface OpenDialog { rule: BitsRule | null; preset: Partial<BitsRuleInput> | null }

/** Dialog state + save/delete/toggle with toasts; provide one per page section that edits rules. */
@Injectable()
export class BitsRuleEditor {
  private readonly service = inject(BitsRulesService);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  readonly dialog = signal<OpenDialog | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly toggling = signal<string | null>(null);
  readonly rules = computed(() => this.service.view()?.rules ?? []);

  t(key: string, params?: Record<string, string | number>): string { return this.language.translate('bitsRules.' + key, params); }
  label(rule: Pick<BitsRule, 'name' | 'min' | 'max'>): string {
    return rule.name || this.t('autoName', { amount: amountText(rule, this.language.currentLanguage() === 'es' ? 'es' : 'en') });
  }

  open(rule: BitsRule | null, preset: Partial<BitsRuleInput> | null = null): void { this.error.set(null); this.dialog.set({ rule, preset }); }
  close(): void { if (!this.busy()) this.dialog.set(null); }

  /** Resolves to the saved rule id, or null when saving failed (the dialog stays open with the error). */
  async save(input: BitsRuleInput): Promise<string | null> {
    const editing = this.dialog()?.rule;
    this.busy.set(true); this.error.set(null);
    try {
      const id = editing ? (await this.service.update(editing.id, input), editing.id) : await this.service.create(input);
      this.dialog.set(null);
      this.toast.success(this.t(editing ? 'toast.saved' : 'toast.created'), this.label(input));
      return id;
    } catch (error) {
      this.error.set(this.t('errors.' + bitsRuleErrorKey(error)));
      return null;
    } finally { this.busy.set(false); }
  }

  async remove(): Promise<boolean> {
    const rule = this.dialog()?.rule; if (!rule) return false;
    this.busy.set(true); this.error.set(null);
    try {
      await this.service.remove(rule.id);
      this.dialog.set(null);
      this.toast.success(this.t('toast.deleted'), this.label(rule));
      return true;
    } catch (error) {
      this.error.set(this.t('errors.' + bitsRuleErrorKey(error)));
      return false;
    } finally { this.busy.set(false); }
  }

  /** On/off from a row: shows the new state at once and rolls back if the save fails. */
  async patch(rule: BitsRule, change: Partial<BitsRuleInput>): Promise<void> {
    if (this.toggling()) return;
    const view = this.service.view(); if (!view) return;
    this.toggling.set(rule.id);
    this.service.view.set({ ...view, rules: view.rules.map(r => r.id === rule.id ? { ...r, ...change } : r) });
    try { await this.service.update(rule.id, change); }
    catch (error) {
      this.service.view.update(current => current ? { ...current, rules: current.rules.map(r => r.id === rule.id ? rule : r) } : current);
      this.toast.error(this.t('toast.failed'), this.t('errors.' + bitsRuleErrorKey(error)));
    } finally { this.toggling.set(null); }
  }
}
