import { getTwitchAppHeader } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { categoryMatchScore, categoryQueries } from './category_matching.js';

interface TwitchCategory {
    id: string;
    name: string;
    box_art_url: string;
    igdb_id?: string;
}

interface SearchCategoriesResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
    data?: TwitchCategory[];
}

export async function searchCategories(query: string): Promise<SearchCategoriesResponse> {
    try {
        const queries = categoryQueries(query);
        if (!queries.length) {
            return { error: true, message: 'Please provide a game name', status: 400 };
        }
        const appHeader = await getTwitchAppHeader();
        const categories = new Map<string, TwitchCategory>();

        for (const searchQuery of queries) {
            const params = new URLSearchParams({ query: searchQuery, first: '100' });
            const response = await fetch(getTwitchHelixUrl('search/categories', params.toString()), {
                headers: appHeader as unknown as Record<string, string>
            });
            const data = await response.json();
            if (!response.ok || data.error) {
                return {
                    error: true,
                    message: data.message || 'Error searching for game',
                    status: data.status || response.status,
                    type: data.error || 'error'
                };
            }
            if (!Array.isArray(data.data)) throw new Error('Invalid Twitch category response');
            for (const category of data.data as TwitchCategory[]) {
                categories.set(category.id, category);
            }
            // Full title equivalence is conclusive; partial matches need the
            // alternate numeral/base searches before we can choose safely.
            if ([...categories.values()].some(category => categoryMatchScore(query, category.name) >= 3)) break;
        }

        const ranked = [...categories.values()]
            .map(category => ({ category, score: categoryMatchScore(query, category.name) }))
            .filter(match => match.score > 0)
            .sort((a, b) => b.score - a.score || a.category.name.localeCompare(b.category.name));
        const best = ranked.filter(match => match.score === ranked[0]?.score);
        if (best.length > 1) {
            const suggestions = best.slice(0, 5).map(match => match.category.name).join('; ');
            return {
                error: true,
                message: `Multiple games match. Please use a more specific title: ${suggestions}`,
                status: 409,
                type: 'ambiguous_game'
            };
        }
        return {
            error: false,
            message: ranked.length ? 'Categories found' : 'No matching game found',
            data: ranked.map(match => match.category)
        };
    } catch (error) {
        console.error(`Error in searchCategories:`, {
            query,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
