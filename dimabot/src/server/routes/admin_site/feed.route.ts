import express from 'express';
import { getEventDetail, isValidEventKey, listFeed, summarizeFeed } from '../../services/admin_feed/index.js';
import { parseFeedQuery, parseFeedScope } from '../../services/admin_feed/query.js';
import { withViewerId } from '../../services/admin_feed/viewer.js';
import { AdminRequestError, ownerGet } from './shared.js';

/** Owner-only admin site routes, mounted under `/admin-site` by `admin_site.route.ts`. */
const router = express.Router();

ownerGet(router, '/feed', async (req) => {
    const { filters, cursor, limit } = parseFeedQuery(req.query as Record<string, unknown>);
    return listFeed(await withViewerId(filters), cursor, limit);
});

ownerGet(router, '/feed/summary', async (req) => summarizeFeed(await withViewerId(parseFeedScope(req.query as Record<string, unknown>))));

// Express hands the key over URL-decoded; a real key contains ':' and may contain '%'.
ownerGet(router, '/events/:eventKey', async (req) => {
    const eventKey = typeof req.params.eventKey === 'string' ? req.params.eventKey : '';
    if (!isValidEventKey(eventKey)) throw new AdminRequestError('Invalid event key');
    const detail = await getEventDetail(eventKey);
    if (!detail) throw new AdminRequestError('No event with that key', 404);
    return detail;
});

export const adminFeedRouter = router;
