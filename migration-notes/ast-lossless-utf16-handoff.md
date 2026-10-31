# AST lossless UTF-16 handoff — 2026-10-31

Contract A remains **open**. Team4's exact examples are pending. This is static
authoring only: no tests, builds, formatters, or runtime checks were run.

The shared parser already owns grammar, budgets, diagnostics, template scanning
and AST JSON persistence; the evaluator already exposes `ast_evaluator::JsString`
and renders into it. Reuse those paths. `PersistedJsString` is an additive Serde
adapter around that existing type, storing code units as a JSON array; it does
not integrate with `AstNode` or provide a lossless parse entry. Its array shape
is internal to the proposed extension, not a claim of TypeScript JSON parity.
It is gated on `ast-evaluator` because `ast-syntax` can be built without that
module. Existing UTF-8 AST JSON has not been changed.

`ast_lossless_utf16.rs` authors checks for the adapter and the existing renderer
when a host returns mixed ordinary text and a lone high or low surrogate. This
does not test parsing or persisting an AST containing such a string: neither is
available. It also does not substitute for team4's source-parity examples.

## Single-owner integration contract

**Owner: team3-bot-ast.** In one coordinated change across the shared AST
syntax and evaluator, implement and verify all of the following:

1. Add an entry accepting `JsString` code units, preserving the current `&str`
   APIs and profiles. Adapt `source.rs`, `tokenizer.rs`, `parser.rs`, and
   `scanner.rs` as needed so syntax, quoted decoding, templates, nested
   expressions, UTF-16 spans and resource budgets operate on the same original
   code units. Do not replace surrogates, use collision-prone sentinel characters,
   or introduce an overlay parser. Define behavior for all grammar-bearing
   fields, including names, and for invalid syntax and diagnostics.
2. Add an explicit, backward-compatible persisted representation for lossless
   AST literals and template text, retaining existing JSON for UTF-8 inputs.
   Reuse `JsString` and the adapter where appropriate; resolve the independent
   `ast-syntax` feature boundary without making the existing syntax-only build
   depend cyclically on `ast-evaluator`. Account for JSON depth in
   `persistence.rs` and all exhaustive `AstNode`/`TemplateSegment` consumers.
3. Update `evaluator/vm.rs` and template rendering and compatibility/source
   matching in `evaluator.rs` to carry the same units through evaluation and
   rendering, including text segments, without `to_utf8` conversion. Ensure
   existing UTF-8 behavior and diagnostics remain unchanged.
4. Author and run isolated tests for team4's exact examples, plus mixed text
   with each lone surrogate, nested expressions, template text, source spans,
   limits, AST JSON round trips, evaluation and rendered output. Verify both
   syntax-only and evaluator feature configurations and old JSON fixtures.

Adding an AST variant in the owned files alone would break exhaustive matches
in the persistence validator and VM and would not make the UTF-8 scanner able to
read the input. An adapter or host-result test alone does not close this contract.
No deployment or caller adoption is implied by this handoff.

## Static follow-up and integration boundary

The source fixture in `dimabot/tests/ast_lossless_utf16.rs` now records both
lone-surrogate cases in mixed outer text and a quoted nested interpolation, and
round-trips the fixture's code units through the existing adapter. A separate
UTF-8 scanner case records half-open UTF-16 spans after a supplementary scalar.
These are fixture and existing-API checks only: they do not exercise a lossless
parser, AST persistence, or rendering of that source. They were not run.

The current implementation still uses `Arc<str>` for the shared source and
decoded views, byte ranges throughout the lexer and scanner, and `String` for
AST values, names and exported source segments. Replacing a surrogate at any of
those boundaries loses information. A completed change must carry code units
through all of them, including quoted-view source maps and custom grammar
matching, rather than only adding a new entry point or storage adapter.

Cross-file integration contract for a representation using new AST variants:
`dimabot/src/utils/ast_blocks/from_ast.rs` matches `TemplateSegment` exhaustively
and must handle the new text variant (and explicitly accept or reject any new
literal variant). The overlay validator in `dimabot/src/overlays/ast.rs` accepts
existing literals and must explicitly decide whether to accept a lossless literal;
its wildcard currently rejects other variants. Block values and host-facing names
are UTF-8 strings, so their conversion policy must be explicit rather than lossy.
If a different representation is selected, audit those same consumers and all
other public exhaustive matches for compatibility. These files are outside this
authoring scope and were not changed.

## Team3 conversion policy and unresolved integration contract

The following is the proposed conversion policy before introducing any new AST
variants; it is not an assertion that the implementation exists or that the
TypeScript oracle has been executed.

- The source and decoded values must retain the original sequence of UTF-16
  units. Paired surrogates are not split or normalized, and lone surrogates are
  never replaced. Scanner and lexer positions, decoded quoted-view maps, and
  limits are measured in original JavaScript code units. Existing UTF-8 inputs
  retain their current public APIs and persisted JSON shape.
- The TypeScript tokenizer and registry use string indexing and `slice` on
  JavaScript strings, including quoted interpolation and variable/function
  names. Therefore a non-UTF-8 name cannot be silently replaced or rejected at
  lexing solely because Rust `String` cannot represent it. Its syntax and
  diagnostic must follow the source oracle; host dispatch must either carry the
  exact units or return an explicit, non-lossy boundary error. The exact error
  and source parity require execution of the real source, not a guessed value.
- Existing block fields are Rust `String`. Their current accepted values and
  behavior remain unchanged. A lossless AST value that converts to UTF-8 may use
  the existing block conversion; a value containing an unpaired surrogate must
  return a structured conversion error at its field, never a replacement
  character. Consequently a block round trip for such a value requires an
  explicitly agreed additive block representation and reverse conversion; an
  error alone is not the requested round trip. `from_ast.rs` alone cannot add
  such a representation to the block model or its serializer.
- Existing `PersistedJsString` is a code-unit-array adapter, not the existing
  TypeScript JSON shape. Any new persisted form must be versioned or otherwise
  unambiguous, preserve old UTF-8 JSON, be included in the JSON-depth guard,
  and round-trip without relying on JSON strings that `serde_json::Value`
  cannot represent. A real BSON fixture must establish the actual driver and
  JavaScript storage behavior separately; do not assume BSON strings can carry
  lone surrogates or treat an integer-array adapter test as that fixture.
- Overlay validation remains team4-owned: it must traverse every branch and
  explicitly accept the agreed lossless literal/text representation while
  retaining the source's 2,000-unit, 300-node and depth-20 limits and its
  8,000-unit rendered slice. Neither this policy nor a parser entry grants
  permission to modify that consumer.

Two ownership/feature boundaries need a concrete contract before an end-to-end
implementation can be integrated: `ast-syntax` currently builds without
`ast-evaluator`, but the canonical `JsString` lives in the latter; and block
round-trip storage requires edits outside team3's assigned `from_ast.rs`.
Resolve these by assigning an owner for a shared, feature-independent canonical
string definition/re-export and an owner for additive block storage and reverse
conversion. Names, serialization shape, and error types must be agreed with those
owners, and all exhaustive consumers must be audited. No implementation,
source-oracle comparison, BSON fixture, build, or runtime verification is
claimed by this section.

## Team3 v2 interface decision — 2026-10-31 (implementation open)

The intended additive syntax interfaces for team4 are
`SyntaxEngine::parse_utf16(&self, input: &JsString) -> Result<CompiledProgramUtf16, Diagnostic>`
for the whole-program grammar and
`SyntaxEngine::compile_template_utf16(&self, input: &JsString) -> Result<CompiledTemplateUtf16, Diagnostic>`
for the distinct chat-template grammar. These names and types are a **proposed
integration contract, not currently callable**. Existing UTF-8 methods and
compiled types remain unchanged. The lossless compiled program exposes
`source(&self) -> &JsString`, `root(&self) -> &AstNode`, and `stats(&self) ->
ParseStats`; the lossless template exposes its source and ordered segment plans,
including per-expression program or diagnostic, with source spans in UTF-16 units.
The AST uses the existing UTF-8 `Literal`/`Text` variants where representable,
and additive `AstNode::LiteralUtf16 { value: PersistedJsString }` and
`TemplateSegment::TextUtf16 { value: PersistedJsString }` for non-UTF-8 values.
Their distinct tagged JSON types and integer-array values make the extension
unambiguous without changing legacy JSON. This proposal is subject to the
source oracle and integration review; no consumer should assume it is implemented.

Traversal must inspect every child, including all ternary branches, function and
command arguments, array accessors, selectors, loop clauses and bodies, and
expressions nested in templates, irrespective of runtime reachability. Literal
and text UTF-16 variants are leaves. Names must be parsed by the source grammar;
the proposed variants do not license accepting a surrogate in an identifier or
coercing one to UTF-8. Exact source outcomes and diagnostics remain unknown until
the guarded source fixture runs. JSON arrays are a native lossless representation;
no claim is made about how Node's BSON serializer stores unpaired surrogates.

The shared `JsString` and pure `EvalError` have been extracted into the
syntax-owned module, with the two evaluator re-export paths retained. The
storage adapter now depends only on syntax. This static change is unverified;
none of the proposed parser, compiled-plan, AST-variant, block, or VM changes
above are implemented by the extraction. No Node/BSON observation was made.

## G4 implementation pass — 2026-10-31

The preceding status is superseded in part: `literalUtf16` and `textUtf16`
AST tags now store `PersistedJsString` unit arrays, the persistence depth walk
counts those arrays, and the VM evaluates both forms without UTF-8 conversion.
An internal UTF-16 view retains original-unit boundary maps through the same
ordered quoted escape substitutions as the existing view. Authored tests cover
the view and JSON-to-VM unit preservation; none have been executed.

This is **not** a lossless parser or block round trip. The new view is not wired
to the byte-based lexer, parser, scanner, or compiled plans. At that point the
block importer returned a structured error at the value for the new forms;
the later Team3 v2 block section adds additive block storage and reverse
conversion. The overlay validator's wildcard rejects `literalUtf16`; its owner
must explicitly accept it when the shared entry point is integrated. Existing
UTF-8 AST tags are unchanged.

The read-only oracle specifies isolated high D800, low DC00, mixed A/D800/B/
DC00/C, paired D83D DE00 followed by D800, quoted interpolation with D800 and
DC00, a malformed unclosed interpolation, an unknown function, and 2000/2001
unit limits. Its source outcomes and BSON behavior remain unobserved: the
fixture was not executed. Do not interpret the new hand-authored tests as source
parity or integration evidence. Syntax-only, blocks-only and evaluator builds,
depth tests, end-to-end parsing, block serialization and exact fixture checks
all remain for the named verification lease.

## G5 static boundary audit — implementation still open

The TypeScript `parseVariable` in `registry.ts` takes its raw name directly
from the token stream and places it in the AST. Function names instead use an
ASCII identifier check. Rust's variable and command name fields are `String`,
and their consumers include block conversion and evaluator host dispatch. A
unit-preserving lexer alone therefore cannot represent every source-accepted
name. Integrating lossless names needs a coordinated AST/storage and consumer
boundary decision, including explicit host dispatch behavior; it must not
silently replace units or reject them merely because UTF-8 conversion fails.
Block conversion is a separate follow-up and was not changed here.

`overlay_utf16_reference.cjs` already authors the exact team4 source inputs
and captures actual `parseTemplate` results, errors and rendered units. Its
output remains unobserved; no outcome is inferred from the fixture inputs. The
proposed `parse_utf16` and `compile_template_utf16` methods remain unavailable,
and no shared scanner, lexer, parser or compiled-plan implementation was added
in this pass. The integration owner still needs to coordinate the name and
consumer representation, the block round trip and the isolated oracle lease.

## Team3 v2 block authoring — 2026-10-31 (authored, unexecuted)

This pass adds the additive block representation and reverse conversion inside
the team3-owned block files only. It does not add a parser or change the
evaluator, overlay, Cargo features, or any core JSON/JS path. No build, test,
formatter, Node, BSON, container, or source-oracle run was executed.

Implemented boundaries:

- `BlockKind::LiteralUtf16 { value: PersistedJsString }` stores exact JavaScript
  UTF-16 code units as a JSON integer array under the distinct `literalUtf16`
  block tag. `stored_blocks_lossless` emits envelope version `2`; the original
  `stored_blocks` version `1` JSON and all existing block kinds are unchanged.
  `read_block_root` reads version-1 roots and roots containing the additive
  kind; it validates the root itself and does not inspect the envelope version.
- The validated reader rejects non-array, non-integer, and out-of-`u16` values
  with `INVALID_UTF16`, enforces the existing 10,000-unit text limit, and
  canonicalizes a `literalUtf16` whose units form valid UTF-8 into the original
  `literal` block. Only genuinely unpaired units remain `literalUtf16`.
- `ast_to_block` now accepts `AstNode::LiteralUtf16` and
  `TemplateSegment::TextUtf16`; UTF-8-representable units use the existing
  literal path, and unpaired units use the additive block. `block_to_ast` and
  `block_root_to_ast` reverse every block kind with an AST form, including both
  lossless literal and template-text forms. Advanced/raw source and transient
  groups return an explicit `UnsupportedSyntax` instead of being guessed.
- `root_to_source_utf16` and `top_level_utf16` return exact `JsString` units.
  The existing `root_to_source`, `top_level`, `compile_blocks`, and other UTF-8
  entry points remain unchanged for UTF-8 input and return `UNPAIRED_SURROGATE`
  with the offending block field for unpaired units; they never emit a
  replacement character or sentinel. Normalization merges adjacent lossless
  literals and converts a merged value back to `literal` when the combined
  units become valid UTF-8.
- The block module still depends only on `ast_syntax`, not `ast_evaluator`.
  The authored tests in `src/utils/ast_blocks/tests.rs` compile with the
  `ast-blocks` feature; `tests/ast_lossless_utf16.rs` now runs under either
  `ast-blocks` or `ast-evaluator`, with evaluator-only cases gated.

Authored but unexecuted checks:

- Version-1 stored JSON and the old UTF-8 editor/export entry points.
- A root literal containing a lone high surrogate, a lone low surrogate, a
  paired pair followed by a lone high, and a lone low/high mix: AST → block →
  version-2 stored JSON → reader → exact-unit source → reverse AST, plus the
  structured UTF-8 boundary error.
- Template text containing both lone surrogate values, nested in a function
  argument, with the exact source units and reverse AST equality.
- Lossless reader rejection of negative, out-of-range, string, and null unit
  values, plus the 10,000/10,001-unit boundary.
- Invalid source identifiers: `$(1bad)` and `%(1bad)` stay advanced/raw on
  source import, and the validated reader rejects `1bad` as a function or
  variable name with `INVALID_NAME`.

Remaining contract, not claimed complete:

- `SyntaxEngine::parse_utf16` and `compile_template_utf16`, and therefore
  source → blocks import for a `JsString` containing lone surrogates, remain
  unavailable. `import_command_text` still accepts only `&str`; it is not
  silently truncating or replacing surrogate input because it cannot receive
  one.
- The editor's top-level source re-scan in `compile_blocks` is UTF-8-only. There
  is no lossless `compile_blocks` counterpart that verifies a non-UTF-8 chat
  root through the real scanner. `root_to_source_utf16` is an exact output
  boundary, and `read_block_root` is the validated storage boundary, but the
  full editor round-trip guarantee for unpaired units is not available.
- The evaluator/VM, overlay validator, `commands` schema persistence, and the
  actual Node/BSON storage behavior were not changed or observed here. The
  overlay owner must explicitly accept the new AST forms; the schema only
  gains the additive Serde variant.
- All checks above are authored only. Syntax-only, blocks-only, evaluator,
  depth, and end-to-end fixture runs remain for the named verification lease.

