# Native RE2 adapter handoff (2026-10-30)

The native adapter is implemented in Rust and integrated with advanced
moderation. Parser source `5c50d884` and literal-optimization source `71a4ff8c`
were verified by the lead's isolated compiler and fixture workflow. This is
local feature evidence; existing application callers remain TypeScript, and
there has been no release, deployment, source retirement, push, or claim of
100% total migration completion.

## Source-backed parser and engine boundary

The parser adaptations follow pinned `node-re2` `lib/pattern.cc` and native
RE2 `vendor/re2/re2/parse.cc`; they are not claimed as independently invented
grammar. node-re2 and RE2 copyright notices, BSD-3-Clause terms, and
redistribution conditions remain in
[node-re2's license](../dimabot/tests/fixtures/re2-source-licenses/node-re2-BSD-3-Clause.txt),
[RE2's license](../dimabot/tests/fixtures/re2-source-licenses/RE2-BSD-3-Clause.txt),
and the [source notice](../dimabot/tests/fixtures/re2-source-licenses/NOTICE.md).

The adapter has two ordered stages. SDK preprocessing works on raw rune values
decoded from JS UTF-16, retaining unpaired surrogates. It handles uppercase
`\\c` controls, one-to-four-digit and braced `\\u`, property aliases,
binary/scx range expansion, slash escaping, and named-group header spelling
before native quoted-span interpretation. Wrapper binary/scx complements
inside classes expand before folding; native property complements fold the
positive property before complementing it. Unknown property names are left for
native parsing, including literal text inside quoted spans.

A dedicated RE2 token/class parser emits normalized syntax for the existing
bytes regex engine; the separately verified `re2_compat::translate` consumer
path remains unchanged. Native escaped literals, octal/hex, terminated and
unterminated `\\Q` spans, ASCII Perl/POSIX classes, native properties, group
scope, inline `i/m/s/U`, capture-name validation, repetition syntax, the 1,000
repeat limit, nested count products, and leading-zero brace literals are
handled before compilation. Native `u` and `x` flags remain invalid. Capture
names are validated against pinned native identifier categories and erased
from emitted group headers while preserving numbered captures; duplicate names
are rejected.

Classes are normalized inclusive range sets. Explicit ranges are accumulated
and folded together; native class/group negation occurs at the corresponding
stage. Folding uses the pinned cycle table and checks only mapped entries;
literal folding visits the supplied rune's cycle directly. No class performs
full-domain scalar enumeration or engine `is_match` calls. The adapter reuses
pinned Unicode facts and string codec; it adds no Cargo package or direct
`regex-syntax` edge. Raw and escaped surrogate rune values remain numeric until
scalar-range emission; emitted intervals clip surrogates because the SDK
string-input UTF-8 path cannot contain them. Surrogate-only atoms emit an
impossible Unicode class while retaining quantifier and group behavior.

`exec` uses `re2_string` for string-input encoding, capture byte decoding, and
SDK UTF-16 indices. It returns numbered captures, raw byte offsets, UTF-16
offsets, and the requested indices flag. `\\C` remains an arbitrary byte atom.
Whole-word wrapping, compile-on-empty rejection, caches, and application
orchestration remain in the application adapter. Named-capture maps, Buffer
inputs, and global/sticky or other source-level flag APIs are outside the
declared non-global string `u`/`iu` plus indices surface.

## Verification and limits

The corrected implementation passed all 4,364 cases of the expanded SDK syntax
oracle and the original 740-case SDK corpus:
91 direct RE2, 604 regex behavior, and 45 wrapper cases. The advanced
application source replay separately passed 464 parse/match cases. These are
finite corpora, not a formal proof of all RE2 grammar or complete SDK parity.
The earlier implementation's 405/4,364 syntax mismatches remain recorded in
history; the expanded corpus was not reduced to obtain a pass.
See the [syntax-oracle handoff](re2-syntax-oracle-handoff.md) and
[integrated moderation evidence note](moderation-advanced.md) for evidence
locations and broader limits.

Rust regex limits and resource behavior can differ from native RE2. Property
expansion and normalized compilation allocate, and deeply nested group
construction can copy intermediate strings; no comprehensive production
resource profile or memory policy has been established. Exact native matching
priority and arbitrary mixed byte/rune/zero-width boundaries are not
established by the finite corpus. `re2_string::decode_capture` retains its
bounded malformed-byte evidence. Public SDK compile error wording and class
are not reproduced by the moderation matcher, which exposes its native compile
failure. Do not claim exact diagnostic parity or full SDK API parity.

The isolated compiler and runtime checks used the production-host caps stated
in `dimabot/RUST_AGENTS.md`; no production container or data resource was used.
No new Cargo dependency was introduced. Caller adoption and deployment remain
separate from native feature completion.
