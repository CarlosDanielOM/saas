export const GOAL_AMOUNT_MAX = 1_000_000_000;

/** Parse an entered amount without rounding or passing through binary decimals. */
export function parseGoalMoney(value: string, allowZero = false, max = GOAL_AMOUNT_MAX): number | null {
  if (value.length > 32) return null;
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (minor < (allowZero ? 0n : 1n) || minor > BigInt(max)) return null;
  return Number(minor);
}

export function parseGoalCount(value: string): number | null {
  if (value.length > 32) return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const amount = BigInt(value.trim());
  return amount >= 1n && amount <= BigInt(GOAL_AMOUNT_MAX) ? Number(amount) : null;
}

export function goalMoneyInput(minor: number): string {
  const value = BigInt(minor);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export function goalItemNet(unitAmount: number, feeBasisPoints: number, quantity = 1): number {
  return Number((BigInt(unitAmount) * BigInt(quantity) * BigInt(10_000 - feeBasisPoints) + 5_000n) / 10_000n);
}

export function formatGoalCurrency(minor: number, code: string, locale: string): string {
  const amount = BigInt(minor), fraction = String(amount % 100n).padStart(2, '0');
  // Format the whole amount as bigint, preserving every cent even above the
  // precision at which dividing a large safe integer by 100 loses a cent.
  return new Intl.NumberFormat(locale, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .formatToParts(amount / 100n).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}
