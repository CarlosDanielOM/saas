import express from 'express';
import {
    DECISION_FEEDBACK, DECISION_KINDS, DECISION_NOTE_MAX, DECISION_SHOWS, DECISION_SORTS, DECISION_SOURCES,
    decisionSummary, getDecision, listDecisions, setDecisionFeedback, type DecisionFilters
} from '../../services/admin_decisions.service.js';
import { MODERATION_REVIEW_LABELS, type ModerationReviewLabel } from '../../services/moderation_review.service.js';
import {
    AdminRequestError, channelIdForLogin, ownerGet, ownerPut, pagination, queryEnum, queryLogin, queryPage, queryRange, queryString,
    queryToken, queryTwitchId, reply
} from './shared.js';

/** Owner-only chat protection decisions ledger, mounted under `/admin-site` by `admin_site.route.ts`. */
const router = express.Router();

const DEFAULT_DAYS = 30;
// Decisions are kept 180 days; a wider window has nothing more to show.
const MAX_DAYS = 180;
const DECISION_ID = /^[\w-]{1,128}$/;
const CHATTER_NAME_MAX = 50;

/** A channel by Twitch id or login. Null when no streamer has that login, so nothing matches. */
async function queryChannel(value: unknown): Promise<string | null | undefined> {
    const text = queryString(value, 'channel');
    if (text === undefined) return undefined;
    if (/^\d{1,20}$/.test(text)) return text;
    return await channelIdForLogin(queryLogin(text, 'channel')!) ?? null;
}

/** A display name can be localized, so this is free text; it is only ever compared for equality. */
function queryChatterName(value: unknown): string | undefined {
    const text = queryString(value, 'chatterName')?.replace(/^@/, '');
    if (!text) return undefined;
    if (text.length > CHATTER_NAME_MAX || /\p{Cc}/u.test(text)) throw new AdminRequestError('Invalid chatterName');
    return text;
}

function decisionID(value: unknown): string {
    if (typeof value !== 'string' || !DECISION_ID.test(value)) throw new AdminRequestError('Invalid decision id');
    return value;
}

async function baseFilters(query: Record<string, unknown>): Promise<DecisionFilters> {
    const range = queryRange(query, DEFAULT_DAYS, MAX_DAYS);
    const chatterID = queryTwitchId(query.chatter, 'chatter');
    return { ...range, channelID: await queryChannel(query.channel), chatterID };
}

ownerGet(router, '/decisions', async req => {
    const query = req.query as Record<string, unknown>;
    const sort = queryEnum(query.sort, 'sort', DECISION_SORTS, 'newest');
    const page = queryPage(query, 25, 50);
    const filters: DecisionFilters = {
        show: queryEnum(query.show, 'show', DECISION_SHOWS),
        kind: queryEnum(query.kind, 'kind', DECISION_KINDS),
        source: queryEnum(query.source, 'source', DECISION_SOURCES),
        model: queryToken(query.model, 'model'),
        feedback: queryEnum(query.feedback, 'feedback', DECISION_FEEDBACK),
        chatterName: queryChatterName(query.chatterName),
        ...await baseFilters(query)
    };
    const { rows, total } = await listDecisions(filters, sort, page);
    return { rows, pagination: pagination(page, total) };
});

ownerGet(router, '/decisions/summary', async req => decisionSummary(await baseFilters(req.query as Record<string, unknown>)));

ownerGet(router, '/decisions/:id', async req => {
    const decision = await getDecision(decisionID(req.params.id));
    if (!decision) throw new AdminRequestError('Decision not found', 404);
    return decision;
});

ownerPut(router, '/decisions/:id/feedback', async req => {
    const id = decisionID(req.params.id);
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('label' in body)) throw new AdminRequestError('Invalid verdict');
    const label = body.label;
    if (label !== null && !(MODERATION_REVIEW_LABELS as readonly unknown[]).includes(label)) throw new AdminRequestError('Invalid verdict');
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new AdminRequestError('Invalid note');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > DECISION_NOTE_MAX) throw new AdminRequestError(`The note can be at most ${DECISION_NOTE_MAX} characters`);
    const saved = await setDecisionFeedback(id, label as ModerationReviewLabel | null, label && note ? note : null, String(req.user?.id || ''));
    if (!saved) throw new AdminRequestError('Decision not found', 404);
    return reply(saved, label ? 'Verdict saved' : 'Verdict cleared');
});

export const adminDecisionsRouter = router;
