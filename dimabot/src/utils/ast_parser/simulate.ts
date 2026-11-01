/**
 * Command tester: runs a command body through the real AST engine without side effects.
 *
 * Same steps as a saved command (argument placeholders → parse → evaluate → render), with:
 * - pure functions (text, random, user, count…) running for real;
 * - every other function recorded, not run: actions (timeouts, chat, TTS, polls…) return
 *   nothing, and reads (Twitch data, event data, AI) return sample values;
 * - variables, cache variables, and the use count kept in memory for this test only.
 * Nothing reaches Twitch, the database, the cache, the overlay, or MiniMax.
 *
 * Used by the docs assistant's `test_command` tool. Never use it to run real commands.
 */
import { createExecutionContext, getAllRegisteredFunctions, renderAstWithSourceReference } from './index.js';
import { unescapeRenderedText } from './render.js';
import { registerAllFunctions } from './functions/index.js';
import { resolveArgumentPlaceholders } from '../../handlers/special_parser.handler.js';
import type { AstSimulationCache, ExecutionContext } from './types.js';

/** Functions that only read the command's own context: safe to run for real. */
const PURE_FUNCTIONS = new Set([
    'upper', 'lower', 'title', 'capitalize', 'trim', 'length', 'slice', 'replace',
    'random', 'user', 'touser', 'count', 'scount', 'bits', 'break', 'continue',
]);

/** Categories whose functions read data; everything else simulated is an action. */
const READ_CATEGORIES = new Set(['twitch-data', 'event-data', 'ai']);
const READ_FUNCTIONS = new Set([
    'get.poll', 'get.prediction', 'bot.mode', 'tts.status', 'tts.connected', 'tts.queue.length', 'roulette.result', 'randomuser',
]);

/** Sample values for reads (the block editor's "Try it" values, plus a few more). */
const SAMPLE_VALUES: Record<string, string> = {
    followage: '2 years, 4 months',
    'twitch.modiversary': '1 year',
    'twitch.streak': '12',
    'twitch.live': 'true',
    'twitch.subs': '128',
    'twitch.follows': '5400',
    'twitch.title': 'Night coding',
    'twitch.game': 'Just Chatting',
    'twitch.viewers': '42',
    'twitch.channel': 'YourChannel',
    'twitch.login': 'yourchannel',
    'raid.channel': 'BigStreamer',
    'raid.login': 'bigstreamer',
    'raid.viewers': '42',
    'cheer.amount': '100',
    'cheer.message': 'Take my bits!',
    'sub.tier': '1',
    'sub.months': '6',
    'gifted.user': 'LuckyViewer',
    'hypetrain.progress': '64',
    'hypetrain.level': '3',
    'hypetrain.end': 'in 4 minutes',
    'shoutout.channel': 'FriendlyStreamer',
    'reward.input': 'play some lofi',
    'ad.time': '12 minutes',
    'bot.mode': 'online',
    'get.poll': 'Best map? · Nuke leads',
    'get.prediction': 'Will we win? · 64% yes',
    'tts.status': 'Speech overlay connected · idle · 0 waiting',
    'tts.connected': 'true',
    'tts.queue.length': '0',
    'roulette.result': 'Mystery prize',
    ai: '(an AI-written reply would appear here)',
    'create.clip': 'https://clips.twitch.tv/ExampleClip',
};

export type SimulationRole = 'viewer' | 'mod' | 'streamer';
const ROLE_LEVEL: Record<SimulationRole, number> = { viewer: 1, mod: 7, streamer: 10 };

export interface SimulationRunInput {
    /** A different response body for this run (e.g. "!voice" then "!s" sharing variables). */
    body?: string;
    /** Display name of who types the command (default "Sam"). */
    user?: string;
    /** Text after the command name, e.g. "Alex" for "!hug Alex". */
    argument?: string;
    role?: SimulationRole;
}

export interface SimulationInput {
    /** The response body only (not a whole !cc line). */
    body: string;
    /** Runs in order, sharing variables and the use count. Default: one run by "Sam". */
    runs?: SimulationRunInput[];
    /** Repeat the whole sequence this many times (fresh state each time) to see random outcomes. */
    repeat?: number;
    plan?: 'free' | 'premium' | 'pro';
}

export interface SimulatedCall { function: string; args: string[] }

export interface SimulationRunResult {
    user: string;
    argument: string;
    /** What the bot would post in chat (empty: it posts nothing). */
    reply: string;
    /** Actions the bot would take, in order. Recorded, not performed. */
    actions: SimulatedCall[];
    /** Reads answered with sample values. */
    samples: Array<SimulatedCall & { value: string }>;
    /** Other commands this one would trigger with #(name). */
    commandReferences: string[];
    problems: string[];
}

export interface SimulationResult {
    runs: SimulationRunResult[];
    /** With repeat > 1: distinct outcomes of the whole sequence and how often each happened. */
    outcomes?: Array<{ times: number; replies: string[]; actions: string[] }>;
    /** Variables after the (first) sequence: name → value. */
    variables: Record<string, string>;
    useCount: number;
    note: string;
}

export class SimulationInputError extends Error {}

const MAX_BODY = 10_000;
const MAX_RUNS = 10;
const MAX_REPEAT = 50;
const RUN_TIMEOUT_MS = 5_000;

class MemoryCache implements AstSimulationCache {
    private values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async set(key: string, value: string) { this.values.set(key, String(value)); return 'OK'; }
    async expire() { return 1; }
    async exists(key: string) { return this.values.has(key) ? 1 : 0; }
    async del(key: string) { return this.values.delete(key) ? 1 : 0; }
    entries() { return [...this.values.entries()]; }
}

let categories: Map<string, string> | null = null;
function categoryOf(name: string): string {
    if (!categories) {
        registerAllFunctions({ startWorkers: false });
        categories = new Map(getAllRegisteredFunctions().map((entry) => [entry.name, entry.metadata?.category ?? '']));
    }
    return categories.get(name) ?? '';
}

const normalizeLogin = (value: string) => value.trim().replace(/^@+/, '').toLowerCase().replace(/\s+/g, '');

/** Problems the engine reports inline, plus code that printed as text instead of running. */
export function findProblems(reply: string): string[] {
    const problems = [...reply.matchAll(/\[(?:Parse error|Parser error|Unknown function)[^\]]*\]/g)].map((match) => match[0]);
    if (/^Error: |\sError: /.test(reply)) problems.push(`A function returned an error: ${reply.match(/Error: [^\n]*/)?.[0]}`);
    const leftover = reply.replace(/\[[^\]]*\]/g, '');
    if (/(^|\s)(==|!=|\?|:)(\s|$)/.test(leftover) && /(==|!=)/.test(leftover) || /[$%*^#]\(/.test(leftover)) {
        problems.push('Part of the command printed as text instead of running (often an unquoted &p1/&t that was empty or had spaces, or an unbalanced parenthesis).');
    }
    return problems;
}

interface State {
    count: number;
    channel: Map<string, string>;
    users: Map<string, string>;
    cache: MemoryCache;
}

async function runOnce(input: SimulationInput, run: SimulationRunInput, state: State): Promise<SimulationRunResult> {
    const display = (run.user || 'Sam').trim().slice(0, 40) || 'Sam';
    const login = normalizeLogin(display) || 'sam';
    const argument = String(run.argument ?? '').slice(0, 500);
    const level = ROLE_LEVEL[run.role ?? 'viewer'] ?? 1;
    const result: SimulationRunResult = { user: display, argument, reply: '', actions: [], samples: [], commandReferences: [], problems: [] };

    const placeholders = resolveArgumentPlaceholders(run.body ?? input.body, argument);
    if (placeholders.error) {
        result.reply = `[Parser error: ${placeholders.error}]`;
        result.problems = findProblems(result.reply);
        return result;
    }

    const userKey = (name: string, target?: string) => `${normalizeLogin(target || login)}:${name}`;
    const context: ExecutionContext = createExecutionContext({
        broadcasterId: 'test-channel',
        userId: `test-${login}`,
        userLogin: login,
        userDisplayName: display,
        userPlan: input.plan ?? 'premium',
        userLevel: level,
        enforceFunctionPermissions: false,
        authorization: { origin: 'authored', identity: { level, tags: level >= 10 ? ['broadcaster'] : [] } },
        argument,
        count: state.count,
        eventData: {
            chatter_user_id: `test-${login}`, chatter_user_login: login, chatter_user_name: display,
            broadcaster_user_id: 'test-channel', broadcaster_user_login: 'yourchannel', broadcaster_user_name: 'YourChannel',
        },
        extraContext: { userName: display, userLogin: login, userID: `test-${login}` },
        streamer: { id: 'test-channel', name: 'yourchannel' } as ExecutionContext['streamer'],
        scopeType: 'command',
        scopeName: 'test',
        commandName: 'test',
        variables: new Map(Object.entries(placeholders.variables ?? {})),
        saveChannelVariable: async (name, value) => { state.channel.set(name, value); },
        loadChannelVariable: async (name) => state.channel.get(name) ?? '',
        deleteChannelVariable: async (name) => { state.channel.delete(name); },
        saveUserVariable: async (name, value, target) => { state.users.set(userKey(name, target), value); },
        loadUserVariable: async (name, target) => state.users.get(userKey(name, target)) ?? '',
        deleteUserVariable: async (name, target) => { state.users.delete(userKey(name, target)); },
        simulation: {
            cache: state.cache,
            async callFunction(name, args) {
                if (PURE_FUNCTIONS.has(name)) return undefined;
                const call = { function: name, args: args.map((arg) => String(arg ?? '')) };
                const isRead = READ_FUNCTIONS.has(name) || READ_CATEGORIES.has(categoryOf(name));
                if (!isRead) {
                    result.actions.push(call);
                    return { value: '' };
                }
                const value = name === 'randomuser' ? 'ClipGoblin' : (SAMPLE_VALUES[name] ?? `(${name})`);
                result.samples.push({ ...call, value });
                return { value };
            },
        },
    });

    let timer: NodeJS.Timeout | undefined;
    const rendered = await Promise.race([
        renderAstWithSourceReference(placeholders.text, context),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), RUN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer)).catch((err) => {
        result.problems.push(err instanceof Error && err.message === 'timeout'
            ? `The command took longer than ${RUN_TIMEOUT_MS / 1000}s to run (check loops).`
            : `The engine failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    });
    if (!rendered) return result;

    state.count = rendered.context.count;
    result.reply = unescapeRenderedText(String(rendered.parsedText ?? '')).replace(/\s+/g, ' ').trim();
    result.commandReferences = rendered.context.commandReferences.map((ref) => `#(${ref.commandName}${ref.argument ? ` ${ref.argument}` : ''})`);
    result.problems.push(...findProblems(result.reply));
    return result;
}

async function runSequence(input: SimulationInput, runs: SimulationRunInput[]) {
    const state: State = { count: 0, channel: new Map(), users: new Map(), cache: new MemoryCache() };
    const results: SimulationRunResult[] = [];
    for (const run of runs) results.push(await runOnce(input, run, state));
    return { results, state };
}

export function parseSimulationInput(raw: unknown): SimulationInput {
    const input = (raw ?? {}) as Record<string, unknown>;
    const firstRunBody = Array.isArray(input.runs) && typeof (input.runs[0] as Record<string, unknown> | undefined)?.body === 'string'
        ? String((input.runs[0] as Record<string, unknown>).body) : '';
    const body = typeof input.body === 'string' && input.body.trim() ? input.body : firstRunBody;
    if (!body.trim()) throw new SimulationInputError('body is required: the response body to test');
    if (body.length > MAX_BODY) throw new SimulationInputError(`body is longer than ${MAX_BODY} characters`);
    if (/^\s*!(cc|ec)\s/i.test(body)) {
        throw new SimulationInputError('Pass only the response body, not the whole !cc/!ec line.');
    }
    const runs = Array.isArray(input.runs) ? input.runs.slice(0, MAX_RUNS).map((run) => {
        const value = (run ?? {}) as Record<string, unknown>;
        const role = value.role === 'mod' || value.role === 'streamer' ? value.role : 'viewer';
        const runBody = typeof value.body === 'string' && value.body.trim() ? value.body : undefined;
        if (runBody && (runBody.length > MAX_BODY || /^\s*!(cc|ec)\s/i.test(runBody))) {
            throw new SimulationInputError('Each run body must be a response body (no !cc/!ec line) under 10,000 characters.');
        }
        return { body: runBody, user: typeof value.user === 'string' ? value.user : undefined, argument: typeof value.argument === 'string' ? value.argument : '', role } as SimulationRunInput;
    }) : undefined;
    const repeat = Math.max(1, Math.min(MAX_REPEAT, Math.trunc(Number(input.repeat) || 1)));
    const plan = input.plan === 'free' || input.plan === 'pro' ? input.plan : 'premium';
    return { body, runs, repeat, plan };
}

export async function simulateCommand(input: SimulationInput): Promise<SimulationResult> {
    registerAllFunctions({ startWorkers: false });
    const runs = input.runs?.length ? input.runs : [{}];
    const first = await runSequence(input, runs);

    const variables: Record<string, string> = {};
    for (const [name, value] of first.state.channel) variables[`channel ${name}`] = value;
    for (const [key, value] of first.state.users) variables[`viewer ${key}`] = value;
    for (const [key, value] of first.state.cache.entries()) variables[`cache ${key.split(':').slice(-2).join(':')}`] = value;

    const result: SimulationResult = {
        runs: first.results,
        variables,
        useCount: first.state.count,
        note: 'Test run: pure functions ran for real; actions were recorded, not performed; Twitch/event/AI reads used sample values; variables lived only for this test.',
    };

    const repeat = input.repeat ?? 1;
    if (repeat > 1) {
        const outcomes = new Map<string, { times: number; replies: string[]; actions: string[] }>();
        const add = (results: SimulationRunResult[]) => {
            const replies = results.map((run) => run.reply);
            const actions = results.flatMap((run) => run.actions.map((call) => `${call.function}(${call.args.join(', ')})`));
            const key = JSON.stringify([replies, actions]);
            const entry = outcomes.get(key) ?? { times: 0, replies, actions };
            entry.times++;
            outcomes.set(key, entry);
        };
        add(first.results);
        for (let i = 1; i < repeat; i++) add((await runSequence(input, runs)).results);
        result.outcomes = [...outcomes.values()].sort((a, b) => b.times - a.times).slice(0, 12);
    }
    return result;
}
