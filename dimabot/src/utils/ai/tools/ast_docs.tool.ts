/**
 * AST Docs Tool
 *
 * Read-only catalog lookup for AST commands. The AI calls this when it needs
 * the exact syntax/examples of a command before invoking AST_PARSER, or when
 * checking whether a command exists for what the user wants. Searches the
 * generated catalog (hybrid name/keyword/vector search) and returns full
 * entries: description, syntax, examples, required level.
 */

import { searchAstCatalog, ensureAstCatalogVectors } from '../ast_catalog/index.js';
import type { AstCatalogEntry } from '../ast_catalog/types.js';

export interface AstDocsArgs {
    /** What you are looking for: a function name ('start.poll') or intent ('start a vote in chat'). */
    query: string;
    /** Which consumer view to search. 'action' for things the bot does in chat (default), 'authoring' for command/reward message template functions. */
    surface?: 'action' | 'authoring';
    /** Max number of matches to return (1-10, default 3). */
    limit?: number;
}

export interface AstDocsToolContext {
    tags?: Record<string, unknown>;
}

export interface AstDocsToolResult {
    success: boolean;
    matches?: AstCatalogEntry[];
    vectorSearchUsed?: boolean;
    error?: string;
}

export async function execute(
    args: AstDocsArgs,
    context: AstDocsToolContext
): Promise<AstDocsToolResult> {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) {
        return { success: false, error: 'query is required' };
    }

    const rawActualLevel = Number(context.tags?.userLevel ?? context.tags?.['user-level'] ?? 1);
    const actualLevel = Number.isFinite(rawActualLevel)
        ? Math.max(1, Math.min(10, Math.trunc(rawActualLevel)))
        : 1;

    // Lazy index warm-up: search degrades to keyword matching until ready.
    void ensureAstCatalogVectors();

    const { matches, vectorSearchUsed } = await searchAstCatalog(query, {
        surface: args.surface === 'authoring' ? 'authoring' : 'action',
        maxUserLevel: actualLevel,
        limit: args.limit
    });

    return {
        success: true,
        matches,
        vectorSearchUsed
    };
}
