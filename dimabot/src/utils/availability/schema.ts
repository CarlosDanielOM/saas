import { randomUUID } from 'node:crypto';
import { Schema } from 'mongoose';

export interface AvailabilityState {
    token: string;
    previousEnabled: boolean;
    restoreAt: Date | null;
    pending: boolean;
    nextAt: Date;
}
export const INTERNAL_AVAILABILITY_WRITE = Symbol('internalAvailabilityWrite');
export function internalWrite<T>(query: T): T {
    (query as any)[INTERNAL_AVAILABILITY_WRITE] = true;
    return query;
}
export function availabilityState(previousEnabled: boolean, restoreAt: Date | null = null): AvailabilityState {
    return { token: randomUUID(), previousEnabled, restoreAt, pending: true, nextAt: new Date() };
}

/** Ordinary edits replace any scheduled restoration, including same-value edits.
 * Scheduling and worker writes explicitly mark their queries as internal.
 * Metadata stays out of normal API/cache documents and cannot be set by clients.
 */
export function addAvailabilityFields(schema: Schema<any>, enabledField: string): void {
    const state = new Schema({ token: String, previousEnabled: Boolean, restoreAt: Date,
        pending: Boolean, nextAt: Date }, { _id: false });
    schema.add({ availability: { type: state, default: undefined, select: false },
        availabilityLease: { type: new Schema({ token: String, until: Date }, { _id: false }), default: undefined, select: false } });
    schema.index({ 'availability.nextAt': 1 }, { sparse: true });
    for (const operation of ['updateOne', 'findOneAndUpdate', 'updateMany'] as const) {
        schema.pre(operation, function () {
            if ((this as any)[INTERNAL_AVAILABILITY_WRITE]) return;
            const update = this.getUpdate() as any;
            if (!update || Array.isArray(update)) return;
            for (const container of [update, update.$set, update.$unset, update.$setOnInsert]) {
                if (!container) continue;
                for (const key of Object.keys(container)) {
                    if (/^availability(?:Lease)?(?:\.|$)/.test(key)) delete container[key];
                }
            }
            const enabled = update.$set?.[enabledField] ?? update[enabledField];
            if (enabled !== undefined) {
                update.$set ??= {};
                update.$set.availability = availabilityState(Boolean(enabled));
            }
        });
    }
    schema.pre('save', function () {
        if (!this.isNew && this.isModified(enabledField)) {
            this.set('availability', availabilityState(Boolean(this.get(enabledField))));
        }
    });
}
