import { describe, expect, it } from 'vitest';

import { getConfigPersistenceKey, normalizeCheerTierArray, serializeConfigControlValue } from './chat-events.contract';
import type { CheerTier, ConfigControl } from './chat-events.model';

describe('chat-events contract helpers', () => {
  it('maps known UI-only control ids to backend keys', () => {
    const control = {
      id: 'enableClip'
    } as Pick<ConfigControl, 'id' | 'dbId'>;

    expect(getConfigPersistenceKey(control)).toBe('clipEnabled');
  });

  it('maps begin message controls to the backend message field', () => {
    const control = {
      id: 'beginMessage'
    } as Pick<ConfigControl, 'id' | 'dbId'>;

    expect(getConfigPersistenceKey(control)).toBe('message');
  });

  it('maps ad break begin aliases to the backend message field', () => {
    expect(getConfigPersistenceKey({ id: 'adBreakMessage' } as Pick<ConfigControl, 'id' | 'dbId'>)).toBe('message');
    expect(getConfigPersistenceKey({ id: 'adBeginMessage' } as Pick<ConfigControl, 'id' | 'dbId'>)).toBe('message');
  });

  it('normalizes snake_case backend cheer tiers into frontend camelCase tiers', () => {
    const tiers = normalizeCheerTierArray([
      {
        id: 'tier-1',
        name: 'Gold',
        message: 'Thanks!',
        min_amount: 100,
        max_amount: 499
      }
    ]);

    expect(tiers).toEqual<CheerTier[]>([
      {
        id: 'tier-1',
        name: 'Gold',
        message: 'Thanks!',
        minAmount: 100,
        maxAmount: 499
      }
    ]);
  });

  it('serializes frontend cheer tiers into backend snake_case payloads', () => {
    const control = {
      id: 'cheerTiers',
      type: 'message-tiers',
      value: [
        {
          id: 'tier-1',
          name: 'Gold',
          message: 'Thanks!',
          minAmount: 100,
          maxAmount: 499
        }
      ]
    } as Pick<ConfigControl, 'id' | 'type' | 'value'>;

    expect(serializeConfigControlValue(control)).toEqual([
      {
        id: 'tier-1',
        name: 'Gold',
        message: 'Thanks!',
        min_amount: 100,
        max_amount: 499
      }
    ]);
  });
});
