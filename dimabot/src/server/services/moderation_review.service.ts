import { ModerationDecision } from '../../schemas/moderation_decision.schema.js';
import UsersSchema from '../../schemas/users.schema.js';
import { SPAM_RULE_ID } from '../../utils/moderation/spam.js';
import { DEFAULT_SPAM_THRESHOLD, SPAM_MIN_OVERALL_SCORE } from '../../utils/moderation/spam_categories.js';

/**
 * The operator's review queue for chat protection: decisions worth a human verdict, so the
 * classifier's bar and guards can be tuned on real cases later.
 * - contradiction: a category passed the ban bar and beat the safe score, but the overall answer
 *   stayed under the minimum, so the guard (not the bar) stopped the ban.
 * - near_miss: no ban although a category scored at least half, and the model was not sure it was safe.
 * - ban: the classifier's verdict was a ban (the ban itself may have been cancelled or refused).
 * The first two only hold decisions the classifier answered in time: a late answer was not what
 * stopped a ban, the deadline was.
 */
export const MODERATION_REVIEW_KINDS = ['contradiction', 'near_miss', 'ban'] as const;
export type ModerationReviewKind = typeof MODERATION_REVIEW_KINDS[number];
export const MODERATION_REVIEW_LABELS = ['violation', 'allow'] as const;
export type ModerationReviewLabel = typeof MODERATION_REVIEW_LABELS[number];
export const NEAR_MISS_MIN_SCORE = 0.5;
// Old classifiers scored plain greetings high in one category while 97% sure they were safe; those are not near misses.
export const NEAR_MISS_MAX_SAFE = 0.9;
// A verdict is only given to copies whose preceding chat the operator was shown.
export const REVIEW_CONTEXTS_SHOWN = 8;
const COPIES_READ = 300;

const threshold = { $divide: [{ $ifNull: ['$rule.semantic.thresholdPercent', DEFAULT_SPAM_THRESHOLD] }, 100] };
const contradiction = { $and: [
    { $gte: ['$scores.violation', threshold] },
    { $lt: ['$scores.safe', '$scores.violation'] },
    { $gt: ['$scores.safe', 1 - SPAM_MIN_OVERALL_SCORE] }
] };
const answered = { $in: ['completed', 'uncertain'] };

export function moderationReviewFilter(kind: ModerationReviewKind): Record<string, unknown> {
    const scored = { ruleID: SPAM_RULE_ID, 'scores.safe': { $type: 'number' } };
    if (kind === 'ban') return { ...scored, 'scores.violation': { $type: 'number' }, verdict: 'violation' };
    if (kind === 'contradiction') return { ...scored, 'scores.violation': { $type: 'number' }, verdict: { $ne: 'violation' }, status: answered, $expr: contradiction };
    return { ...scored, 'scores.violation': { $type: 'number', $gte: NEAR_MISS_MIN_SCORE }, 'scores.safe': { $type: 'number', $lte: NEAR_MISS_MAX_SAFE },
        verdict: { $ne: 'violation' }, status: answered, $expr: { $not: [contradiction] } };
}

const labelledFilter = (labelled: boolean) => labelled ? { 'feedback.label': { $in: [...MODERATION_REVIEW_LABELS] } } : { 'feedback.label': { $exists: false } };

// Bots send one line from dozens of accounts, so identical text is one card. Text alone does not
// decide a verdict, though: a broadcaster's invitation changes the policy, and so can the chat
// before the message. Copies are therefore split by invitation, and a card only carries the copies
// whose preceding chat it shows (see `shape`). Reviewed and unreviewed copies are never mixed.
const grouped = (kind: ModerationReviewKind, labelled: boolean) => [
    { $match: { ...moderationReviewFilter(kind), ...labelledFilter(labelled) } },
    { $sort: { createdAt: -1 as const } },
    { $group: {
        _id: { text: '$messageText', invited: { $eq: ['$rule.semantic.broadcasterInvitation', true] }, label: labelled ? '$feedback.label' : null },
        total: { $sum: 1 }, latestAt: { $first: '$createdAt' }, reviewedAt: { $max: '$feedback.reviewedAt' },
        copies: { $push: { id: '$_id', channelID: '$channelID', username: '$username', createdAt: '$createdAt', context: '$context', scores: '$scores', model: '$model',
            verdict: '$verdict', status: '$status', reviewSource: '$reviewSource', messageOrdinal: '$messageOrdinal', consequence: '$consequence',
            thresholdPercent: '$rule.semantic.thresholdPercent', categories: '$rule.semantic.categories' } }
    } },
    { $set: { copies: { $slice: ['$copies', COPIES_READ] } } }
];

export async function moderationReviewCounts(): Promise<Record<ModerationReviewKind, number>> {
    const counts = await Promise.all(MODERATION_REVIEW_KINDS.map(async kind => {
        const [row] = await ModerationDecision.aggregate([
            { $match: { ...moderationReviewFilter(kind), ...labelledFilter(false) } },
            { $group: { _id: { text: '$messageText', invited: { $eq: ['$rule.semantic.broadcasterInvitation', true] } } } },
            { $count: 'n' }
        ]);
        return [kind, Number(row?.n) || 0] as const;
    }));
    return Object.fromEntries(counts) as Record<ModerationReviewKind, number>;
}

type Line = { username: string; message: string; isBroadcaster: boolean };
const lines = (context: unknown): Line[] => (Array.isArray(context) ? context : []).map((message: any) => ({
    username: String(message?.username || ''), message: String(message?.message || ''), isBroadcaster: message?.isBroadcaster === true }));

/** The copies a card stands for: every copy with no chat before it, plus the first distinct chats, all shown. */
function shape(group: any, names: Map<string, string>) {
    const buckets = new Map<string, { lines: Line[]; copies: any[] }>();
    for (const copy of group.copies as any[]) {
        const context = lines(copy.context);
        const signature = JSON.stringify(context);
        if (!buckets.has(signature)) buckets.set(signature, { lines: context, copies: [] });
        buckets.get(signature)!.copies.push(copy);
    }
    const shown = [...buckets.values()].filter(bucket => !bucket.lines.length);
    shown.push(...[...buckets.values()].filter(bucket => bucket.lines.length).slice(0, REVIEW_CONTEXTS_SHOWN));
    const covered = shown.flatMap(bucket => bucket.copies).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = covered[0];
    return {
        messageText: String(group._id.text ?? ''), invited: group._id.invited === true, label: group._id.label ?? null, reviewedAt: group.reviewedAt ?? null,
        ids: covered.map(copy => String(copy.id)), count: covered.length, more: group.total - covered.length,
        channels: new Set(covered.map(copy => String(copy.channelID))).size,
        withoutContext: shown.filter(bucket => !bucket.lines.length).reduce((sum, bucket) => sum + bucket.copies.length, 0),
        contexts: shown.filter(bucket => bucket.lines.length).map(bucket => ({
            copies: bucket.copies.length, channel: names.get(String(bucket.copies[0].channelID)) || String(bucket.copies[0].channelID), lines: bucket.lines })),
        latest: {
            id: String(latest.id), channelID: String(latest.channelID), channel: names.get(String(latest.channelID)) || '', username: String(latest.username || ''),
            createdAt: latest.createdAt, model: String(latest.model || ''), verdict: latest.verdict, status: latest.status, reviewSource: latest.reviewSource,
            messageOrdinal: latest.messageOrdinal ?? null,
            consequence: { status: latest.consequence?.status ?? 'none', action: latest.consequence?.action ?? null, success: latest.consequence?.success ?? null },
            thresholdPercent: latest.thresholdPercent ?? DEFAULT_SPAM_THRESHOLD, categories: latest.categories ?? [], scores: latest.scores
        }
    };
}

export async function listModerationReviews(kind: ModerationReviewKind, state: 'pending' | 'labelled', page: number, limit: number) {
    const [result] = await ModerationDecision.aggregate([...grouped(kind, state === 'labelled'),
        { $sort: { latestAt: -1, '_id.text': 1, '_id.invited': 1, '_id.label': 1 } },
        { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } }]);
    const groups: any[] = result?.rows ?? [];
    const total = Number(result?.total?.[0]?.n) || 0;
    const channelIDs = [...new Set(groups.flatMap(group => (group.copies as any[]).map(copy => String(copy.channelID))))];
    const owners = channelIDs.length ? await UsersSchema.find({ accounts: { $elemMatch: { type: 'twitch', id: { $in: channelIDs } } } })
        .select('accounts.type accounts.id accounts.name').lean() : [];
    const names = new Map<string, string>();
    for (const owner of owners) for (const account of owner.accounts || []) if (account.type === 'twitch') names.set(String(account.id), String(account.name || ''));
    return { rows: groups.map(group => shape(group, names)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

/**
 * Saves (or clears, with `null`) the operator's verdict on exactly the decisions a card listed.
 * A copy that arrived after the card was loaded is not touched: nobody looked at it.
 */
export async function labelModerationReview(kind: ModerationReviewKind, ids: string[], label: ModerationReviewLabel | null, reviewerID: string): Promise<number> {
    const update = label ? [{ $set: { feedback: { label, reviewerID, reviewedAt: '$$NOW' } } }] : [{ $set: { feedback: null } }];
    const result = await ModerationDecision.updateMany({ ...moderationReviewFilter(kind), _id: { $in: ids } }, update);
    return result.matchedCount;
}
