/**
 * Owner-only read model of the two assistants for the admin site (`/admin-site/assistant/*`,
 * `/admin-site/docs-assistant/*`). Shapes match `admin/src/app/services/assistants-api.service.ts`.
 *
 * Dima assistant: from the turn log (`site_agent/turn_log.ts`) and the day counters. Chats are private between the
 * person and DomDimaBot's operators, so the owner reads them here: lists carry a short question preview, the detail
 * the whole exchange. Proposal payloads, undo data and page titles are never stored, so they can never be returned.
 * Docs assistant: anonymous and public, so questions and answers are shown.
 */
import UsersSchema from '../../schemas/users.schema.js';
import { SITE_AGENT_KEYS, SITE_AGENT_PLANS } from '../../site_agent/config.js';
import { utcDay } from '../../site_agent/limits.js';
import { listRefusals } from '../../site_agent/refusals.js';
import {
    clipText, getTurnLog, listTurnLogs, oldestTurnLogAt, QUESTION_PREVIEW_MAX, summarizeTurnLogs, type TurnLogListRow, type TurnLogRow, type TurnLogSort, type TurnLogStatusFilter,
} from '../../site_agent/turn_log.js';
import type { PlanTier } from '../../site_agent/types.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { DOCS_ASSISTANT_KEYS, DOCS_ASSISTANT_RECENT_KEEP } from '../../utils/ai/docs_assistant/docs_assistant.js';
import { docsPagePath } from '../../utils/ai/docs_assistant/docs_page.js';
import { channelLogins, pagination, type Page, type TimeRange } from '../routes/admin_site/shared.js';

const usd = (value: number) => Math.round(value * 1e6) / 1e6;
const count = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0; };
const isPlan = (value: unknown): value is PlanTier => value === 'free' || value === 'premium' || value === 'pro';

/** UTC days from `from` to `to`, both included, oldest first. */
export function utcDays(from: Date, to: Date): string[] {
    const days: string[] = [];
    const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    for (let at = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); at <= end; at += 86_400_000) {
        days.push(new Date(at).toISOString().slice(0, 10));
    }
    return days;
}

async function readDayHashes(days: string[], key: (day: string) => string): Promise<Record<string, string>[]> {
    const redis = await getDragonflyClient('admin-assistants');
    return Promise.all(days.map((day) => redis.hGetAll(key(day))));
}

// ---------------------------------------------------------------------------
// Dima assistant
// ---------------------------------------------------------------------------

export interface AssistantDay {
    date: string; turns: number; completed: number; failed: number; cancelled: number; steps: number; toolCalls: number;
    promptTokens: number; cachedTokens: number; completionTokens: number; providerUSD: number; helpful: number; unhelpful: number;
}

/** One `site_agent:stats:<day>` hash. Interrupted turns (the process stopped) count as failed. */
export function parseAssistantDay(date: string, hash: Record<string, string>): AssistantDay {
    return {
        date,
        turns: count(hash.turns),
        completed: count(hash.turns_completed),
        failed: count(hash.turns_failed) + count(hash.turns_interrupted),
        cancelled: count(hash.turns_cancelled),
        steps: count(hash.steps),
        toolCalls: count(hash.tool_calls),
        promptTokens: count(hash.prompt_tokens),
        cachedTokens: count(hash.cached_tokens),
        completionTokens: count(hash.completion_tokens),
        providerUSD: usd(count(hash.cost_micro_usd) / 1e6),
        helpful: count(hash.helpful),
        unhelpful: count(hash.unhelpful),
    };
}

function sumDays<T extends { date: string }>(days: T[], zero: Omit<T, 'date'>): Omit<T, 'date'> {
    const total = { ...zero } as Record<string, number>;
    for (const { date: _date, ...day } of days) {
        for (const [field, value] of Object.entries(day as Record<string, number>)) total[field] = (total[field] ?? 0) + value;
    }
    if ('providerUSD' in total) total.providerUSD = usd(total.providerUSD);
    return total as Omit<T, 'date'>;
}

export interface AssistantTurn {
    id: string; at: string; channelID: string; channel: string | null;
    user: { id: string; login: string; name: string; role: 'owner' | 'admin' };
    plan: PlanTier; level: 'standard' | 'expert'; fellBack: boolean; models: string[]; status: string; errorCode: string | null;
    lang: string; pageRoute: string | null; question: string | null; steps: number;
    tools: Array<{ name: string; state: string; ms: number | null; approval: string | null }>;
    units: number; promptTokens: number; cachedTokens: number; completionTokens: number; providerUSD: number;
    durationMs: number; activeMs: number; feedback: 'helpful' | 'unhelpful' | null;
    /** False once the text was cleared (3 days after the message): the numbers remain. */
    textKept: boolean;
}

export interface AssistantTurnDetail extends Omit<AssistantTurn, 'tools'> {
    message: string | null;
    steers: string[];
    answer: string | null;
    tools: Array<{ name: string; state: string; ms: number | null; approval: string | null; args: string | null; result: string | null }>;
}

type ListedTurn = TurnLogListRow | Omit<TurnLogRow, 'expiresAt'>;
const questionOf = (row: ListedTurn) => clipText('question' in row ? row.question : row.message, QUESTION_PREVIEW_MAX) || null;

/** Field by field on purpose: nothing new on a row reaches the API unless listed here. */
export function toAssistantTurn(row: ListedTurn, logins: Map<string, string>): AssistantTurn {
    return {
        id: String(row._id),
        at: new Date(row.at).toISOString(),
        channelID: row.channelId,
        channel: row.channelLogin || logins.get(row.channelId) || null,
        user: { id: row.user?.id ?? '', login: row.user?.login ?? '', name: row.user?.name ?? '', role: row.user?.role === 'admin' ? 'admin' : 'owner' },
        plan: isPlan(row.plan) ? row.plan : 'free',
        level: row.level === 'expert' ? 'expert' : 'standard',
        fellBack: Boolean(row.fellBack),
        models: [...(row.models ?? [])],
        status: row.status,
        errorCode: row.errorCode || null,
        lang: row.lang,
        pageRoute: row.pageRoute || null,
        question: questionOf(row),
        steps: count(row.steps),
        tools: (row.tools ?? []).map((tool) => ({ name: tool.name, state: tool.state, ms: typeof tool.ms === 'number' ? tool.ms : null, approval: tool.approval ?? null })),
        units: count(row.units),
        promptTokens: count(row.promptTokens),
        cachedTokens: count(row.cachedTokens),
        completionTokens: count(row.completionTokens),
        providerUSD: usd(row.costUsd || 0),
        durationMs: count(row.durationMs),
        activeMs: count(row.activeMs),
        feedback: row.feedback === 'helpful' || row.feedback === 'unhelpful' ? row.feedback : null,
        textKept: row.textCleared !== true,
    };
}

export function toAssistantTurnDetail(row: Omit<TurnLogRow, 'expiresAt'>, logins: Map<string, string>): AssistantTurnDetail {
    const { tools: _tools, ...turn } = toAssistantTurn(row, logins);
    return {
        ...turn,
        message: row.message || null,
        steers: (row.steers ?? []).filter((text) => typeof text === 'string'),
        answer: row.answer || null,
        tools: (row.tools ?? []).map((tool) => ({
            name: tool.name, state: tool.state, ms: typeof tool.ms === 'number' ? tool.ms : null, approval: tool.approval ?? null, args: tool.args || null, result: tool.result || null,
        })),
    };
}

async function loginsFor(ids: Iterable<string>, known: Iterable<[string, string]> = []): Promise<Map<string, string>> {
    const names = new Map([...known].filter(([, login]) => Boolean(login)));
    const missing = [...new Set(ids)].filter((id) => !names.has(id));
    for (const [id, login] of await channelLogins(missing)) names.set(id, login);
    return names;
}

const DAILY_SCAN_MAX_KEYS = 1_000;
const DAILY_SCAN_BUDGET_MS = 2_000;

/**
 * Today's daily-limit counters (`site_agent:daily:<channel>:<today>`). There is no index of them, so this SCANs, with
 * a cap on keys and time: the key space is small (one key per channel that used the assistant in the last 2 days).
 */
async function todayCounters(): Promise<Map<string, number>> {
    const redis = await getDragonflyClient('admin-assistants');
    const today = utcDay();
    const keys: string[] = [];
    const started = Date.now();
    for await (const batch of redis.scanIterator({ MATCH: SITE_AGENT_KEYS.dailyCount('*', today), COUNT: 1_000 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]));
        if (keys.length >= DAILY_SCAN_MAX_KEYS || Date.now() - started > DAILY_SCAN_BUDGET_MS) break;
    }
    const used = new Map<string, number>();
    const picked = keys.slice(0, DAILY_SCAN_MAX_KEYS);
    if (!picked.length) return used;
    const values = await redis.mGet(picked);
    picked.forEach((key, index) => {
        const [, , channelId] = key.split(':');
        const units = count(values[index]);
        if (/^\d{1,20}$/.test(channelId) && units > 0) used.set(channelId, units);
    });
    return used;
}

async function channelPlans(ids: string[]): Promise<Map<string, PlanTier>> {
    const plans = new Map<string, PlanTier>();
    if (!ids.length) return plans;
    const owners = await UsersSchema.find({ accounts: { $elemMatch: { type: 'twitch', id: { $in: ids } } } })
        .select('accounts.type accounts.id plan_tier').maxTimeMS(5_000).lean();
    for (const owner of owners as Array<{ plan_tier?: unknown; accounts?: Array<{ type?: string; id?: unknown }> }>) {
        const plan = isPlan(owner.plan_tier) ? owner.plan_tier : 'free';
        for (const account of owner.accounts ?? []) {
            if (account.type === 'twitch' && ids.includes(String(account.id))) plans.set(String(account.id), plan);
        }
    }
    return plans;
}

export async function assistantSummary(range: TimeRange, channelId?: string) {
    const [hashes, breakdowns, refusals, counters, since] = await Promise.all([
        readDayHashes(utcDays(range.from, range.to), SITE_AGENT_KEYS.stats),
        summarizeTurnLogs(range.from, range.to, channelId),
        listRefusals(1, 1),
        todayCounters(),
        oldestTurnLogAt(),
    ]);
    const days = utcDays(range.from, range.to);
    const daily = days.map((date, index) => parseAssistantDay(date, hashes[index] ?? {}));
    const zero = parseAssistantDay('', {});
    const { date: _date, ...zeroTotals } = zero;

    const limitIds = [...counters.keys()].filter((id) => !channelId || id === channelId);
    const [logins, plans] = await Promise.all([
        loginsFor([...breakdowns.byChannel.map((row) => row.channelId), ...limitIds], breakdowns.byChannel.map((row) => [row.channelId, row.channelLogin])),
        channelPlans(limitIds),
    ]);
    return {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        daily,
        totals: { ...sumDays(daily, zeroTotals), channels: breakdowns.channels, people: breakdowns.people },
        byLevel: breakdowns.byLevel.map((row) => ({ level: row.level, turns: row.turns, failed: row.failed, providerUSD: usd(row.costUsd), avgDurationMs: Math.round(row.avgDurationMs || 0) })),
        byModel: breakdowns.byModel.map((row) => ({ model: row.model, turns: row.turns, providerUSD: usd(row.costUsd) })),
        byChannel: breakdowns.byChannel.map((row) => ({
            channelID: row.channelId, channel: logins.get(row.channelId) || null, plan: isPlan(row.plan) ? row.plan : 'free',
            turns: row.turns, failed: row.failed, cancelled: row.cancelled, units: row.units, providerUSD: usd(row.costUsd), lastAt: new Date(row.lastAt).toISOString(),
        })),
        byTool: breakdowns.byTool.map((row) => ({ name: row.name, calls: row.calls, failed: row.failed })),
        errors: breakdowns.errors.map((row) => ({ code: row.code, count: row.count, lastAt: new Date(row.lastAt).toISOString() })),
        refusals: { week: refusals.counts.week, total: refusals.counts.total },
        limitsToday: limitIds
            .map((id) => ({ channelID: id, channel: logins.get(id) || null, used: counters.get(id) ?? 0, limit: SITE_AGENT_PLANS[plans.get(id) ?? 'free'].dailyMessages }))
            .sort((a, b) => b.used / b.limit - a.used / a.limit || b.used - a.used || a.channelID.localeCompare(b.channelID)),
        recordsSince: since ? since.toISOString() : null,
    };
}

export interface AssistantTurnFilter {
    range: TimeRange;
    channelId?: string;
    userId?: string;
    status?: TurnLogStatusFilter;
    level?: 'standard' | 'expert';
    sort: TurnLogSort;
    page: Page;
}

export async function assistantTurns(filter: AssistantTurnFilter) {
    const { rows, total } = await listTurnLogs({
        from: filter.range.from, to: filter.range.to, channelId: filter.channelId, userId: filter.userId, status: filter.status,
        level: filter.level, sort: filter.sort, skip: filter.page.skip, limit: filter.page.limit,
    });
    const logins = await loginsFor(rows.filter((row) => !row.channelLogin).map((row) => row.channelId));
    return { rows: rows.map((row) => toAssistantTurn(row, logins)), pagination: pagination(filter.page, total) };
}

export async function assistantTurn(id: string): Promise<AssistantTurnDetail | null> {
    const row = await getTurnLog(id);
    if (!row) return null;
    return toAssistantTurnDetail(row, await loginsFor(row.channelLogin ? [] : [row.channelId]));
}

// ---------------------------------------------------------------------------
// Docs assistant
// ---------------------------------------------------------------------------

export interface DocsDay {
    date: string; asked: number; answered: number; failed: number; abandoned: number; toolCalls: number;
    inputTokens: number; outputTokens: number; providerUSD: number; helpful: number; unhelpful: number;
}

export function parseDocsDay(date: string, hash: Record<string, string>): DocsDay {
    const asked = count(hash.asked);
    const answered = count(hash.answered);
    const failed = count(hash.failed);
    return {
        date, asked, answered, failed,
        abandoned: Math.max(0, asked - answered - failed),
        toolCalls: count(hash.tool_calls),
        inputTokens: count(hash.input_tokens),
        outputTokens: count(hash.output_tokens),
        providerUSD: usd(count(hash.cost_micro_usd) / 1e6),
        helpful: count(hash.helpful),
        unhelpful: count(hash.unhelpful),
    };
}

export interface DocsAnswer {
    id: string; at: string; lang: string; page: string | null; turn: number; question: string; answer: string;
    sources: string[]; tools: string[]; rounds: number | null; durationMs: number; inputTokens: number; outputTokens: number;
    providerUSD: number; stopReason: string | null;
    /** Failure reason for a question that was not answered; null for answers. */
    failed: string | null;
    feedback: 'helpful' | 'unhelpful' | null;
}

export interface DocsRecord extends DocsAnswer {
    atMs: number;
}

function jsonList(text: string | undefined): unknown[] {
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** One `docs_assistant:answer:<id>` hash; null when it is gone or unreadable. Old answers lack `rounds` and `tool_calls`. */
export function parseDocsRecord(id: string, hash: Record<string, string>): DocsRecord | null {
    const atMs = Date.parse(hash.at ?? '');
    if (!Number.isFinite(atMs)) return null;
    const rounds = hash.rounds ? Number(hash.rounds) : NaN;
    const cost = Number(hash.cost_usd);
    return {
        id,
        at: new Date(atMs).toISOString(),
        atMs,
        lang: hash.lang || 'en',
        page: docsPagePath(hash.page),
        turn: Math.max(1, count(hash.turn)),
        question: hash.question ?? '',
        answer: hash.answer ?? '',
        sources: jsonList(hash.sources).filter((url): url is string => typeof url === 'string'),
        tools: jsonList(hash.tool_calls).map((call) => (call as { name?: unknown })?.name).filter((name): name is string => typeof name === 'string'),
        rounds: Number.isFinite(rounds) && rounds > 0 ? Math.round(rounds) : null,
        durationMs: count(hash.duration_ms),
        inputTokens: count(hash.input_tokens),
        outputTokens: count(hash.output_tokens),
        providerUSD: Number.isFinite(cost) && cost > 0 ? usd(cost) : 0,
        stopReason: hash.stop_reason || null,
        feedback: hash.feedback === 'helpful' || hash.feedback === 'unhelpful' ? hash.feedback : null,
        failed: hash.failed || null,
    };
}

const DOCS_BATCH = 100;
/** What filtering, sorting and the summary need: never the question, answer, sources or tool calls. */
const DOCS_META_FIELDS = ['at', 'lang', 'page', 'turn', 'duration_ms', 'input_tokens', 'output_tokens', 'cost_usd', 'stop_reason', 'rounds', 'feedback', 'failed'] as const;
const DOCS_TEXT_FIELDS = ['question', 'answer', 'sources', 'tool_calls'] as const;
/** The summary and the list load together: one metadata read serves both, for this long. */
const DOCS_META_TTL_MS = 30_000;
let docsMeta: { at: number; records: Promise<DocsRecord[]> } | null = null;

const toHash = (fields: readonly string[], values: (string | null)[]) => Object.fromEntries(fields.flatMap((field, index) => (values[index] === null || values[index] === undefined ? [] : [[field, values[index] as string]])));

/**
 * Metadata of every stored answer and failure (≤ 1000, newest first): text fields are left empty. Ids whose hash
 * expired are dropped from the list (LREM by value, so answers added meanwhile are never lost).
 */
async function readDocsMetadata(): Promise<DocsRecord[]> {
    const redis = await getDragonflyClient('admin-assistants');
    const ids = await redis.lRange(DOCS_ASSISTANT_KEYS.recent, 0, DOCS_ASSISTANT_RECENT_KEEP - 1);
    const records: DocsRecord[] = [];
    const gone: string[] = [];
    for (let start = 0; start < ids.length; start += DOCS_BATCH) {
        const batch = ids.slice(start, start + DOCS_BATCH);
        const rows = await Promise.all(batch.map((id) => redis.hmGet(DOCS_ASSISTANT_KEYS.answer(id), [...DOCS_META_FIELDS])));
        batch.forEach((id, index) => {
            const hash = toHash(DOCS_META_FIELDS, rows[index]);
            if (!hash.at) { gone.push(id); return; }
            const record = parseDocsRecord(id, hash);
            if (record) records.push(record);
        });
    }
    if (gone.length) {
        const tx = redis.multi();
        for (const id of new Set(gone)) tx.lRem(DOCS_ASSISTANT_KEYS.recent, 0, id);
        await tx.exec().catch(() => null);
    }
    return records;
}

/** The metadata read, shared by requests within `DOCS_META_TTL_MS` (a failed read is not kept). */
export function loadDocsMetadata(): Promise<DocsRecord[]> {
    if (docsMeta && Date.now() - docsMeta.at < DOCS_META_TTL_MS) return docsMeta.records;
    const entry = { at: Date.now(), records: readDocsMetadata() };
    docsMeta = entry;
    entry.records.catch(() => { if (docsMeta === entry) docsMeta = null; });
    return entry.records;
}

export function clearDocsCacheForTests(): void {
    docsMeta = null;
}

/** The full text of the rows on one page. */
async function withDocsText(records: DocsRecord[]): Promise<DocsRecord[]> {
    if (!records.length) return records;
    const redis = await getDragonflyClient('admin-assistants');
    const texts = await Promise.all(records.map((record) => redis.hmGet(DOCS_ASSISTANT_KEYS.answer(record.id), [...DOCS_TEXT_FIELDS])));
    return records.map((record, index) => {
        const text = parseDocsRecord(record.id, { at: record.at, ...toHash(DOCS_TEXT_FIELDS, texts[index]) });
        return text ? { ...record, question: text.question, answer: text.answer, sources: text.sources, tools: text.tools } : record;
    });
}

export const toDocsAnswer = ({ atMs: _atMs, ...answer }: DocsRecord): DocsAnswer => answer;

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

export const DOCS_TOP_PAGES = 10;

export async function docsSummary(range: TimeRange) {
    const days = utcDays(range.from, range.to);
    const [hashes, records] = await Promise.all([readDayHashes(days, DOCS_ASSISTANT_KEYS.stats), loadDocsMetadata()]);
    const daily = days.map((date, index) => parseDocsDay(date, hashes[index] ?? {}));
    const { date: _date, ...zero } = parseDocsDay('', {});
    const failures = new Map<string, number>();
    for (const hash of hashes) {
        for (const [field, value] of Object.entries(hash ?? {})) {
            if (field.startsWith('failed_')) failures.set(field.slice(7), (failures.get(field.slice(7)) ?? 0) + count(value));
        }
    }
    const answers = records.filter((record) => !record.failed && record.atMs >= range.from.getTime() && record.atMs <= range.to.getTime());
    const langs = new Map<string, number>();
    const pages = new Map<string, number>();
    for (const answer of answers) {
        langs.set(answer.lang, (langs.get(answer.lang) ?? 0) + 1);
        if (answer.page) pages.set(answer.page, (pages.get(answer.page) ?? 0) + 1);
    }
    const ranked = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        daily,
        totals: sumDays(daily, zero),
        failures: [...failures].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, n]) => ({ reason, count: n })),
        byLang: ranked(langs).map(([lang, n]) => ({ lang, answers: n })),
        topPages: ranked(pages).slice(0, DOCS_TOP_PAGES).map(([page, n]) => ({ page, answers: n })),
        medianDurationMs: median(answers.map((answer) => answer.durationMs)),
    };
}

export interface DocsAnswerFilter {
    lang?: 'en' | 'es';
    feedback?: 'helpful' | 'unhelpful' | 'none';
    sort: 'newest' | 'cost' | 'slowest';
    page: Page;
}

export function filterDocsRecords(records: DocsRecord[], filter: Omit<DocsAnswerFilter, 'page'>): DocsRecord[] {
    const rows = records.filter((record) => (!filter.lang || record.lang === filter.lang)
        && (!filter.feedback || (filter.feedback === 'none' ? record.feedback === null : record.feedback === filter.feedback)));
    const newest = (a: DocsRecord, b: DocsRecord) => b.atMs - a.atMs || a.id.localeCompare(b.id);
    const order = filter.sort === 'cost' ? (a: DocsRecord, b: DocsRecord) => b.providerUSD - a.providerUSD || newest(a, b)
        : filter.sort === 'slowest' ? (a: DocsRecord, b: DocsRecord) => b.durationMs - a.durationMs || newest(a, b) : newest;
    return rows.sort(order);
}

export async function docsAnswers(filter: DocsAnswerFilter) {
    // The cached list is shared: filter and sort a copy.
    const rows = filterDocsRecords([...await loadDocsMetadata()], filter);
    const page = await withDocsText(rows.slice(filter.page.skip, filter.page.skip + filter.page.limit));
    return { rows: page.map(toDocsAnswer), pagination: pagination(filter.page, rows.length) };
}
