/**
 * Tools for the docs assistant. Reuses the chat AI's AST catalog search (name, keyword and
 * embedding match over the bot's registered functions), on the command-writing surface.
 */
import { execute as searchAstDocs } from '../tools/ast_docs.tool.js';
import { ensureAstCatalogVectors } from '../ast_catalog/index.js';
import type { MiniMaxTool } from '../minimax/minimax_client.js';
import { parseSimulationInput, simulateCommand } from '../../ast_parser/simulate.js';

export const SEARCH_AST_FUNCTIONS = 'search_ast_functions';
export const TEST_COMMAND = 'test_command';

export const searchAstFunctionsTool: MiniMaxTool = {
    definition: {
        name: SEARCH_AST_FUNCTIONS,
        description:
            'Search the bot\'s live catalog of AST functions for custom commands. It is generated from the functions the bot actually has, '
            + 'so it can include functions the docs do not mention yet. Search by exact name ("tts.skip") or by intent '
            + '("skip the current TTS message", "pick a random viewer"), in English or Spanish. '
            + 'Returns each match\'s name, syntax, description, examples, aliases, category, plan, and whether it is destructive.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A function name or what the command should do.' },
                limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many matches to return (default 5).' },
            },
            required: ['query'],
        },
    },
    async run(input) {
        const { query, limit } = (input ?? {}) as { query?: unknown; limit?: unknown };
        // Streamer-authored commands aren't limited by per-function levels, so show every function.
        const result = await searchAstDocs(
            { query: String(query ?? ''), surface: 'authoring', limit: Number.isFinite(Number(limit)) ? Number(limit) : 5 },
            { tags: { userLevel: 10 } },
        );
        if (!result.success) throw new Error(result.error || 'Search failed');
        return {
            matches: (result.matches ?? []).map((entry) => ({
                name: entry.name,
                syntax: entry.syntax,
                description: entry.description,
                examples: entry.examples,
                aliases: entry.aliases,
                category: entry.category,
                plan: entry.planTier,
                destructive: entry.destructive,
            })),
            // Keyword-only matching while the embedding index warms up.
            semanticSearch: Boolean(result.vectorSearchUsed),
        };
    },
};

const runSchema = {
    type: 'object',
    properties: {
        user: { type: 'string', description: 'Display name of who types the command (default "Sam").' },
        argument: { type: 'string', description: 'Text typed after the command name, e.g. "Alex" for "!hug Alex". Empty = no argument.' },
        role: { type: 'string', enum: ['viewer', 'mod', 'streamer'], description: 'Who types it (default viewer).' },
        body: { type: 'string', description: 'Optional: a different response body for this run, to test a setup of several commands that share variables.' },
    },
};

export const testCommandTool: MiniMaxTool = {
    definition: {
        name: TEST_COMMAND,
        description:
            'Run a command response body through the bot\'s real command engine in a safe test mode. Pure functions (text, random, '
            + 'user, touser, count) run for real; actions (timeouts, chat messages, TTS, triggers, polls, title changes…) are recorded '
            + 'instead of performed; Twitch/event/AI reads return sample values (e.g. game "Just Chatting"); variables exist only for '
            + 'this test. Returns each run\'s chat reply, recorded actions, sample reads, the variables afterwards, and problems '
            + '(parse errors, unknown functions, code that printed as text). Runs happen in order and share variables, so you can test '
            + 'several viewers, arguments, a first run, or (with a per-run body) a setup of several commands. Use repeat for random commands.',
        input_schema: {
            type: 'object',
            properties: {
                body: { type: 'string', description: 'The response body only (not a whole !cc line).' },
                runs: { type: 'array', items: runSchema, maxItems: 10, description: 'Runs in order (default: one run by "Sam" with no argument).' },
                repeat: { type: 'integer', minimum: 1, maximum: 50, description: 'Repeat the whole sequence this many times to see random outcomes and how often each happens.' },
                plan: { type: 'string', enum: ['free', 'premium', 'pro'], description: 'The streamer\'s plan (default premium). Matters for database variables.' },
            },
            required: ['body'],
        },
    },
    async run(input) {
        const result = await simulateCommand(parseSimulationInput(input));
        // Keep the tool result compact: drop empty fields.
        return {
            runs: result.runs.map((run) => ({
                user: run.user,
                ...(run.argument ? { argument: run.argument } : {}),
                reply: run.reply,
                ...(run.actions.length ? { actions: run.actions.map((call) => `${call.function}(${call.args.join(', ')})`) } : {}),
                ...(run.samples.length ? { sampleReads: run.samples.map((call) => `${call.function} → ${call.value}`) } : {}),
                ...(run.commandReferences.length ? { triggersCommands: run.commandReferences } : {}),
                ...(run.problems.length ? { problems: run.problems } : {}),
            })),
            ...(result.outcomes ? { outcomes: result.outcomes } : {}),
            ...(Object.keys(result.variables).length ? { variables: result.variables } : {}),
            note: result.note,
        };
    },
};

/** Start building the embedding index early so the first question gets semantic search. */
export function warmDocsAssistantTools(): void {
    void ensureAstCatalogVectors();
}
