import UsersSchema from '../schemas/users.schema.js';
import { polarRequest } from './billing.js';

/** Statuses Polar can still bill or keep active. Ended and never-paid (incomplete) ones are left alone. */
const BILLABLE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

interface PolarSubscriptionPage {
    items?: Array<{ id: string; status: string }>;
    pagination?: { max_page?: number };
}

async function listBillableSubscriptionIds(filter: 'customer_id' | 'external_customer_id', value: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
        const params = new URLSearchParams({ [filter]: value, limit: '100', page: String(page) });
        const response = await polarRequest<PolarSubscriptionPage>(`/v1/subscriptions/?${params.toString()}`, { method: 'GET' });
        if (!Array.isArray(response.items)) {
            throw new Error('Unexpected Polar subscription list response');
        }
        ids.push(...response.items.filter(subscription => BILLABLE_STATUSES.has(subscription.status)).map(subscription => subscription.id));
        if (page >= (response.pagination?.max_page ?? 1)) {
            return ids;
        }
    }
}

/**
 * Revokes (ends now, no further charges) every billable Polar subscription of an account.
 * Checkouts link subscriptions either to the stored Polar customer ID or to our user ID as
 * Polar's external customer ID, so both are checked. Throws if any subscription stays billable,
 * so account deletion stops before any data is removed.
 */
export async function revokePolarSubscriptionsForAccount(userID: string): Promise<number> {
    const user = await UsersSchema.findById(userID).select('polar_sh_customer_id').lean();
    if (!user) {
        return 0;
    }

    const ids = new Set(await listBillableSubscriptionIds('external_customer_id', userID));
    if (user.polar_sh_customer_id) {
        for (const id of await listBillableSubscriptionIds('customer_id', user.polar_sh_customer_id)) ids.add(id);
    }

    for (const id of ids) {
        const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
        try {
            await polarRequest(path, { method: 'DELETE' });
        } catch (revokeError) {
            // A concurrent cancel may already have ended it; only fail if it can still bill.
            const current = await polarRequest<{ status?: string }>(path, { method: 'GET' });
            if (!current.status || BILLABLE_STATUSES.has(current.status)) {
                throw revokeError;
            }
        }
    }

    return ids.size;
}
