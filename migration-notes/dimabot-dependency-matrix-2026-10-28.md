# dimabot migration dependency matrix — 2026-10-28

The companion [JSON inventory](dimabot-dependency-matrix-2026-10-28.json) is an exhaustive **tracking inventory**, generated from the frozen [806-file baseline](dimabot-ts-baseline-2026-10-28.json) and the [12-file archive manifest](../archives/dimabot-typescript/2026-10-28/manifest.json). It preserves all baseline rows, including 633 application files, 167 test files, and six explicitly excluded React Email templates. The 12 archived source rows are recorded as retired snapshots; archive membership alone is not feature or dependency completion.

The generator initializes rows as unreviewed. The [credential/JWT caller audit](credential-jwt-callers-2026-10-28.md) subsequently reconciled those two primitive rows; their actual TypeScript consumers remain recorded as unadopted. Other rows still await reconciliation, including areas with separate prior feature evidence. The baseline's import specifier strings do not preserve whether an import is runtime or type-only, default or named, side-effect-only, or re-exported through a barrel. The generator keeps each specifier intact, labels this syntax as unresolved, and lists possible TypeScript targets for relative `.js` specifiers as candidates only. Review the source declaration before classifying the dependency. Then trace its concrete application adapter and transitive dependencies. npm runtime packages must be paired with an existing native crate/standard-library replacement or recorded as a blocking gap; npm package internals do not themselves need porting.

For each application file, complete the feature/export mapping, relevant Rust behavior evidence, accepted behavior changes, callers, and required runtime dependencies. For tests, record the behavior they establish and the Rust evidence that covers it; test files are not independent feature-port targets. A trait, mock, type declaration, matching filename, or matching export does not close an application dependency. Equivalent Rust types may satisfy type-only contracts when the source contract and equivalence are evidenced.

## Current evidence and limits

The [full migration note](full-dimabot-rust-2026-10-28.md) records the current bounded verified behavior areas, known compatibility gaps, and incomplete adapters. The earlier [completeness audit](rust-migration-completeness.md) reviews 41 exact source/Rust pairs and their dependency chains; its ratings do not extend to the remaining baseline rows. Do not promote either document's subset evidence into blanket status for this inventory.

Report three states separately:

- **Local Rust feature behavior:** only claim the portions backed by mapped source exports and relevant Rust behavior evidence.
- **Total dependency completeness:** unresolved until every required direct and transitive dependency has a concrete native implementation and accepted behavior evidence.
- **Caller adoption/deployment:** record separately; it is not required for 100% migration completion and this document authorizes no release.

No whole-project completion percentage is calculated here. The inventory has not source-reviewed all rows or reconciled all dependency graphs.

## Next bounded migration batches

Use feature-level vertical slices, updating the rows and evidence as each slice is reviewed:

1. Extend the completed standalone JWT and credential/configuration caller audit into native application consumers, preserving the recorded compatibility changes.
2. Close shared application adapters that block multiple verticals: logger/observability/inbox, auth/configuration, persistence/cache/PubSub, HTTP, and email. For each, include the concrete adapter and its transitive services.
3. Port domain-event and Twitch/EventSub producer-consumer paths, then the API routes and WebSocket handlers that consume them.
4. Migrate bot commands, handlers, and request-time action paths with their AST, timer, Twitch, billing, and storage integrations.
5. Migrate remaining workers one vertical at a time, retaining per-worker scheduling/pacing review and exact-candidate behavior evidence.
6. Reconcile all baseline test evidence and remaining utility/schema paths, then re-audit callers and dependency closure before claiming completion.

These are proposed work slices, not completion claims. Keep the Rust crate's no-new-dependency constraint from the active migration request; if an npm runtime dependency has no adequate existing Rust/native replacement, name it as a gap rather than silently substituting a mock.

## Regeneration

The authored generator is [dimabot-dependency-matrix-2026-10-28.mjs](dimabot-dependency-matrix-2026-10-28.mjs). From the repository root, run `node migration-notes/dimabot-dependency-matrix-2026-10-28.mjs` in the lead-owned task container. It reads only the baseline and archive manifest and writes the adjacent JSON; it does not execute tests, compile code, inspect production, or assess parity. It refuses to overwrite an existing ledger, preserving subsequent source reviews. Review the generated counts against the baseline before using it as the working ledger.
