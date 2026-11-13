import express from 'express';
import { assistantSummary, assistantTurn, assistantTurns, docsAnswers, docsSummary } from '../../services/admin_assistants.service.js';
import { AdminRequestError, channelIdForLogin, ownerGet, queryEnum, queryLogin, queryPage, queryRange, queryString, queryTwitchId } from './shared.js';

/** Owner-only admin site routes, mounted under `/admin-site` by `admin_site.route.ts`. Register with `ownerGet`/`ownerPut` from `./shared.js`. */
const router = express.Router();

/** A channel by Twitch id or login. */
async function queryChannel(value: unknown): Promise<string | undefined> {
    const text = queryString(value, 'channel');
    if (text === undefined) return undefined;
    if (/^\d+$/.test(text)) return queryTwitchId(text, 'channel');
    const id = await channelIdForLogin(queryLogin(text, 'channel')!);
    if (!id) throw new AdminRequestError('Channel not found', 404);
    return id;
}

ownerGet(router, '/assistant/summary', async (req) => {
    const range = queryRange(req.query, 30, 120);
    return assistantSummary(range, await queryChannel(req.query.channel));
});

ownerGet(router, '/assistant/turns', async (req) => {
    const filter = {
        range: queryRange(req.query, 30, 90),
        userId: queryTwitchId(req.query.user, 'user'),
        status: queryEnum(req.query.status, 'status', ['completed', 'cancelled', 'problems'] as const),
        level: queryEnum(req.query.level, 'level', ['standard', 'expert'] as const),
        sort: queryEnum(req.query.sort, 'sort', ['newest', 'cost', 'slowest'] as const, 'newest'),
        page: queryPage(req.query, 25, 50),
    };
    return assistantTurns({ ...filter, channelId: await queryChannel(req.query.channel) });
});

/** Turn ids are UUIDs (`randomUUID`). */
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

ownerGet(router, '/assistant/turns/:id', async (req) => {
    const id = String(req.params.id ?? '');
    if (!TURN_ID.test(id)) throw new AdminRequestError('Invalid id');
    const turn = await assistantTurn(id);
    if (!turn) throw new AdminRequestError('Turn not found', 404);
    return turn;
});

ownerGet(router, '/docs-assistant/summary', async (req) => docsSummary(queryRange(req.query, 30, 120)));

ownerGet(router, '/docs-assistant/answers', async (req) => docsAnswers({
    lang: queryEnum(req.query.lang, 'lang', ['en', 'es'] as const),
    feedback: queryEnum(req.query.feedback, 'feedback', ['helpful', 'unhelpful', 'none'] as const),
    sort: queryEnum(req.query.sort, 'sort', ['newest', 'cost', 'slowest'] as const, 'newest'),
    page: queryPage(req.query, 20, 50),
}));

export const adminAssistantsRouter = router;
