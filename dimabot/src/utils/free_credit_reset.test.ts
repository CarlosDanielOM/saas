import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFreeCreditResetExternalId,
  decideFreeCreditReset,
  type FreeCreditResetRecordLike,
} from './free_credit_reset.js';

const period = {
  source: 'free_monthly' as const,
  startsAt: '2026-09-07T10:30:00.000Z',
};

function previous(overrides: Partial<FreeCreditResetRecordLike> = {}): FreeCreditResetRecordLike {
  return {
    periodStart: '2026-08-07T10:30:00.000Z',
    periodEnd: '2026-09-07T10:30:00.000Z',
    status: 'completed',
    credits: 0,
    externalId: 'free-credit-reset-user-2026-08-07',
    ...overrides,
  };
}

test('builds a stable reset ID from the user and period', () => {
  assert.equal(
    buildFreeCreditResetExternalId('user', new Date(period.startsAt)),
    'free-credit-reset-user-2026-09-07',
  );
});

test('baselines an existing free account when no reset ledger exists', () => {
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period, maximumResetCredits: 25_000, usedCredits: 5_000,
  }), {
    action: 'initialize', externalId: 'free-credit-reset-user-2026-09-07',
  });
});

test('grants only the credits used during a completed prior period', () => {
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period, previous: previous(), maximumResetCredits: 25_000, usedCredits: 5_000,
  }), {
    action: 'grant', credits: 5_000, externalId: 'free-credit-reset-user-2026-09-07',
  });
});

test('caps a reset at the free monthly allowance', () => {
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period, previous: previous(), maximumResetCredits: 25_000, usedCredits: 80_000,
  }), {
    action: 'grant', credits: 25_000, externalId: 'free-credit-reset-user-2026-09-07',
  });
});

test('completes a new period without a grant when no credits were used', () => {
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period, previous: previous(), maximumResetCredits: 25_000, usedCredits: 0,
  }), {
    action: 'complete_zero', externalId: 'free-credit-reset-user-2026-09-07',
  });
});

test('retries the exact pending grant and external ID', () => {
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period,
    previous: previous({
      periodStart: period.startsAt,
      periodEnd: '2026-10-07T10:30:00.000Z',
      status: 'pending',
      credits: 4_321,
      externalId: 'persisted-id',
    }),
    maximumResetCredits: 25_000,
    usedCredits: 999,
  }), {
    action: 'grant', credits: 4_321, externalId: 'persisted-id',
  });
});

test('skips completed current periods and non-free periods', () => {
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period,
    previous: previous({ periodStart: period.startsAt, status: 'completed' }),
    maximumResetCredits: 25_000,
  }), { action: 'skip' });
  assert.deepEqual(decideFreeCreditReset({
    userId: 'user', period: { source: 'subscription', startsAt: period.startsAt },
    maximumResetCredits: 25_000,
  }), { action: 'skip' });
});
