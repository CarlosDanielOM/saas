/**
 * Search Tool Implementation
 * 
 * Executes web searches and returns formatted results to the AI.
 */

import { error, debug } from '../../logger.js';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface SearchResult {
    title: string;
    url: string;
    content: string;
    score: number;
}

export interface SearchToolResult {
    success: boolean;
    results?: SearchResult[];
    error?: string;
}

/**
 * @deprecated Use SearchResult instead
 */
export interface ISearchResult extends SearchResult {}

// ============================================================================
// TOOL EXECUTION
// ============================================================================

export async function execute(args: { query: string }): Promise<SearchToolResult> {
    const { query } = args;

    if (!query || query.trim() === '') {
        return {
            success: false,
            error: 'Search query is required'
        };
    }

    const queries = new URLSearchParams();
    queries.append('q', query);
    queries.append('format', 'json');

    try {
        debug({ message: '[Search Tool] Executing search', query }, { destination: 'console' });

        const results = await fetch('https://search.myhomelab.wtf/search?' + queries.toString());
        const resultsData = await results.json();

        if (resultsData.error) {
            await error({
                function: 'searchTool',
                error: 'Search API error',
                details: resultsData.error
            }, { destination: 'both' });

            return {
                success: false,
                error: 'Search failed: ' + resultsData.error
            };
        }

        if (!resultsData.results || resultsData.results.length === 0) {
            return {
                success: true,
                results: [],
                error: undefined
            };
        }

        const formattedResults: SearchResult[] = resultsData.results.slice(0, 3).map((result: any) => ({
            title: result.title || 'Untitled',
            url: result.url || '',
            content: result.content || '',
            score: result.score || 0
        }));

        debug({
            message: '[Search Tool] Search completed',
            resultCount: formattedResults.length
        }, { destination: 'console' });

        return {
            success: true,
            results: formattedResults
        };

    } catch (searchError) {
        await error({
            function: 'searchTool',
            error: 'Search tool error',
            err: searchError instanceof Error ? searchError.message : String(searchError)
        }, { destination: 'both' });

        return {
            success: false,
            error: searchError instanceof Error ? searchError.message : 'Unknown search error'
        };
    }
}

// ============================================================================
// TOOL METADATA
// ============================================================================

export const toolMeta = {
    name: 'search',
    description: 'Search the web for information',
    parameters: {
        query: { type: 'string', description: 'The search query to look up on the web' }
    }
};
