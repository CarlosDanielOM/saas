import { queryEnum, queryEnumList, queryInt, queryLogin, queryRange, queryString, queryTwitchId } from '../../routes/admin_site/shared.js';
import { FEED_KINDS, type FeedFilters } from './types.js';

export const FEED_DEFAULT_DAYS = 7;
export const FEED_MAX_DAYS = 90;
export const FEED_DEFAULT_LIMIT = 40;
export const FEED_MAX_LIMIT = 100;

/** `GET /admin-site/feed/summary` filters: who, where and when. Throws a 400 `AdminRequestError` on bad input. */
export function parseFeedScope(query: Record<string, unknown>, now = new Date()): FeedFilters {
    const { from, to } = queryRange(query, FEED_DEFAULT_DAYS, FEED_MAX_DAYS, now);
    const filters: FeedFilters = { from, to };
    const channelID = queryTwitchId(query.channel, 'channel');
    const actorID = queryTwitchId(query.actor, 'actor');
    const actorLogin = queryLogin(query.actorLogin, 'actorLogin');
    if (channelID) filters.channelID = channelID;
    if (actorID) filters.actorID = actorID;
    if (actorLogin) filters.actorLogin = actorLogin;
    return filters;
}

/** `GET /admin-site/feed`: the scope plus kinds, outcome, cursor and limit. */
export function parseFeedQuery(query: Record<string, unknown>, now = new Date()) {
    const filters = parseFeedScope(query, now);
    const kinds = queryEnumList(query.kinds, 'kinds', FEED_KINDS);
    const outcome = queryEnum(query.outcome, 'outcome', ['problems', 'failed'] as const);
    if (kinds) filters.kinds = kinds;
    if (outcome) filters.outcome = outcome;
    return {
        filters,
        cursor: queryString(query.cursor, 'cursor'),
        limit: queryInt(query.limit, 'limit', FEED_DEFAULT_LIMIT, 1, FEED_MAX_LIMIT)
    };
}
