# Moderation text utilities: normalize and links (2026-10-29)

## Scope and migration status

This verified slice maps both declared `normalize.ts` exports (`foldText`, `escapeRegExp`) and the declared `links.rule.ts` exports (`LinksEvaluationResult`, `evaluateLinksRule`) to native code with the selected type-only schema field. Their required direct and transitive value dependencies are implemented by the existing JavaScript string type, compatibility helpers, and Unicode 17/NFD core. Neither selected path requires an application service adapter.

The ports cover the declared typed contracts and preserve each explicit nullish fallback. Arbitrary invalid JavaScript casts, executable coercion hooks, and custom prototypes are outside the selected interfaces.

This updates exactly two source rows in the 806-row dependency inventory: locally complete mappings now total 15, with seven partial source rows unchanged. Total migration completion remains incomplete and unscored. Caller adoption/deployment are separate: all TypeScript sources and callers remain live, no source was archived or retired, and no deployment or push occurred. No crate, lockfile, or worker-profile change was made. The caps, emote-spam, and Unicode shared-core evidence remains separately scoped.

## Contracts and implementation

### `normalize.ts`

The source has no imports and exports `foldText(text: string): string` and `escapeRegExp(text: string): string`. Native `fold_text(Some(&JsString))` performs the source fold through the Unicode 17 core; `None` represents the explicit nullish `text ?? ''` fallback for null and undefined. `escape_reg_exp(&JsString)` adds a backslash before precisely the source's ASCII regex metacharacters and leaves other UTF-16 units unchanged, including lone surrogates. The selected type contract does not model arbitrary invalid JavaScript casts, custom hooks, or prototypes. `escapeRegExp` does not have a nullish fallback in the source.

The implementation reuses `JsString`, the shared Unicode 17 lowercase/Mark/NFD behavior, and the existing `unicode-normalization` 0.1.26 crate with Unicode 17 assigned boundaries. See the [Unicode core handoff](js-unicode-core-handoff.md) for the normalization-version argument. No new dependency or application adapter is required for these exports.

### `links.rule.ts`

The one runtime export is `evaluateLinksRule`; its only import is the type-only `Pick<IModerationRule, 'allowlistDomains'>`. The schema declares that field as a required `string[]`; the Rust API uses equivalent string values and explicit optional references for the source's nullish fallback. The result retains `triggered`, the ordered duplicate-preserving list of extracted hosts, and the first blocked host.

The JavaScript expression is deliberately permissive and is not a URL validator: `/(?:https?:\/\/|www\.)[^\s]+|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?/gi`. The native UTF-16 scanner preserves its non-Unicode ASCII word/letter classes, JS whitespace behavior, global left-to-right matches, greedy dotted continuation, protocol/www matches, permissive hostname extraction, duplicates, and first-blocked result. It precomputes maximal word, letter, and non-whitespace run endpoints plus the greedy continuation result at each offset, so failed prefixes do not repeatedly rescan the same suffix. The whole URL match is lowercased before splitting hostname from path/query/fragment and port; this retains contextual Unicode lowercase behavior. Allowlist domains are lowercased without trimming, and subdomains match an allowlist only at the dot boundary. This remains the source's permissive matcher, not standards-based URL parsing.

The TypeScript rule registry and moderation handler still call the TypeScript evaluator. This does not port broader blacklist term compilation, advanced regexes, variations, moderation settings, offense handling, or enforcement.

## Source binding and verification

The final source snapshot has 1,324 inputs and SHA-256 `a60560797db690243386bfeb50452739fa712cd4a46730c074baef4ff5338025`, bound to code commit `8023df02b4fb6fe90278238941c43de9c878c26a`. The exact `links.rule.ts` source SHA-256 is `802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0`; its selected schema SHA-256 is `e7ab82dd1eb02eaaddc5cfc93f41a4b8ff09b14ce0b488a870cbf5c727a23653`. The source-oracle readback also bound `normalize.ts` at `07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab`. Both actual-source checks use Node 24.22.1, V8 13.6.233.17-node.58, ICU 78.3, Unicode 17.0 and TypeScript 5.9.3.

- Both Node source-oracle attempts passed write/check; final run `1793306498927961527` covers 45,057 actual-TypeScript links cases, 228 normalization cases and two separate nullish normalization cases. The links oracle checked the full source AST and export set, the type-only schema field, strict TypeScript diagnostics, runtime execution with unexpected `require` calls rejected, UTF-16 outputs and ordered JSON wires. The normalize oracle checked the complete source shape and both actual VM exports.
- The initial compiler phase `1793306498926949161` passed three links ordinary tests and one normalization ordinary test. Final phase `1793306568333996549` passed the 45,057-case link replay, normalization replay, five existing caps/emote-spam regression checks, no-feature checks, Mongo/Redis profile checks, all-feature/all-target checks, formatting and strict Clippy.
- The isolated compiler used 6 CPUs, 4 GiB memory with memory-swap equal to memory (no swap), 256 PIDs and two Cargo jobs. The compiler step took 112.097 seconds and the workflow took 119.043 seconds. Minimum available memory was 8,620,507,136 bytes and the task cache was 3,825,397,760 bytes. Final readback recorded 19 production records unchanged and zero remaining task-owned resources.

The first compiler candidate (`31d05bda6e61ae4feca10fb30889c99139a30ee0cd630e448a3b4508e10a3a3c`, run `1793306445067569104`) failed only on a redundant test closure; the parent corrected it to `.map(&units)`. The failed candidate and its fixture are retained. Both Node attempts passed, and no source-oracle failure is hidden by the final candidate.

No benchmark was run, so there is no speed, CPU, RSS, or application-latency claim. The evidence package contains 55 files and 54 indexed payloads at [moderation-text evidence](evidence/2026-10-29-moderation-text/README.md); all indexed and compressed raw payload hashes were independently verified. The recorded production readback shows no production changes and no remaining owned resources.

## Remaining work

Only the selected utility and pure rule exports are mapped. The TypeScript sources, blacklist/advanced/variation consumers, registry, handler, settings persistence, and enforcement remain unadopted. These two rows do not close any surrounding moderation application dependency or establish total migration completeness.
