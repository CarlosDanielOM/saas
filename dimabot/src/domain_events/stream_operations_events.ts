import type { DomainEventEnvelope } from './domain_event.types.js';

interface OperationResult {
    error?: boolean;
    message?: string;
    type?: string;
}

export interface StreamOperationsDependencies {
    loadChannelTimersIntoCache(channelID: string): Promise<void>;
    unloadChannelTimersFromCache(channelID: string): Promise<void>;
    getChannelEditors(channelID: string, cache: boolean): Promise<OperationResult>;
    loadChannelAdminsIntoCache(channelID: string): Promise<void>;
    unVIPExpiredUser(eventData: { broadcaster_user_id: string; broadcaster_user_login: string }): Promise<OperationResult | undefined>;
    resetRedemptionCost(channelID: string): Promise<OperationResult>;
    resetSumimetro(channelID: string): Promise<void>;
    clearChannelCache(channelID: string): Promise<void>;
    clearSpeechFiles(channelID: string): Promise<void>;
    clearHistory(channelID: string): Promise<void>;
    hasNewerLifecycleEvent(event: DomainEventEnvelope): Promise<boolean>;
    getAuthSkipReason(channelID: string): Promise<string | null>;
    readProgress(event: DomainEventEnvelope): Promise<Record<string, StepOutcome>>;
    writeProgress(event: DomainEventEnvelope, step: string, outcome: StepOutcome): Promise<void>;
}

export interface StepOutcome {
    status: 'completed' | 'skipped' | 'failed';
    reason?: string;
    at: Date;
}

let dependenciesPromise: Promise<StreamOperationsDependencies> | null = null;

async function getDependencies(): Promise<StreamOperationsDependencies> {
    dependenciesPromise ||= Promise.all([
        import('../classes/chat_history.js'),
        import('../functions/channels/get_editors.channel.js'),
        import('../functions/redemptions/resetredemptioncost.redemption.js'),
        import('../functions/redemptions/unvipexpired.redemption.js'),
        import('../schemas/domain_event.schema.js'),
        import('../schemas/stream_operations_receipt.schema.js'),
        import('../schemas/users.schema.js'),
        import('../utils/cache.js'),
        import('../utils/speech.js'),
        import('../utils/timer_cache.js')
    ]).then(([
        { default: ChatHistory },
        { getChannelEditors },
        { resetRedemptionCost },
        { unVIPExpiredUser },
        { DomainEventSchema },
        { StreamOperationsReceipt },
        { default: UsersSchema },
        { clearChannelCache, loadChannelAdminsIntoCache, resetSumimetro },
        { clearSpeechFiles },
        { loadChannelTimersIntoCache, unloadChannelTimersFromCache }
    ]) => ({
        loadChannelTimersIntoCache,
        unloadChannelTimersFromCache,
        getChannelEditors,
        loadChannelAdminsIntoCache,
        unVIPExpiredUser,
        resetRedemptionCost,
        resetSumimetro,
        clearChannelCache,
        clearSpeechFiles,
        clearHistory: (channelID) => ChatHistory.clearHistory(channelID),
        async getAuthSkipReason(channelID) {
            // Bypass the account cache: its errors are deliberately collapsed to null.
            const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } })
                .select('accounts.type accounts.id accounts.actived accounts.has_permissions').lean();
            const account = user?.accounts.find(a => a.type === 'twitch' && a.id === channelID);
            if (!account) throw new Error(`Twitch account ${channelID} not found`);
            if (account.actived === false) return 'account_deactivated';
            if (account.has_permissions === false) return 'permissions_disabled';
            return null;
        },
        async readProgress(event) {
            const row = await StreamOperationsReceipt.findById(event.eventKey).lean();
            return Object.fromEntries(row?.steps instanceof Map ? row.steps : Object.entries(row?.steps || {})) as Record<string, StepOutcome>;
        },
        async writeProgress(event, step, outcome) {
            await StreamOperationsReceipt.updateOne({ _id: event.eventKey }, {
                $setOnInsert: { channelID: event.channelID, expiresAt: event.expiresAt },
                $set: { [`steps.${step}`]: outcome }
            }, { upsert: true, writeConcern: { w: 1, j: true } });
        },
        async hasNewerLifecycleEvent(event) {
            const newerEvent = await DomainEventSchema.exists({
                channelID: event.channelID,
                source: { $ne: 'twitch-eventsub-test' },
                type: { $in: ['stream.started', 'stream.ended'] },
                $or: [
                    { occurredAt: { $gt: event.occurredAt } },
                    { occurredAt: event.occurredAt, _id: { $gt: event._id } }
                ]
            });
            return Boolean(newerEvent);
        }
    }));
    return dependenciesPromise;
}

function payloadEvent(event: DomainEventEnvelope): Record<string, unknown> {
    const value = event.payload.event;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

class StreamAuthorizationRequiredError extends Error {}

function requireSuccessful(result: OperationResult | undefined, benignTypes: string[], operation: string): void {
    if (!result?.error || (result.type && benignTypes.includes(result.type))) return;
    const message = `${operation} failed: ${result.message || result.type || 'unknown error'}`;
    if (result.type === 'auth_required') throw new StreamAuthorizationRequiredError(message);
    throw new Error(message);
}

export async function applyStreamOperationsDomainEvent(
    event: DomainEventEnvelope,
    injectedOperations?: StreamOperationsDependencies
): Promise<void> {
    if (event.source === 'twitch-eventsub-test') return;
    if (event.type !== 'stream.started' && event.type !== 'stream.ended') return;

    const rawEvent = payloadEvent(event);
    const channelID = event.channelID;
    if (!channelID) throw new Error('Stream operations require a channel identity');
    const operations = injectedOperations || await getDependencies();
    if (await operations.hasNewerLifecycleEvent(event)) return;
    const progress = await operations.readProgress(event);
    const failures: string[] = [];
    const steps: Array<{ name: string; twitch?: boolean; run: () => Promise<void> }> = event.type === 'stream.started'
        ? [
            { name: 'timers', run: () => operations.loadChannelTimersIntoCache(channelID) },
            { name: 'editors', twitch: true, run: async () => requireSuccessful(await operations.getChannelEditors(channelID, true), [], 'Reconciling channel editors') },
            { name: 'admins', run: () => operations.loadChannelAdminsIntoCache(channelID) },
            { name: 'vips', twitch: true, run: async () => requireSuccessful(await operations.unVIPExpiredUser({ broadcaster_user_id: channelID, broadcaster_user_login: String(rawEvent.broadcaster_user_login || '') }), ['no_vips_found'], 'Removing expired VIPs') }
        ] : [
            { name: 'timers', run: () => operations.unloadChannelTimersFromCache(channelID) },
            { name: 'rewards', twitch: true, run: async () => requireSuccessful(await operations.resetRedemptionCost(channelID), ['channel_not_premium', 'no_rewards_found'], 'Resetting redemption costs') },
            { name: 'sumimetro', run: () => operations.resetSumimetro(channelID) },
            { name: 'channel_cache', run: () => operations.clearChannelCache(channelID) },
            { name: 'speech', run: () => operations.clearSpeechFiles(channelID) },
            { name: 'history', run: () => operations.clearHistory(channelID) },
            { name: 'editors', twitch: true, run: async () => requireSuccessful(await operations.getChannelEditors(channelID, true), [], 'Reconciling channel editors') },
            { name: 'admins', run: () => operations.loadChannelAdminsIntoCache(channelID) }
        ];

    for (const step of steps) {
        if (progress[step.name]?.status === 'completed' || progress[step.name]?.status === 'skipped') continue;
        // A retry or earlier failed step can overlap a newer journaled transition.
        if (await operations.hasNewerLifecycleEvent(event)) return;
        let outcome: StepOutcome;
        try {
            const reason = step.twitch ? await operations.getAuthSkipReason(channelID) : null;
            if (reason) outcome = { status: 'skipped', reason, at: new Date() };
            else {
                await step.run();
                outcome = { status: 'completed', at: new Date() };
            }
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 8000);
            let skipReason: string | null = error instanceof StreamAuthorizationRequiredError ? `auth_required: ${message}` : null;
            if (step.twitch && !skipReason) {
                // Refresh can revoke permissions while an operation is running. Only
                // authoritative persisted flags turn a generic failure into a skip.
                try { skipReason = await operations.getAuthSkipReason(channelID); } catch { /* preserve original failure */ }
            }
            outcome = skipReason ? { status: 'skipped', reason: skipReason, at: new Date() } : { status: 'failed', reason: message, at: new Date() };
            if (!skipReason) failures.push(`${step.name}: ${message}`);
        }
        // A failed receipt write must fail delivery; a successful effect may repeat if its
        // acknowledgement was lost, as with all external at-least-once effects.
        await operations.writeProgress(event, step.name, outcome);
    }
    if (failures.length) throw new Error(failures.join('; '));
}

/** Schedule current-state reconciliation after authorization; never replay old transitions. */
export async function enqueueStreamOperationsReconciliation(channelID: string): Promise<void> {
    const { StreamOperationsReconciliation } = await import('../schemas/stream_operations_receipt.schema.js');
    await StreamOperationsReconciliation.updateOne({ _id: channelID }, {
        $inc: { revision: 1 }, $set: { pending: true, nextAttemptAt: new Date() }
    }, { upsert: true, writeConcern: { w: 1, j: true } });
}

async function currentStreamIsLive(channelID: string): Promise<boolean> {
    const [{ executeHelixAppRequestWith401Retry }, { getTwitchHelixUrl }] = await Promise.all([
        import('../utils/twitch_helix_retry.js'), import('../utils/links.js')
    ]);
    const url = getTwitchHelixUrl('streams', new URLSearchParams({ user_id: channelID }).toString());
    const result = await executeHelixAppRequestWith401Retry({
        operation: 'reconcile_current_stream', requestUrl: url, requestMethod: 'GET',
        executeRequest: headers => fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    });
    if (result.error || !result.response?.ok) throw new Error(result.message || `Twitch streams lookup failed (${result.response?.status})`);
    const body = await result.response.json() as { data?: unknown[] };
    if (!Array.isArray(body.data)) throw new Error('Invalid Twitch streams response');
    return body.data.length > 0;
}

export async function reconcileCurrentStreamOperations(
    channelID: string, revision: number,
    injected?: { operations: StreamOperationsDependencies; currentStreamIsLive(channelID: string): Promise<boolean> }
): Promise<void> {
    const operations = injected?.operations || await getDependencies();
    const liveLookup = injected?.currentStreamIsLive || currentStreamIsLive;
    const event = {
        eventKey: `reauth:${channelID}:${revision}`, channelID,
        expiresAt: new Date(Date.now() + 90 * 86400000)
    } as DomainEventEnvelope;
    const progress = await operations.readProgress(event);
    const failures: string[] = [];
    const run = async (name: string, twitch: boolean, effect: () => Promise<void>) => {
        if (progress[name]?.status === 'completed' || progress[name]?.status === 'skipped') return;
        let outcome: StepOutcome;
        try {
            const reason = twitch ? await operations.getAuthSkipReason(channelID) : null;
            if (reason) outcome = { status: 'skipped', reason, at: new Date() };
            else { await effect(); outcome = { status: 'completed', at: new Date() }; }
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 8000);
            let skipReason: string | null = error instanceof StreamAuthorizationRequiredError ? `auth_required: ${message}` : null;
            if (twitch && !skipReason) {
                try { skipReason = await operations.getAuthSkipReason(channelID); } catch { /* preserve original failure */ }
            }
            outcome = skipReason ? { status: 'skipped', reason: skipReason, at: new Date() } : { status: 'failed', reason: message, at: new Date() };
            if (!skipReason) failures.push(`${name}: ${message}`);
        }
        await operations.writeProgress(event, name, outcome);
    };
    await run('admins', false, () => operations.loadChannelAdminsIntoCache(channelID));
    await run('editors', true, async () => requireSuccessful(await operations.getChannelEditors(channelID, true), [], 'Reconciling channel editors'));
    try {
        // Determine state afresh on each attempt, including after a transition while
        // an unrelated step was failing; never replay the old lifecycle event.
        const reason = await operations.getAuthSkipReason(channelID);
        if (reason) {
            if (progress.stream?.status !== 'skipped') await operations.writeProgress(event, 'stream', { status: 'skipped', reason, at: new Date() });
        } else {
        const live = await liveLookup(channelID);
        await run(live ? 'vips' : 'rewards', true, async () => {
            if (live) requireSuccessful(await operations.unVIPExpiredUser({ broadcaster_user_id: channelID, broadcaster_user_login: '' }), ['no_vips_found'], 'Removing expired VIPs');
            else requireSuccessful(await operations.resetRedemptionCost(channelID), ['channel_not_premium', 'no_rewards_found'], 'Resetting redemption costs');
        });
        }
    } catch (error) { failures.push(`stream: ${(error instanceof Error ? error.message : String(error)).slice(0, 8000)}`); }
    if (failures.length) throw new Error(failures.join('; ').slice(0, 8000));
}

/** Process at most ten requests per pass; revision and lease fence acknowledgement. */
export async function recoverStreamOperationsReconciliations(): Promise<void> {
    const [{ StreamOperationsReconciliation }, { randomUUID }] = await Promise.all([
        import('../schemas/stream_operations_receipt.schema.js'), import('node:crypto')
    ]);
    for (let count = 0; count < 10; count++) {
        const now = new Date();
        const token = randomUUID();
        const row = await StreamOperationsReconciliation.findOneAndUpdate({
            pending: true, nextAttemptAt: { $lte: now },
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }]
        }, { $set: { leaseToken: token, leaseUntil: new Date(now.getTime() + 300000) } },
        { new: true, sort: { nextAttemptAt: 1 }, writeConcern: { w: 1, j: true } }).lean();
        if (!row) break;
        let failure: string | undefined;
        try { await reconcileCurrentStreamOperations(row._id, row.revision); }
        catch (error) { failure = (error instanceof Error ? error.message : String(error)).slice(0, 8000); }
        const match = { _id: row._id, revision: row.revision, leaseToken: token, leaseUntil: { $gt: new Date() } };
        if (failure) {
            await StreamOperationsReconciliation.updateOne(match, {
                $set: { lastError: failure, nextAttemptAt: new Date(Date.now() + 60000) }, $unset: { leaseToken: 1, leaseUntil: 1 }
            }, { writeConcern: { w: 1, j: true } });
        } else {
            await StreamOperationsReconciliation.updateOne(match, {
                $set: { pending: false }, $unset: { leaseToken: 1, leaseUntil: 1, lastError: 1 }
            }, { writeConcern: { w: 1, j: true } });
        }
        await StreamOperationsReconciliation.updateOne({ _id: row._id, leaseToken: token },
            { $unset: { leaseToken: 1, leaseUntil: 1 } }, { writeConcern: { w: 1, j: true } });
    }
}
