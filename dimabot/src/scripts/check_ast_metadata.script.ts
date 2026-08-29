import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

if (!process.env.SECRET_KEY) {
    process.env.SECRET_KEY = 'ast-docs-check-placeholder';
}

/**
 * Guard: every registered AST function must carry catalog metadata.
 * Exits non-zero when any function is undocumented, so it can gate builds/CI.
 */
async function run(): Promise<void> {
    const { registerAllFunctions, getAllRegisteredFunctions } = await import('../utils/ast_parser/functions/index.js');
    const { buildCatalogFromRegistry } = await import('../utils/ai/ast_catalog/build_catalog.js');

    registerAllFunctions();

    const registered = getAllRegisteredFunctions();
    const { errors, warnings } = buildCatalogFromRegistry(registered);

    for (const warning of warnings) {
        console.warn(`WARN ${warning}`);
    }

    if (errors.length > 0) {
        for (const error of errors) {
            console.error(`ERROR ${error}`);
        }
        console.error(`\n[check:ast-metadata] ${errors.length} undocumented/broken function(s). Fix metadata before merging.`);
        process.exit(1);
    }

    console.log(`[check:ast-metadata] OK - all ${registered.length} registered AST functions documented.`);
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[check:ast-metadata] Unexpected failure:', err);
        process.exit(1);
    });
