import { GoalError, goalInteger, goalLabel, object } from './model.js';

export const GOAL_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;
export interface GoalCurrencyItem { key: string; label?: string; unitAmount: number; feeBasisPoints: number }
export interface GoalCurrency { code: typeof GOAL_CURRENCIES[number]; bitValue: number; subscriptionValue: number; items: GoalCurrencyItem[] }

function nonNegative(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new GoalError('invalid', `Expected an integer between 0 and ${max}`);
  }
  return value;
}

export function goalItemKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,48}$/.test(value)) throw new GoalError('invalid', 'Item key must contain 1–48 lowercase letters, digits or underscores');
  return value;
}

export function goalCurrency(value: unknown): GoalCurrency {
  const input = object(value);
  if (Object.keys(input).some(key => !['code', 'bitValue', 'subscriptionValue', 'items'].includes(key))) throw new GoalError('invalid', 'Unknown currency setting');
  if (typeof input.code !== 'string' || !GOAL_CURRENCIES.includes(input.code as GoalCurrency['code'])) throw new GoalError('invalid', 'Choose a supported two-decimal currency');
  const bitValue = nonNegative(input.bitValue, 1_000_000_000), subscriptionValue = nonNegative(input.subscriptionValue, 1_000_000_000);
  if (!Array.isArray(input.items) || input.items.length > 20) throw new GoalError('invalid', 'Items must contain at most 20 entries');
  const seen = new Set<string>();
  const items = input.items.map(value => {
    const item = object(value);
    if (Object.keys(item).some(key => !['key', 'label', 'unitAmount', 'feeBasisPoints'].includes(key))) throw new GoalError('invalid', 'Unknown item setting');
    const key = goalItemKey(item.key);
    if (seen.has(key)) throw new GoalError('invalid', 'Item keys must be unique');
    seen.add(key);
    return { key, ...(item.label === undefined ? {} : { label: goalLabel(item.label) }),
      unitAmount: goalInteger(item.unitAmount), feeBasisPoints: nonNegative(item.feeBasisPoints, 10_000) };
  });
  if (!bitValue && !subscriptionValue && !items.some(item => item.feeBasisPoints < 10_000)) throw new GoalError('invalid', 'Choose at least one currency source with a positive net amount');
  return { code: input.code as GoalCurrency['code'], bitValue, subscriptionValue, items };
}

export function goalWeightedAmount(unitAmount: number, quantity: number, feeBasisPoints = 0): number {
  nonNegative(unitAmount, 1_000_000_000);
  goalInteger(quantity);
  nonNegative(feeBasisPoints, 10_000);
  // Round once per transaction; BigInt avoids both floating-point drift and
  // intermediate multiplication overflow.
  const result = (BigInt(unitAmount) * BigInt(quantity) * BigInt(10_000 - feeBasisPoints) + 5_000n) / 10_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new GoalError('invalid', 'Currency contribution exceeds the safe integer limit');
  return Number(result);
}

export function customGoalDelta(currency: GoalCurrency, itemKey: string, quantity: number): number | null {
  goalItemKey(itemKey);
  goalInteger(quantity);
  const item = currency.items.find(item => item.key === itemKey);
  return item ? goalWeightedAmount(item.unitAmount, quantity, item.feeBasisPoints) : null;
}
