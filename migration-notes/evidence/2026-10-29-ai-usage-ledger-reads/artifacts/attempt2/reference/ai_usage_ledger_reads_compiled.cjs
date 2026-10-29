"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_USAGE_REPORT_VERSION = void 0;
exports.hasAiUsageLedgerCoverage = hasAiUsageLedgerCoverage;
exports.getAiUsageLedgerStatus = getAiUsageLedgerStatus;
exports.getAiUsageLedgerState = getAiUsageLedgerState;
exports.AI_USAGE_REPORT_VERSION = 3;
async function hasAiUsageLedgerCoverage(input) {
    return Boolean(await AiUsageLedgerStateSchema.exists({
        channelID: input.channelID,
        customerId: input.customerId,
        coverageStart: { $lte: input.startsAt },
        reportVersion: { $gte: exports.AI_USAGE_REPORT_VERSION }
    }));
}
async function getAiUsageLedgerStatus(input) {
    const state = await AiUsageLedgerStateSchema.findOne({
        channelID: input.channelID,
        customerId: input.customerId
    }).select('coverageStart backfilledAt reportVersion').lean().exec();
    const ready = Boolean(state && state.coverageStart.getTime() <= input.startsAt.getTime()
        && (state.reportVersion || 0) >= exports.AI_USAGE_REPORT_VERSION);
    return {
        status: ready ? 'ready' : 'pending',
        coverageStart: state?.coverageStart?.toISOString() || null,
        lastSyncedAt: state?.backfilledAt?.toISOString() || null,
        requestedCoverageStart: input.startsAt.toISOString()
    };
}
async function getAiUsageLedgerState(input) {
    const state = await AiUsageLedgerStateSchema.findOne({ channelID: input.channelID, customerId: input.customerId })
        .select('coverageStart backfilledAt reportVersion').lean().exec();
    return state ? { coverageStart: state.coverageStart, backfilledAt: state.backfilledAt, reportVersion: state.reportVersion || 0 } : null;
}
