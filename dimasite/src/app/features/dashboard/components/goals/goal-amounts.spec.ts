import { describe, expect, it } from 'vitest';
import { formatGoalCurrency, goalItemNet, goalMoneyInput, parseGoalCount, parseGoalMoney } from './goal-amounts';

describe('goal amount entry', () => {
  it('keeps the requested mixed goal exact in cents', () => {
    const bitValue = parseGoalMoney('0.01')!;
    const subValue = parseGoalMoney('1.75')!;
    expect(250 * bitValue + 3 * subValue).toBe(775);
    expect(parseGoalMoney('250')).toBe(25_000);
    expect(goalMoneyInput(775)).toBe('7.75');
    expect(parseGoalMoney('1,75')).toBe(175);
  });
  it('rejects excess precision, exponent notation and out-of-range values without rounding', () => {
    for (const value of ['', '-1', '0', '1.005', '1,000', '1e3', 'NaN', '10000000.01']) expect(parseGoalMoney(value)).toBeNull();
    expect(parseGoalMoney('10000000.00')).toBe(1_000_000_000);
    expect(parseGoalMoney('0', true)).toBe(0);
    expect(parseGoalMoney('10.25', true, 10_000)).toBe(1025);
    expect(parseGoalMoney('100.01', true, 10_000)).toBeNull();
  });
  it('rounds fees once on the addition total rather than multiplying rounded unit values', () => {
    expect(goalItemNet(250, 1000, 3)).toBe(675);
    expect(goalItemNet(250, 2000)).toBe(200);
    expect(goalItemNet(255, 1000)).toBe(230);
    expect(goalItemNet(255, 1000, 10)).toBe(2295);
    expect(goalItemNet(250, 10000)).toBe(0);
  });
  it('keeps ordinary count goals restricted to whole positive values', () => {
    expect(parseGoalCount('100')).toBe(100);
    for (const value of ['0', '-1', '1.5', '1e3', '1000000001']) expect(parseGoalCount(value)).toBeNull();
  });
  it('displays every cent exactly in large safe-integer totals and localizes the separator', () => {
    expect(formatGoalCurrency(775, 'USD', 'en-US')).toBe('$7.75');
    expect(formatGoalCurrency(Number.MAX_SAFE_INTEGER, 'USD', 'en-US')).toBe('$90,071,992,547,409.91');
    expect(formatGoalCurrency(775, 'EUR', 'es-ES')).toContain('7,75');
  });
});
