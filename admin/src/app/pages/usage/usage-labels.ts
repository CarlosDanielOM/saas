import type { UsageCategoryKey, UsageTransaction } from '../../services/usage-api.service';
import { formatNumber } from '../../shared/format';

/** Plain names for usage categories, as the operator says them. */
export const CATEGORY_LABEL: Record<UsageCategoryKey | 'credit_adjustment', string> = {
  tts: 'Voice',
  ai_chat: 'Chat AI',
  ai_agent: 'Code tool',
  memory: 'Memory',
  clip_recommendation: 'Clip picks',
  other: 'Other',
  uncategorized: 'Unsorted',
  credit_adjustment: 'Credit change',
};

/** The feature chips on the usage page. The last three only show when the range has any. */
export const CATEGORY_CHIPS: UsageCategoryKey[] = ['tts', 'ai_chat', 'memory', 'other', 'ai_agent', 'clip_recommendation', 'uncategorized'];
export const ALWAYS_SHOWN_CHIPS: ReadonlySet<UsageCategoryKey> = new Set(['tts', 'ai_chat', 'memory', 'other']);
export const isCategoryKey = (value: unknown): value is UsageCategoryKey => CATEGORY_CHIPS.includes(value as UsageCategoryKey);

const SOURCE_LABEL: Record<string, string> = {
  ast: 'Commands and rewards',
  redemption: 'Rewards',
  pet: 'Pet',
  voice_preview: 'Voice previews',
  oauth_desktop: 'Desktop app',
  chat: 'Chat',
  moderation: 'Chat protection',
  stream_summary: 'Stream memory',
  weekly_summary: 'Stream memory',
  monthly_summary: 'Stream memory',
  stream_offline: 'Stream memory',
  weekly_maintenance: 'Stream memory',
  monthly_maintenance: 'Stream memory',
  tts_queue: 'Voice queue',
  code_execution: 'Code tool',
  clip_recommendation: 'Clip picks',
  activation: 'Activation bonus',
  admin_credit_grant: 'Grant from the console',
  backend: 'Other',
};

/** "Commands and rewards" for `ast`; unknown sources read as words ("monthly reset"). */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'Not recorded';
  return SOURCE_LABEL[source] ?? capitalise(source.replace(/[_-]+/g, ' '));
}

const ADJUSTMENT_LABEL: Record<string, string> = {
  manual_grant: 'Grant',
  grant: 'Grant',
  monthly_reset: 'Monthly plan credits',
  plan_credits: 'Plan credits',
  pack: 'Credit pack',
  credit_pack: 'Credit pack',
  gift: 'Gifted credits',
  refund: 'Refund',
  activation: 'Activation bonus',
};

export function adjustmentLabel(type: string | null | undefined): string {
  if (!type) return 'Credit change';
  return ADJUSTMENT_LABEL[type] ?? capitalise(type.replace(/[_-]+/g, ' '));
}

/** Model without its provider prefix: "deepseek-v4.1-flash" for "deepseek/deepseek-v4.1-flash". */
export function modelName(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** "fish", or the model when there is one. */
export function modelOrProvider(model: string | null | undefined, provider: string | null | undefined): string {
  return modelName(model) ?? (provider && provider !== 'unknown' ? provider : 'no model recorded');
}

/** "49 characters", "6,931 tokens", "1 minute". */
export function quantityText(quantity: number | null, unit: UsageTransaction['unit']): string | null {
  if (quantity === null || !unit) return null;
  const one = unit.replace(/s$/, '');
  return `${formatNumber(quantity)} ${quantity === 1 ? one : unit}`;
}

/** What a call was, in plain words: "Voice · fish · 49 characters". */
export function transactionLine(tx: UsageTransaction): string {
  if (tx.entryKind === 'adjustment') return [adjustmentLabel(tx.adjustmentType ?? tx.operation), tx.source ? sourceLabel(tx.source) : null].filter(Boolean).join(' · ');
  return [CATEGORY_LABEL[tx.category] ?? 'Other', modelOrProvider(tx.model, tx.provider), quantityText(tx.quantity, tx.unit)].filter(Boolean).join(' · ');
}

export function planLabel(plan: 'free' | 'premium' | 'pro' | null | undefined): string | null {
  return plan === 'pro' ? 'Pro' : plan === 'premium' ? 'Premium' : plan === 'free' ? 'Free' : null;
}

export function planChipClass(plan: 'free' | 'premium' | 'pro' | null | undefined): string {
  return plan === 'pro' ? 'lf-chip lf-chip--pro' : plan === 'premium' ? 'lf-chip lf-chip--gold' : 'lf-chip lf-chip--muted';
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
