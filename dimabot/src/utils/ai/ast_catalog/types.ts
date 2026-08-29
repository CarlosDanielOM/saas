import type { AstFunctionSurface } from '../../ast_parser/types.js';

/**
 * One documented AST function in the generated catalog.
 * Alias names are folded into their canonical entry's `aliases` list.
 */
export interface AstCatalogEntry {
    name: string;
    description: string;
    syntax: string;
    category: string;
    examples: string[];
    aliases: string[];
    minUserLevel: number;
    keywords: string[];
    destructive: boolean;
    deprecated?: string;
    planTier?: 'free' | 'premium' | 'pro';
    surfaces: AstFunctionSurface[];
}

/**
 * Generated AST command catalog. Built from the function registry metadata
 * by `npm run gen:ast-docs` and committed as ast-catalog.json.
 * Vectors are NOT stored here; the runtime index embeds entries at boot.
 */
export interface AstCatalog {
    /** Content hash of the entries; changes whenever docs change */
    version: string;
    generatedAt: string;
    /** Embedding model the runtime index uses (informational) */
    model: string;
    dim: number;
    functionCount: number;
    entries: AstCatalogEntry[];
}

/** Result of building the catalog from registry metadata */
export interface CatalogBuildResult {
    catalog: AstCatalog;
    errors: string[];
    warnings: string[];
}
