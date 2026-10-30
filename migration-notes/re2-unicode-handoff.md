# node-RE2 Unicode facts prerequisite

**Status (2026-10-30): generated facts, SDK oracle, and Rust replay verified for the bounded prerequisite.** This pure standard-library API does not implement a regex engine, complete parser, or application adapter. It does not complete advanced moderation migration.

## Verified source and behavior

The final generator `--write` and `--check` used the pinned Node 24 source-built addon and pinned source snapshot. The final `--check` replay reproduced both artifacts byte-for-byte: fixture JSON SHA-256 `eac8a1d8ca6767065407a5835f6aeb724911d9007ab36dfd09592972c459e443`; generated Rust table SHA-256 `d22fab3f04e2433d8f5cd27cbf278414dee433ed83ec0014c8ae7e697d7e2ade`. It checked 3,336,192 exhaustive SDK category cases (`L`, `N`, `Lu`), 785,370 edge cases, and 5,864 ordered case-fold checks. Rust fold replay covers all 1,114,112 code-point values through U+10FFFF, including surrogate values. The wrapper header declares Unicode 17.0.0; the vendored RE2 tables have no declared Unicode version. Those version statements are distinct and must not be conflated.

The checked-in table generator parses the pinned C++ RE2 property and fold tables and wrapper property aliases. It does not derive native RE2 behavior from JavaScript Unicode regexes, lowercasing, or Unicode CaseFolding.txt. Observed differences include native `\pL` rejecting U+11DB0, U+A7CB, and U+1C8A, and U+0264 `/i` not matching U+A7CB. Namespace and prefix handling is source-ordered and case-sensitive; `scx=` uses wrapper Script_Extensions tables while `Script=` delegates to native RE2. These facts are useful for a future parser/adapter; they are not a parser implementation.

Evidence package: [`evidence/2026-10-30-advanced-moderation-prerequisites/`](evidence/2026-10-30-advanced-moderation-prerequisites/).

## Scope and remaining blockers

The helper exposes property lookup/resolution and native fold facts. Negation application, AST translation, parser syntax, RE2 matching, UTF-8/JS-string boundaries, pattern IDs/cache behavior, and full `matches` execution remain caller responsibilities. The experimental `re2_native` draft was unverified at the prerequisite freeze and is excluded from this verified scope. No release build, benchmark, deployment, caller adoption, or TypeScript retirement is implied. See the [advanced moderation prerequisite record](moderation-advanced-prerequisites.md).
