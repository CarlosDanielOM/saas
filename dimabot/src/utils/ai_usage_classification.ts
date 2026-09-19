export const ADJUSTMENT_TYPES = ['manual_grant', 'monthly_reset', 'purchased_pack', 'refund', 'correction', 'activation', 'other'] as const;
export function classifyAdjustment(input: { entryKind?: unknown; operation?: unknown; source?: unknown; reason?: unknown; adjustmentType?: unknown }): string | null {
    if (input.entryKind !== 'adjustment') return null;
    if (ADJUSTMENT_TYPES.includes(input.adjustmentType as any)) return String(input.adjustmentType);
    const source = String(input.source || '');
    const operation = String(input.operation || '');
    if (['free_credit_reset', 'free_credit_reset_worker'].includes(source) || operation === 'monthly_reset') return 'monthly_reset';
    if (source === 'admin_credit_grant') return 'manual_grant';
    if (source === 'credit_pack_purchase' || operation === 'purchase_pack') return 'purchased_pack';
    if (operation === 'refund') return 'refund';
    if (operation === 'correction') return 'correction';
    if (source === 'activation' || input.reason === 'Free benefits') return 'activation';
    return 'other';
}
