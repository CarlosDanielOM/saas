import { createHash } from 'crypto';
import type { RegisteredFunctionEntry } from '../../ast_parser/evaluator.js';
import type { AstCatalog, AstCatalogEntry, CatalogBuildResult } from './types.js';

export const AST_CATALOG_MODEL = 'lfm2.5-embedding-350m';
export const AST_CATALOG_DIM = 1024;

function hashEntries(entries: AstCatalogEntry[]): string {
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/**
 * Builds the AST command catalog from registered function metadata.
 * - Validates every entry (errors fail generation)
 * - Folds aliasOf entries into their canonical entry's aliases list
 * - Applies defaults (minUserLevel 1, both surfaces)
 */
export function buildCatalogFromRegistry(registered: RegisteredFunctionEntry[]): CatalogBuildResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const entry of registered) {
        const meta = entry.metadata;
        if (!meta) {
            errors.push(`Function '${entry.name}' has no metadata. Add metadata to its registerFunction call.`);
            continue;
        }
        if (!meta.description || !meta.description.trim()) {
            errors.push(`Function '${entry.name}' is missing a description.`);
        }
        if (!meta.syntax || !meta.syntax.trim()) {
            errors.push(`Function '${entry.name}' is missing a syntax string.`);
        }
        if (!meta.category || !meta.category.trim()) {
            errors.push(`Function '${entry.name}' is missing a category.`);
        }
        if (!meta.examples || meta.examples.length === 0) {
            errors.push(`Function '${entry.name}' needs at least one example.`);
        }
        if (!meta.keywords || meta.keywords.length === 0) {
            warnings.push(`Function '${entry.name}' has no keywords (bilingual en+es recommended).`);
        }
    }

    const names = new Set(registered.map((entry) => entry.name));
    for (const entry of registered) {
        const aliasOf = entry.metadata?.aliasOf;
        if (aliasOf && !names.has(aliasOf)) {
            errors.push(`Function '${entry.name}' declares aliasOf '${aliasOf}', which is not registered.`);
        }
    }

    const canonicalByName = new Map<string, AstCatalogEntry>();
    const canonicalOrder: string[] = [];

    for (const entry of registered) {
        if (entry.metadata?.aliasOf) continue;
        const meta = entry.metadata;
        if (!meta) continue;

        const catalogEntry: AstCatalogEntry = {
            name: entry.name,
            description: meta.description.trim(),
            syntax: meta.syntax.trim(),
            category: meta.category.trim(),
            examples: meta.examples.map((example) => example.trim()).filter(Boolean),
            aliases: [],
            minUserLevel: meta.minUserLevel ?? 1,
            keywords: (meta.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean),
            destructive: meta.destructive === true,
            surfaces: meta.surfaces ?? ['action', 'authoring']
        };
        if (meta.deprecated) catalogEntry.deprecated = meta.deprecated;
        if (meta.planTier) catalogEntry.planTier = meta.planTier;

        canonicalByName.set(entry.name, catalogEntry);
        canonicalOrder.push(entry.name);
    }

    for (const entry of registered) {
        const aliasOf = entry.metadata?.aliasOf;
        if (!aliasOf) continue;
        const canonical = canonicalByName.get(aliasOf);
        if (canonical && !canonical.aliases.includes(entry.name)) {
            canonical.aliases.push(entry.name);
        }
    }

    const entries = canonicalOrder.map((name) => canonicalByName.get(name) as AstCatalogEntry);

    const catalog: AstCatalog = {
        version: hashEntries(entries),
        generatedAt: new Date().toISOString(),
        model: AST_CATALOG_MODEL,
        dim: AST_CATALOG_DIM,
        functionCount: entries.length,
        entries
    };

    return { catalog, errors, warnings };
}

/**
 * The text that gets embedded for semantic search. Keep stable: the runtime
 * index and any future re-embedding must produce identical documents.
 */
export function buildEntryEmbeddingText(entry: AstCatalogEntry): string {
    const parts = [entry.name];
    if (entry.aliases.length > 0) {
        parts.push(`Also known as: ${entry.aliases.join(', ')}`);
    }
    parts.push(entry.description);
    parts.push(`Syntax: ${entry.syntax}`);
    if (entry.keywords.length > 0) {
        parts.push(`Keywords: ${entry.keywords.join(', ')}`);
    }
    return parts.join('. ');
}

/**
 * Renders the authoring reference (doc-ast.txt) used by the code_execution
 * planner: the static grammar header plus every authoring-surface function
 * grouped by category, in the same comment style as doc-llm.txt.
 */
export function renderAuthoringDocs(catalog: AstCatalog, grammarText: string): string {
    const lines: string[] = [
        '# ==========================================',
        '# COMMAND VARIABLES & LOGIC (generated from the AST function registry)',
        `# Catalog version: ${catalog.version}`,
        '# ==========================================',
        '',
        grammarText.trimEnd(),
        ''
    ];

    const byCategory = new Map<string, AstCatalogEntry[]>();
    for (const entry of catalog.entries) {
        if (!entry.surfaces.includes('authoring')) continue;
        if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
        byCategory.get(entry.category)!.push(entry);
    }

    for (const [category, entriesInCategory] of [...byCategory.entries()].sort()) {
        lines.push(`# --- ${category} ---`);
        for (const entry of entriesInCategory.sort((a, b) => a.name.localeCompare(b.name))) {
            const aliasNote = entry.aliases.length > 0 ? ` (aliases: ${entry.aliases.join(', ')})` : '';
            lines.push(`# $(${entry.syntax}) - ${entry.description}${aliasNote}`);
            for (const example of entry.examples) {
                lines.push(`#   Example: $(${example})`);
            }
        }
        lines.push('#');
    }

    return `${lines.join('\n')}\n`;
}
