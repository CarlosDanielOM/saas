import type { CheerTier, ConfigControl } from './chat-events.model';

const CONTROL_KEY_FALLBACKS: Record<string, string> = {
  adBeginMessage: 'message',
  adBreakMessage: 'message',
  beginMessage: 'message',
  enableClip: 'clipEnabled'
};

export function getConfigPersistenceKey(control: Pick<ConfigControl, 'id' | 'dbId'>): string {
  return control.dbId?.trim() || CONTROL_KEY_FALLBACKS[control.id] || control.id;
}

export function serializeConfigControlValue(control: Pick<ConfigControl, 'id' | 'type' | 'value'>): unknown {
  if (control.type === 'message-tiers' || control.id === 'cheerTiers') {
    return (normalizeCheerTierArray(control.value) ?? []).map((tier) => ({
      id: tier.id,
      name: tier.name,
      message: tier.message,
      min_amount: tier.minAmount,
      max_amount: tier.maxAmount
    }));
  }

  return control.value;
}

export function normalizeCheerTierArray(value: unknown): CheerTier[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tiers = value.filter((tier): tier is CheerTier => {
    if (!tier || typeof tier !== 'object') {
      return false;
    }

    const candidate = tier as Partial<CheerTier> & { min_amount?: unknown; max_amount?: unknown };
    return typeof candidate.id === 'string'
      && typeof candidate.name === 'string'
      && typeof candidate.message === 'string'
      && (typeof candidate.minAmount === 'number' || typeof candidate.min_amount === 'number')
      && (typeof candidate.maxAmount === 'number' || typeof candidate.max_amount === 'number');
  });

  return tiers.map((tier) => {
    const candidate = tier as CheerTier & { min_amount?: number; max_amount?: number };

    return {
      id: candidate.id,
      name: candidate.name,
      message: candidate.message,
      minAmount: typeof candidate.minAmount === 'number' ? candidate.minAmount : candidate.min_amount ?? 0,
      maxAmount: typeof candidate.maxAmount === 'number' ? candidate.maxAmount : candidate.max_amount ?? 0
    };
  });
}
