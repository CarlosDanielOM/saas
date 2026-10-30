# AI-credit reader protocol verification — 2026-10-30

`dimabot/tests/ai_credit_reader_protocol.rs` is an accepted ignored, serial integration suite for the concrete reader. The final isolated compiler-fixtures phase passed it with the reader's private MongoDB and Redis adapters plus a loopback HTTP peer. The exact candidate source is bound to commit `c6ac8d0fa4a68e98bc2dd3c8466bce0d1f6540c1` and tree `d674dd63d827f4b9c6ca0e6ce8a754f1cd5b6f05b2a4c1ac87fcf57f977e4b18`. Resource aliases, ownership markers, the unique namespace, loopback provider traffic, and scoped cleanup are recorded in the source suite and its run receipts.

## Exercised behavior

- Atomic stale-write refusal when the fence advances while provider headers are held; existing exhaustion flags are preserved and no credit key is published.
- Wrong Twitch identity/platform, exact customer mismatch, and older Mongo version are refused before provider traffic. Matching fenced current Free and Pro records use the current Mongo tier rather than a supplied stale tier.
- A wrong-type initial credit GET escapes; a wrong-type fence GET or scoped Mongo find failure returns Free unavailable rather than paid allowance. Provider failure after new-fence creation also returns unavailable while preserving paired exhaustion flags.
- Provider header and body delays exercise timeout fallback. Aborting a pending request and choosing an optional overall deadline both prevent subsequent credit/flag publication in those tested phases.
- Cloned readers make two uncached requests over the same keep-alive TCP connection; method, exact path, fixture Bearer header, and decoded meter value are asserted.

The separately passed Node source oracle contains 13 actual-source DTO/wire cases. The final case covers JavaScript UTF-16 fresh-version ordering before the existing Redis Lua UTF-8 ordering. It is separate from the protocol suite and does not script away the Mongo/Redis assertions above. The run archive preserves the initial 12-case corpus and both byte-identical 13-case corpora.

## Boundaries

- The suite has no deterministic cached-read raw-snapshot race between the first Redis read and Lua acceptance. The provider write race does not prove that behavior.
- Header/body timeout and abort assertions do not independently establish early Mongo/Redis delay effects on the 750 ms provider budget, peer EOF/reset behavior, or cancellation during an uncertain Redis mutation.
- Cross-origin credential isolation is not exercised here. The intended loopback peer observes the fixture token; that is not a redirect proof.
- Setup failure, process termination, failed cleanup commands, or an unknown ownership-marker insertion outcome can require owner-directed cleanup. Never broaden cleanup beyond the unique task-owned resources.
- The source caller’s 750 ms provider timeout is distinct from the native reader’s separately configurable overall-operation deadline. An interrupted mutation may have an unknown outcome and is not replayed.

See [AI-credit reader handoff](ai-credit-reader-handoff.md) for source binding, capped checks, the full contract limits, and [the evidence package](evidence/2026-10-30-ai-credit-reader/README.md) for exact receipts, source, and hash index. This does not establish semantic-worker caller adoption, complete billing migration, deployment, or a runtime-performance result.
