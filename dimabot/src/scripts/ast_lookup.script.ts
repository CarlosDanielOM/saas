import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

if (!process.env.SECRET_KEY) {
    process.env.SECRET_KEY = 'ast-docs-lookup-placeholder';
}

function parseFlags(): { query: string; surface?: string; level?: string; limit?: string } {
    const argv = process.argv.slice(2);
    let surface: string | undefined;
    let level: string | undefined;
    let limit: string | undefined;
    const queryParts: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--surface') { surface = argv[++i]; continue; }
        if (arg === '--level') { level = argv[++i]; continue; }
        if (arg === '--limit') { limit = argv[++i]; continue; }
        queryParts.push(arg);
    }

    return { query: queryParts.join(' ').trim(), surface, level, limit };
}

async function run(): Promise<void> {
    const { query, surface: surfaceFlag, level, limit: limitFlag } = parseFlags();

    if (!query) {
        console.log('Usage: npm run ast:lookup -- "<query>" [--surface action|authoring] [--level 1-10] [--limit n]');
        console.log('Example: npm run ast:lookup -- "start a poll" --level 10');
        process.exit(1);
    }

    const surface = surfaceFlag === 'authoring' ? 'authoring' : 'action';
    const maxUserLevel = Number.parseInt(level ?? '10', 10);
    const limit = Number.parseInt(limitFlag ?? '3', 10);

    const { searchAstCatalog, ensureAstCatalogVectors, getAstCatalog } = await import('../utils/ai/ast_catalog/index.js');

    const catalog = getAstCatalog();
    console.log(`Catalog version ${catalog.version} (${catalog.functionCount} functions)\n`);

    const vectorsReady = await ensureAstCatalogVectors();
    console.log(`Vector index: ${vectorsReady ? 'ready' : 'unavailable (keyword-only fallback)'}\n`);

    const { matches, vectorSearchUsed } = await searchAstCatalog(query, { surface, maxUserLevel, limit });

    if (matches.length === 0) {
        console.log('No matches.');
        process.exit(0);
    }

    console.log(`Matches (surface=${surface}, maxUserLevel=${maxUserLevel}, vectorSearch=${vectorSearchUsed}):\n`);
    for (const entry of matches) {
        console.log(`  ${entry.name}${entry.aliases.length ? `  (aliases: ${entry.aliases.join(', ')})` : ''}`);
        console.log(`    ${entry.description}`);
        console.log(`    syntax: $(${entry.syntax})`);
        console.log(`    level: ${entry.minUserLevel}${entry.destructive ? '  [DESTRUCTIVE]' : ''}  category: ${entry.category}`);
        console.log(`    examples: ${entry.examples.map((example) => `$(${example})`).join('  ')}`);
        console.log('');
    }
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[ast:lookup] Failed:', err);
        process.exit(1);
    });
