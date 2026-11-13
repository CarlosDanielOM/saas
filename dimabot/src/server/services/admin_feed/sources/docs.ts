import { getDragonflyClient } from '../../../../utils/databases/dragonfly.database.js';
import { afterBound, clipText, compareFeedItems, flatData, num, str, type FeedSource, type LocalBound } from '../source.js';
import type { FeedItem } from '../types.js';

/**
 * Docs assistant questions (Dragonfly). `docs_assistant:recent` lists ids newest first (at most 1000, no
 * expiry); each `docs_assistant:answer:<id>` hash lives 30 days, so ids whose hash is gone are skipped. A
 * question that could not be answered is kept the same way with `failed` = the reason (timeout, busy…).
 * Same keys as `DOCS_ASSISTANT_KEYS` in `utils/ai/docs_assistant/docs_assistant.ts`, written out here because
 * importing that module loads the MiniMax client and the docs corpus. Anonymous: no channel, no actor.
 *
 * The list is small, so a page reads every id's time (one pipeline), picks the page in memory and then
 * reads only those answers.
 */
const DOCS_RECENT_KEY = 'docs_assistant:recent';
const docsAnswerKey = (id: string) => `docs_assistant:answer:${id}`;
const RECENT_MAX = 1000;
const ID = /^[0-9a-f-]{36}$/;
const FIELDS = ['at', 'failed', 'lang', 'page', 'question', 'duration_ms', 'cost_usd', 'rounds', 'feedback'] as const;

type Redis = Awaited<ReturnType<typeof getDragonflyClient>>;

interface QuestionTime { id: string; at: number; failed: boolean }

/** Question ids with their time and whether they failed, inside the window, newest first. */
async function answerTimes(redis: Redis, from: Date, to: Date): Promise<QuestionTime[]> {
    const ids = [...new Set((await redis.lRange(DOCS_RECENT_KEY, 0, RECENT_MAX - 1)).filter(id => ID.test(id)))];
    if (!ids.length) return [];
    const multi = redis.multi();
    for (const id of ids) multi.hmGet(docsAnswerKey(id), ['at', 'failed']);
    const values = await multi.exec(true) as unknown as Array<Array<string | null> | null>;
    const rows: QuestionTime[] = [];
    ids.forEach((id, index) => {
        const [time, failed] = values[index] || [];
        const at = typeof time === 'string' ? Date.parse(time) : NaN;
        if (Number.isFinite(at) && at >= from.getTime() && at < to.getTime()) rows.push({ id, at, failed: !!failed });
    });
    return rows.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Only the page part of the URL the visitor was on: no query string or fragment. */
export function docsPage(value: unknown): string | null {
    const text = str(value);
    if (!text) return null;
    try { return new URL(text).pathname || null; } catch { return clipText(text.split(/[?#]/)[0], 200); }
}

export function docsItem(id: string, hash: Partial<Record<typeof FIELDS[number], string | null>>): FeedItem | null {
    const at = Date.parse(hash.at || '');
    if (!Number.isFinite(at)) return null;
    const cost = num(Number(hash.cost_usd));
    const duration = num(Number(hash.duration_ms));
    const feedback = hash.feedback === 'helpful' || hash.feedback === 'unhelpful' ? hash.feedback : null;
    const failed = clipText(hash.failed, 64);
    return {
        id: `docs:${id}`,
        at: new Date(at).toISOString(),
        kind: 'docs',
        name: 'answer',
        outcome: failed ? 'failed' : 'ok',
        reason: failed,
        channelID: null,
        channel: null,
        actor: null,
        text: clipText(hash.question),
        credits: null,
        // A failed question stores a zero cost: what the provider charged, if anything, is unknown.
        providerUSD: !failed && hash.cost_usd && cost !== null ? cost : null,
        durationMs: hash.duration_ms && duration !== null ? duration : null,
        data: flatData({ lang: str(hash.lang), page: docsPage(hash.page), feedback, rounds: hash.rounds ? num(Number(hash.rounds)) : null }),
        ref: { type: 'docs_answer', id }
    };
}

/** `failedOnly`: every docs problem is a failure (nothing is skipped or blocked), so both outcome filters mean this. */
export async function docsPageItems(redis: Redis, from: Date, to: Date, bound: LocalBound | undefined, limit: number, failedOnly = false): Promise<FeedItem[]> {
    const page = (await answerTimes(redis, from, to))
        .filter(row => (!failedOnly || row.failed) && afterBound(bound, row.at, row.id))
        .slice(0, limit);
    if (!page.length) return [];
    const multi = redis.multi();
    for (const row of page) multi.hmGet(docsAnswerKey(row.id), [...FIELDS]);
    const hashes = await multi.exec(true) as unknown as Array<Array<string | null>>;
    const items: FeedItem[] = [];
    page.forEach((row, index) => {
        const values = hashes[index] || [];
        const item = docsItem(row.id, Object.fromEntries(FIELDS.map((field, i) => [field, values[i] ?? null])));
        if (item) items.push(item);
    });
    return items.sort(compareFeedItems);
}

export const docsSource: FeedSource = {
    prefix: 'docs',
    plan(filters) {
        if (filters.kinds?.length && !filters.kinds.includes('docs')) return [];
        // Anonymous: nothing to show for a channel or a chatter.
        if (filters.channelID || filters.actorID || filters.actorLogin) return [];
        return ['docs'];
    },
    async list({ filters, bound, limit }) {
        return docsPageItems(await getDragonflyClient('admin-feed'), filters.from, filters.to, bound, limit, !!filters.outcome);
    },
    async count({ filters }) {
        const rows = await answerTimes(await getDragonflyClient('admin-feed'), filters.from, filters.to);
        const failed = rows.filter(row => row.failed).length;
        return [{ kind: 'docs', total: rows.length, problems: failed, failed }];
    }
};
