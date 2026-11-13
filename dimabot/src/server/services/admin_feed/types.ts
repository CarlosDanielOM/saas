/**
 * The admin activity feed's shapes. They mirror `admin/src/app/services/feed-api.service.ts`, which is the
 * contract the admin site is built against: change both together.
 */
export const FEED_KINDS = [
    'command', 'bot_message', 'twitch_event', 'alert', 'protection', 'voice', 'ai', 'assistant', 'docs', 'credits', 'system'
] as const;
export type FeedKind = typeof FEED_KINDS[number];
export type FeedOutcome = 'ok' | 'skipped' | 'blocked' | 'failed';
export type FeedRefType = 'decision' | 'usage' | 'event' | 'assistant_turn' | 'docs_answer' | 'activity';

export interface FeedActor { id: string | null; login: string | null; name: string | null }

export interface FeedItem {
    id: string;
    at: string;
    kind: FeedKind;
    name: string;
    outcome: FeedOutcome;
    reason: string | null;
    channelID: string | null;
    channel: string | null;
    actor: FeedActor | null;
    text: string | null;
    credits: number | null;
    providerUSD: number | null;
    durationMs: number | null;
    data: Record<string, string | number | boolean | null>;
    ref: { type: FeedRefType; id: string } | null;
}

export interface FeedFilters {
    channelID?: string;
    actorID?: string;
    actorLogin?: string;
    kinds?: FeedKind[];
    outcome?: 'problems' | 'failed';
    from: Date;
    to: Date;
}

export interface FeedPage { items: FeedItem[]; nextCursor: string | null; partial: FeedKind[] }
export interface FeedKindCount { kind: FeedKind; total: number; problems: number; failed: number }
export interface FeedSummary { from: string; to: string; kinds: FeedKindCount[]; partial: FeedKind[] }

/** One journaled Twitch event with what each consumer did with it. */
export interface EventDetail {
    eventKey: string;
    type: string;
    twitchType: string | null;
    source: string;
    channelID: string | null;
    channel: string | null;
    occurredAt: string;
    journaledAt: string;
    test: boolean;
    actor: FeedActor | null;
    payload: Record<string, unknown>;
    deliveries: Array<{
        consumer: string;
        status: 'pending' | 'processing' | 'retry' | 'succeeded' | 'skipped' | 'dead';
        attempts: number;
        reason: string | null;
        completedAt: string | null;
        durationMs: number | null;
    }>;
    steps: Array<{ step: string; status: 'completed' | 'skipped' | 'failed'; reason: string | null; at: string | null }>;
    traceId: string | null;
}
