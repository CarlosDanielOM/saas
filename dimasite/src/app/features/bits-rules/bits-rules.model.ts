/**
 * Shared Bits rules (mirror of dimabot/src/bits_rules/model.ts). Chat events and Overlay Studio edit
 * the same list; one cheer matches the most specific enabled rule.
 */
export type BitsChatMode = 'default' | 'custom' | 'silent';
export interface BitsRule {
  id: string;
  name: string;
  enabled: boolean;
  min: number;
  /** null means "or more". */
  max: number | null;
  chat: { mode: BitsChatMode; message: string };
  alert: boolean;
}
export type BitsRuleInput = Omit<BitsRule, 'id'>;
export interface BitsRulesView {
  revision: number;
  rules: BitsRule[];
  maxRules: number;
  canManage: boolean;
  /** How many alert designs give each rule its own look. */
  looks: Record<string, number>;
  chat: { subscribed: boolean; enabled: boolean; defaultMessage: string };
}

export const MAX_BITS_AMOUNT = 1_000_000;
export const MAX_RULE_NAME = 60;
export const MAX_RULE_MESSAGE = 1000;

const width = (rule: BitsRule) => rule.max === null ? Number.POSITIVE_INFINITY : rule.max - rule.min;
export const compareSpecificity = (a: BitsRule, b: BitsRule) => width(a) - width(b) || b.min - a.min;

export function matchBitsRule(rules: readonly BitsRule[], bits: unknown): BitsRule | null {
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1) return null;
  let best: BitsRule | null = null;
  for (const rule of rules) {
    if (!rule.enabled || bits < rule.min || (rule.max !== null && bits > rule.max)) continue;
    if (!best || compareSpecificity(rule, best) < 0) best = rule;
  }
  return best;
}

/** Display order reads like a price ladder: lowest amount first, exact amounts before ranges. */
export const sortRules = (rules: readonly BitsRule[]) =>
  [...rules].sort((a, b) => a.min - b.min || (a.max ?? Infinity) - (b.max ?? Infinity));

export const rangesOverlap = (a: BitsRule, b: BitsRule) =>
  a.min <= (b.max ?? Infinity) && b.min <= (a.max ?? Infinity);

/** Other enabled rules that share at least one amount with this one. */
export const overlapping = (rule: BitsRule, rules: readonly BitsRule[]) =>
  rules.filter(other => other.id !== rule.id && other.enabled && rangesOverlap(rule, other));

export type AmountKind = 'exact' | 'range' | 'atLeast';
export const amountKind = (rule: Pick<BitsRule, 'min' | 'max'>): AmountKind =>
  rule.max === null ? 'atLeast' : rule.max === rule.min ? 'exact' : 'range';

/** "69", "100–499", "1,000+" (locale-formatted, no unit). */
export function amountText(rule: Pick<BitsRule, 'min' | 'max'>, locale: string): string {
  const n = (value: number) => value.toLocaleString(locale);
  if (rule.max === null) return `${n(rule.min)}+`;
  return rule.max === rule.min ? n(rule.min) : `${n(rule.min)}–${n(rule.max)}`;
}
