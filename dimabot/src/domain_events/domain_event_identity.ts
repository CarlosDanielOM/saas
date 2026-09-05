import UsersSchema from '../schemas/users.schema.js';
import type { DomainEventSubject } from './domain_event.types.js';

/** The source adapter must supply a provider-verified external customer ID, never arbitrary user input. */
export async function resolveDomainEventOwner(
    subject: DomainEventSubject,
    externalOwnerId?: string,
    legacyTwitchChannelId?: string
): Promise<string | undefined> {
    if (subject.kind === 'streaming-account') {
        const user = await UsersSchema.findOne({
            accounts: { $elemMatch: { type: subject.provider, id: subject.id } }
        }).select('_id').lean();
        return user?._id.toString();
    }

    if (subject.kind === 'customer' && subject.provider === 'polar') {
        const linkedUser = await UsersSchema.findOne({
            polar_sh_customer_id: subject.id
        }).select('_id').lean();
        if (linkedUser) return linkedUser._id.toString();

        if (externalOwnerId && /^[a-f\d]{24}$/i.test(externalOwnerId)) {
            const user = await UsersSchema.findById(externalOwnerId)
                .select('_id polar_sh_customer_id').lean();
            if (user) {
                return !user.polar_sh_customer_id || user.polar_sh_customer_id === subject.id
                    ? user._id.toString() : undefined;
            }
            return undefined;
        }
        if (legacyTwitchChannelId) {
            const user = await UsersSchema.findOne({
                accounts: { $elemMatch: { type: 'twitch', id: legacyTwitchChannelId } },
                $or: [{ polar_sh_customer_id: null }, { polar_sh_customer_id: '' }, { polar_sh_customer_id: subject.id }]
            }).select('_id').lean();
            return user?._id.toString();
        }
        return undefined;
    }

    // Integrations and other providers need adapter-specific lookups; never infer ownership from channelID.
    return undefined;
}
