/**
 * Bits rules are shared by chat events (what the bot says) and Overlay Studio (which alert look plays).
 * One cheer matches at most one rule: the most specific enabled range wins, so an exact amount
 * beats a range and a narrow range beats a wide one, regardless of list order.
 */
export const MAX_BITS_RULES = 50;
export const MAX_BITS_AMOUNT = 1_000_000;
export const MAX_RULE_NAME = 60;
export const MAX_RULE_MESSAGE = 1000;

export type BitsChatMode = 'default' | 'custom' | 'silent';
export interface BitsRule {
  id: string;
  name: string;
  enabled: boolean;
  min: number;
  /** null means "or more". */
  max: number | null;
  chat: { mode: BitsChatMode; message: string };
  /** Whether overlay alerts play for cheers that match this rule. */
  alert: boolean;
}

export class BitsRuleError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const RULE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
export const validRuleId = (value: unknown): value is string => typeof value === 'string' && RULE_ID.test(value);

function amount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_BITS_AMOUNT) {
    throw new BitsRuleError(`${field} must be a whole number of Bits from 1 to ${MAX_BITS_AMOUNT.toLocaleString('en-US')}`);
  }
  return value;
}

/** Validates a full rule body (create) or a partial one merged onto an existing rule (update). */
export function parseRule(raw: unknown, id: string, previous?: BitsRule): BitsRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BitsRuleError('Expected a rule');
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['name', 'enabled', 'min', 'max', 'chat', 'alert']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new BitsRuleError('Unknown rule field');
  const pick = <K extends keyof BitsRule>(key: K): unknown => key in body ? body[key] : previous?.[key];

  const name = pick('name') ?? '';
  if (typeof name !== 'string' || name.length > MAX_RULE_NAME) throw new BitsRuleError(`Names can be up to ${MAX_RULE_NAME} characters`);
  const enabled = pick('enabled') ?? true;
  if (typeof enabled !== 'boolean') throw new BitsRuleError('Expected on or off');
  const alert = pick('alert') ?? true;
  if (typeof alert !== 'boolean') throw new BitsRuleError('Expected alert on or off');
  const min = amount(pick('min'), 'The amount');
  const rawMax = pick('max');
  const max = rawMax === null || rawMax === undefined ? null : amount(rawMax, 'The highest amount');
  if (max !== null && max < min) throw new BitsRuleError('The highest amount must be at least the lowest amount');

  const rawChat = pick('chat') ?? { mode: 'default', message: '' };
  if (!rawChat || typeof rawChat !== 'object' || Array.isArray(rawChat)) throw new BitsRuleError('Invalid chat action');
  const chat = rawChat as Record<string, unknown>;
  if (!['default', 'custom', 'silent'].includes(chat.mode as string)) throw new BitsRuleError('Invalid chat action');
  const message = chat.message ?? '';
  if (typeof message !== 'string' || message.length > MAX_RULE_MESSAGE) throw new BitsRuleError(`Messages can be up to ${MAX_RULE_MESSAGE} characters`);
  if (chat.mode === 'custom' && !message.trim()) throw new BitsRuleError('Write the chat message, or choose the default message');

  return { id, name: name.trim(), enabled, min, max, chat: { mode: chat.mode as BitsChatMode, message }, alert };
}

const width = (rule: BitsRule) => rule.max === null ? Number.POSITIVE_INFINITY : rule.max - rule.min;

/** Most specific wins: narrowest range, then the higher starting amount ("1000+" beats "100+"), then list order. */
export function compareSpecificity(a: BitsRule, b: BitsRule): number {
  return width(a) - width(b) || b.min - a.min;
}

export function matchBitsRule(rules: readonly BitsRule[], bits: unknown): BitsRule | null {
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1) return null;
  let best: BitsRule | null = null;
  for (const rule of rules) {
    if (!rule.enabled || bits < rule.min || (rule.max !== null && bits > rule.max)) continue;
    if (!best || compareSpecificity(rule, best) < 0) best = rule;
  }
  return best;
}

/** Text the bot sends for a cheer; an empty string means stay silent. */
export function bitsChatMessage(rules: readonly BitsRule[], defaultMessage: string, bits: unknown): string {
  const rule = matchBitsRule(rules, bits);
  if (!rule || rule.chat.mode === 'default') return defaultMessage || '';
  return rule.chat.mode === 'custom' ? rule.chat.message : '';
}

/** Cheer tiers saved by the old chat-events editor (snake_case or camelCase amounts). */
export function rulesFromLegacyTiers(tiers: unknown): BitsRule[] {
  if (!Array.isArray(tiers)) return [];
  return tiers.flatMap((tier, index): BitsRule[] => {
    if (!tier || typeof tier !== 'object') return [];
    const t = tier as Record<string, unknown>;
    const min = Number(t.min_amount ?? t.minAmount), max = Number(t.max_amount ?? t.maxAmount);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
    const low = Math.min(MAX_BITS_AMOUNT, Math.max(1, Math.round(min)));
    const high = Math.min(MAX_BITS_AMOUNT, Math.max(low, Math.round(max)));
    const message = typeof t.message === 'string' ? t.message.slice(0, MAX_RULE_MESSAGE) : '';
    return [{
      id: validRuleId(t.id) ? t.id : `legacy-${index + 1}`,
      name: typeof t.name === 'string' ? t.name.trim().slice(0, MAX_RULE_NAME) : '',
      enabled: true, min: low, max: high,
      // An old tier with an empty message sent nothing.
      chat: message.trim() ? { mode: 'custom', message } : { mode: 'silent', message: '' },
      alert: true
    }];
  }).slice(0, MAX_BITS_RULES);
}
