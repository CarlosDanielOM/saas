// Copies the bot's generated AST catalog into the command block editor, trimmed to the
// fields the UI uses. Run from dimasite/: `node scripts/sync-ast-catalog.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../../dimabot/src/utils/ai/ast_catalog/ast-catalog.json', import.meta.url);
const target = new URL('../src/app/features/commands/blocks/blocks-catalog.json', import.meta.url);

const catalog = JSON.parse(readFileSync(source, 'utf8'));
const entries = catalog.entries
  .filter((entry) => !entry.deprecated)
  .map((entry) => {
    const out = {
      name: entry.name,
      description: entry.description,
      syntax: entry.syntax,
      category: entry.category,
      examples: entry.examples.slice(0, 2),
      aliases: entry.aliases,
      level: entry.minUserLevel,
      destructive: entry.destructive || undefined,
      plan: entry.planTier,
      keywords: entry.keywords.slice(0, 8)
    };
    return Object.fromEntries(
      Object.entries(out).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
    );
  });

writeFileSync(target, `${JSON.stringify({ version: catalog.version, entries })}\n`);
console.log(`Wrote ${entries.length} functions (catalog ${catalog.version})`);
