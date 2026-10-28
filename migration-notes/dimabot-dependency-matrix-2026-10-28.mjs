#!/usr/bin/env node
// Generate the exhaustive row inventory from the frozen baseline without
// treating filenames, exports, Rust LOC, or import strings as proof of parity.
// Run from the repository root (prefer the task-owned compiler container):
//   node migration-notes/dimabot-dependency-matrix-2026-10-28.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const notesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(notesDir, '..');
const baselinePath = path.join(notesDir, 'dimabot-ts-baseline-2026-10-28.json');
const manifestPath = path.join(repoRoot, 'archives/dimabot-typescript/2026-10-28/manifest.json');
const outputPath = path.join(notesDir, 'dimabot-dependency-matrix-2026-10-28.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const archived = new Map(manifest.files.map((entry) => [entry.source, entry]));
const builtinSet = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function dependencyRow(sourceFile, specifier, ordinal) {
  let category = 'bare-package-candidate';
  let candidates = [];
  let baselineTargets = [];

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    category = 'relative-module-candidate';
    const sourceDir = path.posix.dirname(sourceFile);
    const rawTarget = path.posix.normalize(path.posix.join(sourceDir, specifier));
    candidates = [rawTarget];

    // TypeScript commonly writes .js specifiers for .ts source. Preserve the
    // original specifier, and enumerate TS source candidates without claiming
    // that any candidate is the semantic target.
    if (rawTarget.endsWith('.js')) {
      const stem = rawTarget.slice(0, -3);
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`);
    } else if (!path.posix.extname(rawTarget)) {
      candidates.push(`${rawTarget}.ts`, `${rawTarget}.tsx`, `${rawTarget}.d.ts`,
        `${rawTarget}/index.ts`, `${rawTarget}/index.tsx`, `${rawTarget}/index.d.ts`);
    }
    baselineTargets = [...new Set(candidates)].filter((candidate) => Object.hasOwn(baseline.files, candidate));
  } else if (builtinSet.has(specifier)) {
    category = 'node-builtin-candidate';
  }

  return {
    ordinal,
    specifier,
    specifierCategory: category,
    relativeSourceCandidates: candidates,
    baselineSourceTargets: baselineTargets,
    importSyntaxKind: 'unresolved-baseline-flattens-import-syntax',
    runtimeOrTypeDependency: 'unresolved-inspect-source-import-declaration',
    defaultSideEffectBarrelDetails: 'unresolved-inspect-source-import-declaration',
    directDependencyReview: 'unreviewed',
    transitiveDependencyReview: 'unreviewed',
    rustReplacementOrGap: 'unreviewed'
  };
}

const files = Object.entries(baseline.files).sort(([a], [b]) => a.localeCompare(b)).map(([source, row]) => {
  const archivedRow = archived.get(source);
  const excluded = row.role === 'react-email-template';
  return {
    source,
    baseline: { sha256: row.sha256, lines: row.lines, role: row.role },
    scope: excluded ? 'explicitly-excluded-react-email-template' : 'in-scope',
    inventoryDisposition: archivedRow
      ? 'source-retired-and-preserved-in-2026-10-28-archive'
      : 'baseline-source-row',
    archive: archivedRow ? {
      archivedPath: `archives/dimabot-typescript/2026-10-28/${archivedRow.source}`,
      sha256: archivedRow.sha256,
      nativeAreaReference: 'see archives/dimabot-typescript/2026-10-28/README.md; mapping is not dependency-completion proof'
    } : null,
    featureReview: archivedRow ? 'bounded-evidence-exists; full-feature-and-dependency-reconciliation-unreviewed' : 'unreviewed',
    localRustEvidence: [],
    behaviorDifferencesOrAcceptedChanges: [],
    callers: { sourceEvidence: [], runtimeStatus: 'unreviewed' },
    testEvidence: { sourceEvidence: [], rustBehaviorEvidence: [], status: 'unreviewed' },
    exports: row.exports.map((name) => ({ name, nativeMapping: 'unreviewed', evidence: [] })),
    imports: row.imports.map((specifier, ordinal) => dependencyRow(source, specifier, ordinal)),
    rowAssessment: 'unreviewed-no-feature-completion-inferred'
  };
});

const counts = files.reduce((result, file) => {
  result[file.scope] = (result[file.scope] ?? 0) + 1;
  result[file.baseline.role] = (result[file.baseline.role] ?? 0) + 1;
  return result;
}, {});

const output = {
  schemaVersion: 1,
  matrixDate: '2026-10-28',
  baseline: {
    path: 'migration-notes/dimabot-ts-baseline-2026-10-28.json',
    date: baseline.baselineDate,
    commit: baseline.baselineCommit,
    counts: baseline.counts,
    generatorCounts: counts
  },
  archiveManifest: 'archives/dimabot-typescript/2026-10-28/manifest.json',
  methodLimits: [
    'The baseline import list omits TypeScript import syntax. Runtime versus type-only, default, namespace, side-effect, and barrel semantics remain unresolved until source review.',
    'Relative .js specifiers are preserved exactly and possible .ts/.tsx/.d.ts source targets are listed as candidates only; candidate resolution is not proof of import semantics.',
    'Rows default to unreviewed. No feature completion is inferred from a Rust filename, matching export, LOC, type declaration, host trait, or mock.',
    'Test files are tracked as evidence obligations; they are not treated as one-to-one source-port targets.',
    'Archived source rows establish retained source snapshots only. Their bounded Rust evidence must be reconciled per feature and dependency.'
  ],
  completion: {
    localFeatureStatus: 'not-scored-by-this-inventory; consult cited feature-specific source and test evidence',
    dependencyCompleteness: 'not-established; direct and transitive application-specific adapters remain unreviewed in most rows',
    callerAdoptionAndDeployment: 'not-established-by-this-inventory; tracked separately; deployment is not a condition of migration completion',
    totalCompletionPercentage: null
  },
  files
};

// A later review may add evidence to the ledger. Never erase that review by
// regenerating the initial inventory in place.
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, {flag: 'wx'});
process.stdout.write(`Wrote ${files.length} source rows to ${path.relative(repoRoot, outputPath)}\n`);
