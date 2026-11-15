import { channelLogins } from '../../routes/admin_site/shared.js';
import { getEventDetail as loadEventDetail } from './event_detail.js';
import { createFeed } from './merge.js';
import { activitySource } from './sources/activity.js';
import { assistantSource } from './sources/assistant.js';
import { docsSource } from './sources/docs.js';
import { eventsSource } from './sources/events.js';
import { mcpSource } from './sources/mcp.js';
import { protectionSource } from './sources/protection.js';
import { usageSource } from './sources/usage.js';
import type { EventDetail, FeedFilters, FeedPage, FeedSummary } from './types.js';

export * from './types.js';
export { MAX_FEED_LIMIT } from './merge.js';
export { isValidEventKey } from './event_detail.js';

const lookupLogins = (ids: string[]) => channelLogins(ids);

/** Every store the feed reads, one adapter each (see `sources/`). */
const feed = createFeed([activitySource, eventsSource, protectionSource, usageSource, assistantSource, mcpSource, docsSource], { channelLogins: lookupLogins });

/**
 * One time-ordered feed over every store that records what happened (see `types.ts`).
 * `cursor` is the `nextCursor` of the previous page; `limit` is 1–100. A bad cursor throws a 400
 * `AdminRequestError`. A store that fails or is slow is left out and named in `partial`.
 */
export async function listFeed(filters: FeedFilters, cursor: string | undefined, limit: number): Promise<FeedPage> {
    return feed.list(filters, cursor, limit);
}

/** Rows per kind for the same filters; `kinds` and `outcome` in the filters are ignored. */
export async function summarizeFeed(filters: FeedFilters): Promise<FeedSummary> {
    return feed.summarize(filters);
}

/** One journaled Twitch event, its deliveries and stream steps; undefined when the key is unknown. */
export async function getEventDetail(eventKey: string): Promise<EventDetail | undefined> {
    return loadEventDetail(eventKey, lookupLogins);
}
