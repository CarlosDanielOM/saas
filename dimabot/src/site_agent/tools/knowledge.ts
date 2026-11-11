/**
 * Knowledge tools: docs search/read (site_agent/docs) and the docs assistant's AST function search
 * and safe command test, adapted to AgentTool. No permissions, no side effects.
 */
import { ensureAstCatalogVectors } from '../../utils/ai/ast_catalog/index.js';
import { searchAstFunctionsTool, testCommandTool } from '../../utils/ai/docs_assistant/docs_assistant.tools.js';
import { parseSimulationInput, SimulationInputError } from '../../utils/ast_parser/simulate.js';
import { ensureDocsVectors, MAX_SEARCH_LIMIT, peekParsedDocs, readDocs, searchDocs, type DocsReadScope } from '../docs/index.js';
import { langFromId, normalizeDocsId } from '../docs/sections.js';
import { ToolInputError, type AgentTool, type JsonSchema, type Lang, type PlanTier, type ToolOutcome } from '../types.js';
import { asObject, int, oneOf, str, untrusted } from './util.js';

const LANGS = ['en', 'es'] as const;
const PLANS = ['free', 'premium', 'pro'] as const;

const t = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

const DOCS_UNAVAILABLE = {
    error: 'docs_unavailable',
    message: 'The docs could not be loaded right now. Try again in a moment; do not guess syntax or limits.',
};

// ---------------------------------------------------------------------------
// search_docs
// ---------------------------------------------------------------------------

export type SearchDocsToolInput = { query: string; limit: number; lang?: Lang };

export const searchDocsTool: AgentTool<SearchDocsToolInput> = {
    name: 'search_docs',
    description:
        'Search the official DomDimaBot docs (guides for this bot, its website and its features) by topic. Returns the best '
        + 'matching sections: id, page, section heading, url, a short snippet and the section size in tokens. Snippets are only '
        + 'previews: before you answer about syntax, functions, limits, plans, permissions or steps, read the section with read_docs. '
        + 'Use a few keywords or a short question about the feature ("tts voice per viewer", "contador de muertes"). If the results '
        + 'do not fit, search again with other words (feature names, function names like $(random), commands like !s). The docs '
        + 'index in your instructions already lists every page and section id, so you can read from it directly when the right '
        + 'section is obvious. lang defaults to the user\'s language; when nothing matches, results come from the other language.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'What to look for, in the user\'s words or the docs\' words.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, description: 'How many sections to return (default 5).' },
            lang: { type: 'string', enum: [...LANGS], description: 'Docs language (default: the user\'s language).' },
        },
        required: ['query'],
        additionalProperties: false,
    },
    kind: 'knowledge',
    permissions: [],
    label: (_input, lang) => t(lang, 'Searching the docs…', 'Buscando en la documentación…'),
    validate(raw) {
        const input = asObject(raw);
        return {
            query: str(input, 'query', { required: true, min: 2, max: 300 })!,
            limit: int(input, 'limit', { min: 1, max: MAX_SEARCH_LIMIT }) ?? 5,
            lang: oneOf(input, 'lang', LANGS),
        };
    },
    async run(input, ctx): Promise<ToolOutcome> {
        let response;
        try {
            response = await searchDocs({ query: input.query, lang: input.lang ?? ctx.lang, limit: input.limit });
        } catch {
            return { type: 'result', result: DOCS_UNAVAILABLE, summary: t(ctx.lang, 'Docs unavailable', 'Documentación no disponible') };
        }
        const count = response.results.length;
        return {
            type: 'result',
            result: response,
            summary: count ? t(ctx.lang, `${count} result${count === 1 ? '' : 's'}`, `${count} resultado${count === 1 ? '' : 's'}`) : t(ctx.lang, 'No matches', 'Sin resultados'),
        };
    },
};

// ---------------------------------------------------------------------------
// read_docs
// ---------------------------------------------------------------------------

export type ReadDocsToolInput = { id: string; scope?: DocsReadScope; page?: number };

/** Heading for the status line, from the parsed docs when loaded, else from the id itself. */
function titleForId(rawId: string): string {
    const id = normalizeDocsId(rawId);
    const parsed = peekParsedDocs(langFromId(id));
    const [pageId, anchor] = id.split('#');
    const known = parsed?.sectionById.get(id)?.heading ?? parsed?.subsectionById.get(id)?.subsection.heading ?? (anchor ? undefined : parsed?.pageById.get(pageId)?.title);
    if (known) return known.replace(/`/g, '');
    const words = (anchor || pageId.split('/').filter(Boolean).pop() || 'docs').replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Docs pages may be bigger than ordinary tool results (~8k tokens per page). */
const READ_DOCS_RESULT_BYTES = 32_000;

export const readDocsTool: AgentTool<ReadDocsToolInput> = {
    name: 'read_docs',
    resultBytes: READ_DOCS_RESULT_BYTES,
    description:
        'Read DomDimaBot docs text by id. A section id is a page path + "#" + anchor, e.g. "/tts#choose-a-voice-engine"; Spanish '
        + 'pages start with /es/ ("/es/tts#elegir-un-motor-de-voz"). Ids come from search_docs results, the docs index in your '
        + 'instructions, or a topic read. scope "section" (the default when the id has "#") returns that section; a subsection id '
        + 'returns just that subsection with its parent id. scope "topic" (the default for a bare page path like "/tts") returns the '
        + 'whole page and the list of its section ids. Prefer one section; read the topic when you need the whole page. Long text '
        + 'comes in pages: when the result has nextPage, call again with page = nextPage. Unknown ids return the closest ids. Cite the url.',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Section id ("/tts#chat-command-s"), or a page path ("/tts") for the whole page.' },
            scope: { type: 'string', enum: ['section', 'topic'], description: '"section" (default with "#") or "topic" = the whole page.' },
            page: { type: 'integer', minimum: 1, maximum: 100, description: 'Page of a long result (default 1; use nextPage).' },
        },
        required: ['id'],
        additionalProperties: false,
    },
    kind: 'knowledge',
    permissions: [],
    label: (input, lang) => t(lang, `Reading: ${titleForId(input.id)}…`, `Leyendo: ${titleForId(input.id)}…`),
    validate(raw) {
        const input = asObject(raw);
        return {
            id: str(input, 'id', { required: true, max: 300 })!,
            scope: oneOf(input, 'scope', ['section', 'topic'] as const),
            page: int(input, 'page', { min: 1, max: 100 }),
        };
    },
    async run(input, ctx): Promise<ToolOutcome> {
        let result;
        try {
            // Pages shrink to fit the runner's tool result cap, so text is paged instead of cut.
            result = await readDocs({ id: input.id, scope: input.scope, page: input.page, lang: ctx.lang, maxBytes: READ_DOCS_RESULT_BYTES - 100 });
        } catch {
            return { type: 'result', result: DOCS_UNAVAILABLE, summary: t(ctx.lang, 'Docs unavailable', 'Documentación no disponible') };
        }
        if ('error' in result) {
            return { type: 'result', result, summary: t(ctx.lang, 'Not found', 'No encontrado') };
        }
        const name = (result.section ?? result.title).replace(/`/g, '');
        const part = result.pages > 1 ? t(ctx.lang, ` (page ${result.page} of ${result.pages})`, ` (página ${result.page} de ${result.pages})`) : '';
        return { type: 'result', result, summary: `${name}${part}` };
    },
};

// ---------------------------------------------------------------------------
// search_ast_functions / test_command (shared with the public docs assistant)
// ---------------------------------------------------------------------------

export type SearchAstFunctionsInput = { query: string; limit: number };

export const searchAstFunctionsAgentTool: AgentTool<SearchAstFunctionsInput> = {
    name: searchAstFunctionsTool.definition.name,
    description: `${searchAstFunctionsTool.definition.description} Use it before writing or explaining a command body, to check that a function exists and how its arguments work.`,
    parameters: searchAstFunctionsTool.definition.input_schema as JsonSchema,
    kind: 'knowledge',
    permissions: [],
    label: (_input, lang) => t(lang, 'Looking up command functions…', 'Buscando funciones de comandos…'),
    validate(raw) {
        const input = asObject(raw);
        return {
            query: str(input, 'query', { required: true, max: 200 })!,
            limit: int(input, 'limit', { min: 1, max: 10 }) ?? 5,
        };
    },
    async run(input, ctx): Promise<ToolOutcome> {
        const result = await searchAstFunctionsTool.run(input, ctx.signal) as { matches: unknown[] };
        const count = result.matches.length;
        return {
            type: 'result',
            result,
            summary: count ? t(ctx.lang, `${count} function${count === 1 ? '' : 's'}`, `${count} ${count === 1 ? 'función' : 'funciones'}`) : t(ctx.lang, 'No matches', 'Sin resultados'),
        };
    },
};

/** Raw simulation input (checked with parseSimulationInput); plan defaults to the channel's plan. */
export type TestCommandInput = Record<string, unknown> & { plan?: PlanTier };

const testCommandSchema = testCommandTool.definition.input_schema as JsonSchema & { properties: Record<string, Record<string, unknown>> };

export const testCommandAgentTool: AgentTool<TestCommandInput> = {
    name: testCommandTool.definition.name,
    description: `${testCommandTool.definition.description} Test every command body you suggest before you give it to the user, and say it was tested in a safe simulation.`,
    parameters: {
        ...testCommandSchema,
        properties: {
            ...testCommandSchema.properties,
            plan: { ...testCommandSchema.properties.plan, description: 'Plan to simulate (default: this channel\'s plan). Matters for database variables.' },
        },
    },
    kind: 'knowledge',
    permissions: [],
    label: (_input, lang) => t(lang, 'Testing the command…', 'Probando el comando…'),
    validate(raw) {
        const input = asObject(raw);
        const plan = oneOf(input, 'plan', PLANS);
        try {
            parseSimulationInput(input);
        } catch (err) {
            if (err instanceof SimulationInputError) throw new ToolInputError(err.message);
            throw err;
        }
        return { ...input, plan };
    },
    async run(input, ctx): Promise<ToolOutcome> {
        const { note, ...rest } = await testCommandTool.run({ ...input, plan: input.plan ?? ctx.plan }, ctx.signal) as { note: string; runs: Array<{ problems?: string[] }> } & Record<string, unknown>;
        const runs = rest.runs.length;
        const problems = rest.runs.reduce((sum, run) => sum + (run.problems?.length ?? 0), 0);
        return {
            type: 'result',
            // Replies and variables echo the body's text, which may come from someone else's command.
            result: { ...untrusted(rest), note },
            summary: problems
                ? t(ctx.lang, `${problems} problem${problems === 1 ? '' : 's'} found`, `${problems} problema${problems === 1 ? '' : 's'} encontrado${problems === 1 ? '' : 's'}`)
                : t(ctx.lang, `Tested (${runs} run${runs === 1 ? '' : 's'})`, `Probado (${runs} ${runs === 1 ? 'ejecución' : 'ejecuciones'})`),
        };
    },
};

export const knowledgeTools: AgentTool[] = [searchDocsTool, readDocsTool, searchAstFunctionsAgentTool, testCommandAgentTool];

let warming: Promise<void> | null = null;

/**
 * Starts the AST catalog vectors and the docs vectors (en, then es) in the background, one after
 * the other so the shared embeddings service never gets two builds at once. Safe to call often.
 */
export function warmKnowledge(): void {
    if (warming) return;
    warming = (async () => {
        await ensureAstCatalogVectors().catch(() => false);
        for (const lang of LANGS) await ensureDocsVectors(lang);
    })()
        .catch(() => undefined)
        .finally(() => { warming = null; });
}
