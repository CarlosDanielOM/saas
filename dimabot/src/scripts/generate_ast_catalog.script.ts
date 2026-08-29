import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { buildCatalogFromRegistry, renderAuthoringDocs } from '../utils/ai/ast_catalog/build_catalog.js';
import type { AstCatalog } from '../utils/ai/ast_catalog/types.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Doc generation only reads registry metadata; it never touches crypto or the
// DB. The import chain still loads crypto.ts, which throws when SECRET_KEY is
// unset, so provide a placeholder when no real env is present.
if (!process.env.SECRET_KEY) {
    process.env.SECRET_KEY = 'ast-docs-generation-placeholder';
}

const OUTPUT_PATH = path.resolve(process.cwd(), 'src/utils/ai/ast_catalog/ast-catalog.json');
const GRAMMAR_PATH = path.resolve(process.cwd(), 'src/utils/ai/ast_catalog/ast-grammar.txt');
const AUTHORING_DOCS_PATH = path.resolve(process.cwd(), 'src/utils/ai/sandbox/doc-ast.txt');

function printCoverageReport(catalog: AstCatalog, registeredCount: number, errors: string[], warnings: string[]): void {
    const byCategory = new Map<string, number>();
    let aliasCount = 0;
    let destructiveCount = 0;
    let actionCount = 0;
    let authoringCount = 0;

    for (const entry of catalog.entries) {
        byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
        aliasCount += entry.aliases.length;
        if (entry.destructive) destructiveCount++;
        if (entry.surfaces.includes('action')) actionCount++;
        if (entry.surfaces.includes('authoring')) authoringCount++;
    }

    console.log('\n=== AST Command Catalog Coverage ===');
    console.log(`Registered names: ${registeredCount} (${catalog.entries.length} canonical + ${aliasCount} aliases)`);
    console.log(`Surfaces: ${actionCount} action, ${authoringCount} authoring`);
    console.log(`Destructive: ${destructiveCount}`);
    console.log('\nBy category:');
    for (const [category, count] of [...byCategory.entries()].sort()) {
        console.log(`  ${category}: ${count}`);
    }

    if (warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warning of warnings) console.log(`  WARN ${warning}`);
    }
    if (errors.length > 0) {
        console.log('\nErrors:');
        for (const error of errors) console.log(`  ERROR ${error}`);
    }
}

async function run(): Promise<void> {
    // Dynamic import so the SECRET_KEY fallback above is applied before the
    // registry's transitive imports (crypto.ts) evaluate.
    const { registerAllFunctions, getAllRegisteredFunctions } = await import('../utils/ast_parser/functions/index.js');
    registerAllFunctions();

    const registered = getAllRegisteredFunctions();
    const { catalog, errors, warnings } = buildCatalogFromRegistry(registered);

    printCoverageReport(catalog, registered.length, errors, warnings);

    if (errors.length > 0) {
        console.error(`\n[gen:ast-docs] FAILED with ${errors.length} error(s). Catalog not written.`);
        process.exit(1);
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');

    console.log(`\n[gen:ast-docs] Wrote ${catalog.entries.length} entries (version ${catalog.version}) to ${OUTPUT_PATH}`);

    const grammarText = fs.readFileSync(GRAMMAR_PATH, 'utf-8');
    const authoringDocs = renderAuthoringDocs(catalog, grammarText);
    fs.mkdirSync(path.dirname(AUTHORING_DOCS_PATH), { recursive: true });
    fs.writeFileSync(AUTHORING_DOCS_PATH, authoringDocs, 'utf-8');
    console.log(`[gen:ast-docs] Wrote authoring reference to ${AUTHORING_DOCS_PATH}`);
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[gen:ast-docs] Unexpected failure:', err);
        process.exit(1);
    });
