/**
 * Docs assistant: answers questions about DomDimaBot from the published docs.
 *
 * The whole docs export for the page's language goes into the system prompt (M3.1-Flash
 * has a 1M-token context), so answers never miss a page because of retrieval. The system
 * prompt stays byte-identical between requests so MiniMax's prefix cache can reuse it;
 * the per-request "current page" note goes in the last user message instead.
 */
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { getDragonflyClient } from '../../databases/dragonfly.database.js';
import { warn } from '../../logger.js';
import { minimaxChatStream, type MiniMaxChatResult, type MiniMaxEffort, type MiniMaxStreamHandlers } from '../minimax/minimax_client.js';
import { getDocsCorpus, toPageUrl, type DocsCorpus, type DocsLanguage, type DocsPage } from './docs_source.js';
import { DOCS_ASSISTANT_INSTRUCTIONS, docsBlockHeader } from './docs_assistant.prompt.js';

export const DOCS_ASSISTANT_EFFORT: MiniMaxEffort = 'xhigh';

// Input bounds for an anonymous public endpoint (not output limits).
export const MAX_QUESTION_CHARS = 2000;
const MAX_ASSISTANT_CHARS = 30_000;
const MAX_MESSAGES = 20;
const MAX_TOTAL_CHARS = 80_000;

const STATS_TTL_SECONDS = 120 * 86_400;
const ANSWER_TTL_SECONDS = 30 * 86_400;
const RECENT_KEEP = 1000;

export interface DocsAssistantMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface DocsAssistantRequest {
    messages: DocsAssistantMessage[];
    page: { title?: string; url?: string; lang: DocsLanguage };
}

export class DocsAssistantInputError extends Error {}

function cleanText(value: unknown, max: number, field: string): string {
    if (typeof value !== 'string') throw new DocsAssistantInputError(`${field} must be text`);
    // Drop control characters except tab/newline.
    const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (text.length > max) throw new DocsAssistantInputError(`${field} is too long`);
    return text;
}

export function parseDocsAssistantRequest(body: unknown): DocsAssistantRequest {
    if (!body || typeof body !== 'object') throw new DocsAssistantInputError('Request body must be JSON');
    const input = body as Record<string, unknown>;
    if (!Array.isArray(input.messages) || input.messages.length === 0) throw new DocsAssistantInputError('messages is required');
    if (input.messages.length > MAX_MESSAGES) throw new DocsAssistantInputError('Conversation is too long; start a new chat');

    let total = 0;
    const messages = input.messages.map((raw, index): DocsAssistantMessage => {
        const message = (raw ?? {}) as Record<string, unknown>;
        const role = index % 2 === 0 ? 'user' : 'assistant';
        if (message.role !== role) throw new DocsAssistantInputError('messages must alternate user/assistant, starting with user');
        const content = cleanText(message.content, role === 'user' ? MAX_QUESTION_CHARS : MAX_ASSISTANT_CHARS, `messages[${index}].content`);
        if (!content) throw new DocsAssistantInputError(`messages[${index}].content is empty`);
        total += content.length;
        return { role, content };
    });
    if (messages.at(-1)!.role !== 'user') throw new DocsAssistantInputError('The last message must be the question');
    if (total > MAX_TOTAL_CHARS) throw new DocsAssistantInputError('Conversation is too long; start a new chat');

    const rawPage = (input.page && typeof input.page === 'object' ? input.page : {}) as Record<string, unknown>;
    const lang: DocsLanguage = rawPage.lang === 'es' ? 'es' : 'en';
    const title = rawPage.title == null ? undefined : cleanText(rawPage.title, 200, 'page.title') || undefined;
    const url = rawPage.url == null ? undefined : cleanText(rawPage.url, 500, 'page.url') || undefined;
    return { messages, page: { title, url, lang } };
}

export function buildSystem(corpus: DocsCorpus): Anthropic.TextBlockParam[] {
    return [
        { type: 'text', text: DOCS_ASSISTANT_INSTRUCTIONS },
        { type: 'text', text: docsBlockHeader(corpus.language) + corpus.text },
    ];
}

export function buildMessages(request: DocsAssistantRequest): Anthropic.MessageParam[] {
    const { page } = request;
    const note = page.title || page.url
        ? `[Current page: ${[page.title, page.url].filter(Boolean).join(' — ')}]\n\n`
        : '';
    return request.messages.map((message, index) => ({
        role: message.role,
        content: index === request.messages.length - 1 ? note + message.content : message.content,
    }));
}

/** Docs pages linked in the answer, in order, with their titles. */
export function extractSources(answer: string, ...corpora: DocsCorpus[]): DocsPage[] {
    const found = new Map<string, DocsPage>();
    for (const match of answer.matchAll(/\]\((https:\/\/docs\.domdimabot\.com\/[^)\s]*)\)/g)) {
        const url = toPageUrl(match[1]).replace(/[#?].*$/, '');
        const withSlash = url.endsWith('/') ? url : `${url}/`;
        const page = corpora.map((corpus) => corpus.pages.get(withSlash)).find(Boolean);
        if (page && !found.has(page.url)) found.set(page.url, page);
    }
    return [...found.values()].slice(0, 5);
}

export interface DocsAnswer {
    id: string;
    content: string;
    sources: DocsPage[];
    usage: MiniMaxChatResult;
}

export async function answerDocsQuestion(
    request: DocsAssistantRequest,
    handlers: MiniMaxStreamHandlers & { onStart?: (id: string) => void },
    signal?: AbortSignal,
): Promise<DocsAnswer> {
    const corpus = await getDocsCorpus(request.page.lang);
    const id = randomUUID();
    handlers.onStart?.(id);
    const usage = await minimaxChatStream({
        feature: 'docs-assistant',
        system: buildSystem(corpus),
        messages: buildMessages(request),
        effort: DOCS_ASSISTANT_EFFORT,
        signal,
    }, handlers);
    const other = await getDocsCorpus(request.page.lang === 'es' ? 'en' : 'es').catch(() => null);
    const sources = extractSources(usage.content, corpus, ...(other ? [other] : []));
    return { id, content: usage.content, sources, usage };
}

// ---------------------------------------------------------------------------
// Usage record: daily totals plus recent answers (30 days) so feedback and
// unanswered questions can be reviewed before deciding on a site assistant.
// ---------------------------------------------------------------------------

const day = (at = new Date()) => at.toISOString().slice(0, 10);
const statsKey = (at?: Date) => `docs_assistant:stats:${day(at)}`;
const answerKey = (id: string) => `docs_assistant:answer:${id}`;

async function safely(task: string, run: () => Promise<unknown>): Promise<void> {
    try {
        await run();
    } catch (err) {
        await warn({ function: 'docsAssistant.record', message: `Could not record ${task}`, error: err instanceof Error ? err.message : String(err) }, { destination: 'console' });
    }
}

/** Counts a question toward today's total and returns the new total. */
export async function countQuestion(): Promise<number> {
    const redis = await getDragonflyClient('docs-assistant');
    const key = statsKey();
    const [count] = await redis.multi().hIncrBy(key, 'asked', 1).expire(key, STATS_TTL_SECONDS).exec();
    return Number(count);
}

export async function recordAnswer(request: DocsAssistantRequest, answer: DocsAnswer): Promise<void> {
    await safely('answer', async () => {
        const redis = await getDragonflyClient('docs-assistant');
        const { usage } = answer;
        const key = statsKey();
        await redis.multi()
            .hIncrBy(key, 'answered', 1)
            .hIncrBy(key, 'input_tokens', usage.inputTokens)
            .hIncrBy(key, 'cache_read_tokens', usage.cacheReadTokens)
            .hIncrBy(key, 'output_tokens', usage.outputTokens)
            .hIncrBy(key, 'cost_micro_usd', Math.round(usage.cost * 1_000_000))
            .expire(key, STATS_TTL_SECONDS)
            .hSet(answerKey(answer.id), {
                at: new Date().toISOString(),
                lang: request.page.lang,
                page: request.page.url ?? '',
                turn: String(Math.ceil(request.messages.length / 2)),
                question: request.messages.at(-1)!.content,
                answer: answer.content,
                sources: JSON.stringify(answer.sources.map((source) => source.url)),
                duration_ms: String(usage.durationMs),
                input_tokens: String(usage.inputTokens),
                output_tokens: String(usage.outputTokens),
                cost_usd: usage.cost.toFixed(6),
                stop_reason: usage.stopReason ?? '',
            })
            .expire(answerKey(answer.id), ANSWER_TTL_SECONDS)
            .lPush('docs_assistant:recent', answer.id)
            .lTrim('docs_assistant:recent', 0, RECENT_KEEP - 1)
            .exec();
    });
}

export async function recordFailure(kind: string): Promise<void> {
    await safely('failure', async () => {
        const redis = await getDragonflyClient('docs-assistant');
        const key = statsKey();
        await redis.multi().hIncrBy(key, 'failed', 1).hIncrBy(key, `failed_${kind}`, 1).expire(key, STATS_TTL_SECONDS).exec();
    });
}

/** Returns false when the answer is unknown/expired or already rated. */
export async function recordFeedback(id: unknown, helpful: unknown): Promise<boolean> {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof helpful !== 'boolean') {
        throw new DocsAssistantInputError('id and helpful are required');
    }
    const redis = await getDragonflyClient('docs-assistant');
    const key = answerKey(id);
    const at = await redis.hGet(key, 'at');
    if (!at) return false;
    // HSETNX: first rating wins, so repeated clicks can't skew the totals.
    const first = await redis.hSetNX(key, 'feedback', helpful ? 'helpful' : 'unhelpful');
    if (!first) return false;
    const stats = statsKey(new Date(at));
    await redis.multi().hIncrBy(stats, helpful ? 'helpful' : 'unhelpful', 1).expire(stats, STATS_TTL_SECONDS).exec();
    return true;
}
