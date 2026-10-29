export const AI_USAGE_REPORT_VERSION = 3;

export interface AiUsageLedgerStatus {
    status: 'ready' | 'pending';
    coverageStart: string | null;
    lastSyncedAt: string | null;
    requestedCoverageStart: string;
}

export async function hasAiUsageLedgerCoverage(input: {
    channelID: string;
    customerId: string;
    startsAt: Date;
}): Promise<boolean> {
    return Boolean(await AiUsageLedgerStateSchema.exists({
        channelID: input.channelID,
        customerId: input.customerId,
        coverageStart: { $lte: input.startsAt },
        reportVersion: { $gte: AI_USAGE_REPORT_VERSION }
    }));
}

export async function getAiUsageLedgerStatus(input: {
    channelID: string;
    customerId: string;
    startsAt: Date;
}): Promise<AiUsageLedgerStatus> {
    const state = await AiUsageLedgerStateSchema.findOne({
        channelID: input.channelID,
        customerId: input.customerId
    }).select('coverageStart backfilledAt reportVersion').lean().exec();
    const ready = Boolean(state && state.coverageStart.getTime() <= input.startsAt.getTime()
        && (state.reportVersion || 0) >= AI_USAGE_REPORT_VERSION);
    return {
        status: ready ? 'ready' : 'pending',
        coverageStart: state?.coverageStart?.toISOString() || null,
        lastSyncedAt: state?.backfilledAt?.toISOString() || null,
        requestedCoverageStart: input.startsAt.toISOString()
    };
}

export async function getAiUsageLedgerState(input: {
    channelID: string;
    customerId: string;
}): Promise<{ coverageStart: Date; backfilledAt: Date; reportVersion: number } | null> {
    const state = await AiUsageLedgerStateSchema.findOne({ channelID: input.channelID, customerId: input.customerId })
        .select('coverageStart backfilledAt reportVersion').lean().exec();
    return state ? { coverageStart: state.coverageStart, backfilledAt: state.backfilledAt, reportVersion: state.reportVersion || 0 } : null;
}
