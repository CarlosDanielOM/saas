import { randomUUID } from 'node:crypto';
import { DomainEventPrerequisiteMissingError } from '../domain_events/domain_event.types.js';
import { Types, type FilterQuery } from 'mongoose';
import type {
    DomainEventEnvelope,
    DomainEventHandler,
    DomainEventTopic
} from '../domain_events/domain_event.types.js';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';
import {
    DomainEventDeliverySchema,
    type IDomainEventDelivery
} from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema, type IDomainEvent } from '../schemas/domain_event.schema.js';
import { error as logError, info as logInfo, warn as logWarn } from './logger.js';

export interface DomainEventExecutionLease {
    eventKey: string;
    leaseToken: string;
    lockedUntil: number;
}

export interface DomainEventConsumerRuntime {
    shouldStop?(): boolean;
    beforeClaim?(eventKey: string): void;
    claimed?(lease: DomainEventExecutionLease): void;
    renewed?(lease: DomainEventExecutionLease): void;
    // The isolated worker terminates synchronously here, not just the awaiting promise.
    leaseLost?(error: Error): void;
    finished?(): void;
}

export interface DomainEventConsumerOptions {
    consumer: string;
    topics: DomainEventTopic[];
    handler: DomainEventHandler;
    // Restricts new journal scans; existing deliveries keep their retry ownership.
    eventFilter?: FilterQuery<IDomainEvent>;
    schemaVersions?: readonly number[];
    batchSize?: number;
    maxAttempts?: number;
    leaseMs?: number;
    runtime?: DomainEventConsumerRuntime;
}

export interface DomainEventDrainResult {
    ready: number;
    scanned: number;
    succeeded: number;
    retried: number;
    dead: number;
    deferred: number;
}

type DeliveryOutcome = 'succeeded' | 'retry' | 'dead' | 'deferred' | 'retry-scheduled' | 'already-complete';

const RETRY_DELAYS_MS = [5_000, 30_000, 5 * 60_000, 30 * 60_000] as const;
const PREREQUISITE_HORIZON_MS = 24 * 60 * 60_000;
const PREREQUISITE_RETRY_MS = 30_000;

function normalizeRequired(value: unknown, field: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error(`Domain event consumer ${field} is required`);
    }
    return normalized;
}

function toEnvelope(event: IDomainEvent): DomainEventEnvelope {
    return {
        _id: event._id,
        eventKey: event.eventKey,
        source: event.source,
        sourceEventId: event.sourceEventId,
        type: event.type,
        topic: event.topic,
        schemaVersion: event.schemaVersion,
        ownerUserId: event.ownerUserId,
        subject: event.subject,
        channelID: event.channelID,
        streamID: event.streamID,
        occurredAt: event.occurredAt,
        journaledAt: event.journaledAt,
        payload: event.payload,
        metadata: event.metadata,
        expiresAt: event.expiresAt
    };
}

async function ensureDelivery(consumer: string, event: IDomainEvent): Promise<IDomainEventDelivery> {
    try {
        return await DomainEventDeliverySchema.findOneAndUpdate({
            consumer,
            eventKey: event.eventKey
        }, {
            $setOnInsert: {
                consumer,
                topic: event.topic,
                eventID: event._id,
                eventKey: event.eventKey,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: null,
                lockedUntil: null,
                leaseToken: null,
                lastError: '',
                lastDeadLetterError: '',
                firstAttemptAt: null,
                completedAt: null,
                deadLetteredAt: null,
                replayCount: 0,
                lastReplayedAt: null,
                expiresAt: event.expiresAt
            }
        }, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
            writeConcern: { w: 1, j: true }
        });
    } catch (error) {
        if (Number((error as { code?: unknown })?.code) !== 11000) throw error;
        const existing = await DomainEventDeliverySchema.findOne({ consumer, eventKey: event.eventKey });
        if (!existing) throw error;
        return existing;
    }
}

async function claimDelivery(
    delivery: IDomainEventDelivery,
    leaseMs: number,
    maxAttempts: number
): Promise<IDomainEventDelivery | null> {
    const now = new Date();
    const leaseToken = randomUUID();
    if (delivery.status === 'succeeded' || delivery.status === 'dead') {
        return null;
    }
    if (delivery.status === 'processing' && delivery.lockedUntil && delivery.lockedUntil > now) {
        return null;
    }
    if (delivery.status === 'retry' && delivery.nextAttemptAt && delivery.nextAttemptAt > now) {
        return null;
    }

    return DomainEventDeliverySchema.findOneAndUpdate({
        _id: delivery._id,
        status: { $in: ['pending', 'processing', 'retry'] },
        attempts: { $lt: maxAttempts },
        $and: [
            { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
            { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }
        ]
    }, {
        $set: {
            status: 'processing',
            lockedUntil: new Date(now.getTime() + leaseMs),
            leaseToken,
            nextAttemptAt: null,
            firstAttemptAt: delivery.firstAttemptAt || now
        },
        $inc: { attempts: 1 }
    }, { new: true });
}

async function processDelivery(
    consumer: string,
    event: IDomainEvent,
    handler: DomainEventHandler,
    maxAttempts: number,
    leaseMs: number,
    runtime?: DomainEventConsumerRuntime
): Promise<DeliveryOutcome> {
    if (runtime?.shouldStop?.()) return 'deferred';
    runtime?.beforeClaim?.(event.eventKey);
    try {
        const delivery = await ensureDelivery(consumer, event);
        if (delivery.status === 'succeeded' || delivery.status === 'dead') {
            return 'already-complete';
        }

        // A crashed attempt cannot record its failure. Retire an expired final attempt
        // without claiming again, and fence the claim itself against stale snapshots.
        if (delivery.attempts >= maxAttempts) {
            const now = new Date();
            const exhausted = await DomainEventDeliverySchema.updateOne({
                _id: delivery._id,
                status: { $in: ['pending', 'processing', 'retry'] },
                attempts: { $gte: maxAttempts },
                $and: [
                    { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
                    { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }
                ]
            }, {
                $set: {
                    status: 'dead', deadLetteredAt: now, lockedUntil: null,
                    leaseToken: null, nextAttemptAt: null,
                    lastError: 'Attempt limit exhausted after interrupted execution',
                    lastDeadLetterError: 'Attempt limit exhausted after interrupted execution'
                }
            });
            return exhausted.modifiedCount > 0 ? 'dead' : 'deferred';
        }

        let lockedUntil = Date.now() + leaseMs;
        const claimed = await claimDelivery(delivery, leaseMs, maxAttempts);
        if (!claimed) {
            // The durable retry owns this work, including after a lost deferral response.
            return delivery.status === 'retry' ? 'retry-scheduled' : 'deferred';
        }

        let lost: Error | undefined;
        let renewal: Promise<void> | undefined;
        const loseLease = (error: unknown): void => {
            if (lost) return;
            lost = error instanceof Error ? error : new Error(String(error));
            runtime?.leaseLost?.(lost);
        };
        const assertLease = (): void => {
            if (Date.now() >= lockedUntil) loseLease(new Error('Domain event execution lease expired'));
            if (lost) throw lost;
        };
        const lease = (): DomainEventExecutionLease => ({
            eventKey: event.eventKey, leaseToken: claimed.leaseToken!, lockedUntil
        });
        const heartbeat = setInterval(() => {
            if (renewal || lost) return;
            renewal = (async () => {
                assertLease();
                const renewalStartedAt = Date.now();
                const result = await DomainEventDeliverySchema.updateOne({
                    _id: claimed._id,
                    status: 'processing',
                    leaseToken: claimed.leaseToken,
                    lockedUntil: { $gt: new Date(renewalStartedAt) }
                }, {
                    $set: { lockedUntil: new Date(renewalStartedAt + leaseMs) }
                });
                assertLease();
                if (result.modifiedCount === 0) throw new Error('Domain event execution lease renewal lost ownership');
                lockedUntil = renewalStartedAt + leaseMs;
                runtime?.renewed?.(lease());
            })().catch(loseLease).finally(() => { renewal = undefined; });
        }, Math.max(1_000, Math.floor(leaseMs / 3)));
        heartbeat.unref?.();

        try {
            assertLease();
            runtime?.claimed?.(lease());
            assertLease();
            if (runtime?.shouldStop?.()) return 'deferred';
            await handler(toEnvelope(event));
            clearInterval(heartbeat);
            await renewal;
            assertLease();
            const completion = await DomainEventDeliverySchema.updateOne({
                _id: claimed._id,
                status: 'processing',
                leaseToken: claimed.leaseToken,
                lockedUntil: { $gt: new Date() }
            }, {
                $set: {
                    status: 'succeeded',
                    completedAt: new Date(),
                    lockedUntil: null,
                    leaseToken: null,
                    nextAttemptAt: null,
                    lastError: '',
                    lastDeadLetterError: ''
                }
            });
            if (completion.modifiedCount === 0) {
                loseLease(new Error('Domain event completion lost ownership'));
                return 'deferred';
            }
            return 'succeeded';
        } catch (error) {
            clearInterval(heartbeat);
            await renewal;
            assertLease();
            const prerequisiteMissing = error instanceof DomainEventPrerequisiteMissingError;
            const now = Date.now();
            const prerequisiteDeadline = prerequisiteMissing ? Math.min(
                new Date(event.journaledAt).getTime() + PREREQUISITE_HORIZON_MS,
                new Date(event.expiresAt).getTime()
            ) : 0;
            const exhausted = prerequisiteMissing
                ? !Number.isFinite(prerequisiteDeadline) || now >= prerequisiteDeadline
                : claimed.attempts >= maxAttempts;
            const errorMessage = prerequisiteMissing && exhausted
                ? `Prerequisite horizon exceeded: ${error.prerequisite}`
                : error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            const nextAttemptAt = prerequisiteMissing
                ? Math.min(now + PREREQUISITE_RETRY_MS, prerequisiteDeadline)
                : now + RETRY_DELAYS_MS[Math.min(claimed.attempts - 1, RETRY_DELAYS_MS.length - 1)];

            const failure = await DomainEventDeliverySchema.updateOne({
                _id: claimed._id,
                status: 'processing',
                leaseToken: claimed.leaseToken,
                lockedUntil: { $gt: new Date() }
            }, {
                $set: {
                    status: exhausted ? 'dead' : 'retry',
                    nextAttemptAt: exhausted ? null : new Date(nextAttemptAt),
                    lockedUntil: null,
                    leaseToken: null,
                    lastError: errorMessage.slice(0, 8_000),
                    lastDeadLetterError: exhausted ? errorMessage.slice(0, 8_000) : claimed.lastDeadLetterError,
                    deadLetteredAt: exhausted ? new Date() : null
                },
                ...(prerequisiteMissing ? { $inc: { attempts: -1 } } : {})
            }, { writeConcern: { w: 1, j: true } });
            if (failure.modifiedCount === 0) {
                loseLease(new Error('Domain event failure update lost ownership'));
                return 'deferred';
            }

            const logPayload = {
                worker: consumer,
                function: 'processDomainEventDelivery',
                eventKey: event.eventKey,
                eventType: event.type,
                attempts: claimed.attempts,
                maxAttempts,
                exhausted,
                error: error instanceof Error ? error.message : String(error)
            };
            if (exhausted) {
                await logError(logPayload, { channelId: event.channelID, destination: 'console' });
                return 'dead';
            }
            await logWarn(logPayload, { channelId: event.channelID, destination: 'console' });
            return prerequisiteMissing ? 'retry-scheduled' : 'retry';
        } finally {
            clearInterval(heartbeat);
        }
    } finally {
        runtime?.finished?.();
    }
}

async function advanceCheckpoint(consumer: string, topic: DomainEventTopic, event: IDomainEvent): Promise<void> {
    await DomainEventCheckpointSchema.updateOne({ consumer, topic }, {
        $max: { lastEventID: event._id },
        $setOnInsert: { consumer, topic }
    }, {
        upsert: true,
        setDefaultsOnInsert: true
    });
}

function applyOutcome(result: DomainEventDrainResult, outcome: DeliveryOutcome): void {
    if (outcome === 'succeeded' || outcome === 'already-complete') result.succeeded += 1;
    if (outcome === 'retry') result.retried += 1;
    if (outcome === 'dead') result.dead += 1;
    if (outcome === 'deferred' || outcome === 'retry-scheduled') result.deferred += 1;
}

export async function dispatchDomainEvents(
    consumers: readonly DomainEventConsumerOptions[],
    batchSize = 100
): Promise<number> {
    const events = await DomainEventSchema.find({ dispatchPending: true })
        .sort({ _id: 1 }).limit(Math.max(1, Math.min(500, batchSize)));
    if (events.length === 0) return 0;
    await DomainEventDeliverySchema.init();
    const eventIDs = events.map((event) => event._id);
    for (const consumer of consumers) {
        const matching = await DomainEventSchema.find({
            ...consumer.eventFilter,
            topic: { $in: consumer.topics },
            _id: { $in: eventIDs }
        }).select('_id').lean();
        const matchingIDs = new Set(matching.map((event) => String(event._id)));
        for (const event of events) {
            if (matchingIDs.has(String(event._id))) await ensureDelivery(consumer.consumer, event);
        }
    }
    // The marker is part of the journal insert. Clear it only after every delivery
    // exists, so a crash or an out-of-order insert cannot strand an acknowledged event.
    await DomainEventSchema.updateMany({ _id: { $in: eventIDs }, dispatchPending: true }, {
        $set: { dispatchPending: false }
    }, { writeConcern: { w: 1, j: true } });
    return events.length;
}

export async function drainDomainEvents(options: DomainEventConsumerOptions): Promise<DomainEventDrainResult> {
    const consumer = normalizeRequired(options.consumer, 'name');
    const batchSize = Math.max(1, Math.min(500, Number(options.batchSize || 100)));
    const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));
    const leaseMs = Math.max(5_000, Number(options.leaseMs || 60_000));
    const handler: DomainEventHandler = async (event) => {
        if (options.schemaVersions && !options.schemaVersions.includes(event.schemaVersion)) {
            throw new Error(`Unsupported schema version ${event.schemaVersion} for ${consumer}`);
        }
        await options.handler(event);
    };
    const result: DomainEventDrainResult = {
        ready: 0,
        scanned: 0,
        succeeded: 0,
        retried: 0,
        dead: 0,
        deferred: 0
    };

    const readyDeliveries = await DomainEventDeliverySchema.find({
        consumer,
        topic: { $in: options.topics },
        $or: [
            { status: 'pending' },
            { status: 'retry', nextAttemptAt: { $lte: new Date() } },
            { status: 'processing', $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] }
        ]
    }).sort({ updatedAt: 1, _id: 1 }).limit(batchSize).lean();
    result.ready = readyDeliveries.length;

    for (const delivery of readyDeliveries) {
        if (options.runtime?.shouldStop?.()) break;
        const event = await DomainEventSchema.findById(delivery.eventID);
        if (!event) {
            await DomainEventDeliverySchema.updateOne({
                _id: delivery._id, status: delivery.status, leaseToken: delivery.leaseToken
            }, {
                $set: {
                    status: 'dead',
                    deadLetteredAt: new Date(),
                    nextAttemptAt: null,
                    lockedUntil: null,
                    leaseToken: null,
                    lastError: 'Journal event expired or was removed before delivery'
                }
            });
            result.dead += 1;
            continue;
        }
        applyOutcome(result, await processDelivery(consumer, event, handler, maxAttempts, leaseMs, options.runtime));
    }

    for (const topic of options.topics) {
        if (options.runtime?.shouldStop?.()) break;
        const checkpoint = await DomainEventCheckpointSchema.findOne({ consumer, topic }).lean();
        const lastEventID = checkpoint?.lastEventID || new Types.ObjectId('000000000000000000000000');
        const events = await DomainEventSchema.find({
            ...options.eventFilter,
            topic,
            _id: { $gt: lastEventID }
        }).sort({ _id: 1 }).limit(batchSize);

        for (const event of events) {
            if (options.runtime?.shouldStop?.()) break;
            result.scanned += 1;
            const outcome = await processDelivery(consumer, event, handler, maxAttempts, leaseMs, options.runtime);
            applyOutcome(result, outcome);

            if (outcome === 'deferred') {
                break;
            }
            await advanceCheckpoint(consumer, topic, event);
        }
    }

    if (result.ready > 0 || result.scanned > 0 || result.retried > 0 || result.dead > 0) {
        await logInfo({
            worker: consumer,
            message: 'Domain event drain completed',
            ...result
        }, { destination: 'console' });
    }

    return result;
}

export async function replayDeadDomainEvent(consumer: string, eventKey: string): Promise<boolean> {
    const result = await DomainEventDeliverySchema.updateOne({
        consumer: normalizeRequired(consumer, 'name'),
        eventKey: normalizeRequired(eventKey, 'eventKey'),
        status: 'dead'
    }, {
        $set: {
            status: 'retry',
            attempts: 0,
            nextAttemptAt: new Date(),
            lockedUntil: null,
            leaseToken: null,
            lastError: '',
            lastDeadLetterError: '',
            deadLetteredAt: null,
            completedAt: null,
            lastReplayedAt: new Date()
        },
        $inc: { replayCount: 1 }
    });
    return result.modifiedCount > 0;
}
