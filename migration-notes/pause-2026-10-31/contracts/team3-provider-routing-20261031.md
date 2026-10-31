# team3-bot-ast — provider routing note — 2026-10-31

## Observed provider/environment failure (NOT a model-quality finding)

`delegate_task` to `opencode` with model `openai/gpt-6.1-terra` failed immediately with:

```
[failed]: Request failed: 401
```

Both the original lane-C child
(`delegate-task:e0ac7209-1ad8-453b-9bc9-a1767b31a0de`) and the corrective steering
message sent to the same thread (`thread-send:9092a902-3641-4b13-a3ab-546f36f2da96`)
failed with the same 401. **No files were created or modified**; the lane-C scope was
untouched, and the filesystem was checked to confirm it.

This is the same failure mode already recorded by team2-api-data in
`contracts/team2-provider-routing-20261031.md`, and it is scoped to the OpenCode
**Terra** route on this provider instance — not to the OpenCode driver as a whole.

## Working fallback for GPT-6.1 Terra

Relaunched the identical brief on the **codex** driver with model `gpt-6.1-terra` and
option `reasoningEffort: high` (`runtimeMode` omitted so the child inherits the parent's
full-access, because the codex provider does not advertise its own runtime modes).

This matches the previously proven route recorded in
`orchestrator-notes/2026-10-27-terra-roster.md` ("GPT-6.1 Terra (`gpt-6.1-terra`) at high via
Codex"). No model-tier change and no escalation is implied; the baseline routing order
(MiniMax M3.1 Flash -> DeepSeek V4.1 Flash -> Grok 4.7 -> GPT-6.1 Sol -> Astra) is
unchanged, and Astra was not used.

## Lane assignment actually used by team3-bot-ast

| Slice | Provider instance | Model | Option | Mode |
|---|---|---|---|---|
| A — AST chat send + AST delivery + end-to-end facade | `opencode` | `opencode-go/deepseek-v4.1-flash` | `variant: high` | `full-access` (advertised) |
| B — AST application host, Mongo variable store, native timer runtime | `grok` | `grok-4.7` | `reasoningEffort: high` | `full-access` (advertised) |
| C — special parser, command execution, effect authority | `codex` (after the 401 relaunch) | `gpt-6.1-terra` | `reasoningEffort: high` | inherited full-access |

All three are authoring-only: no Cargo, rustfmt, Node, test, benchmark, Docker, network,
install, commit or push activity is permitted in this wave.

## Routing implication

A 401 on one provider instance's model route is an **environment/credential** fault for
that route, not a model-capability signal. Do not downgrade the model tier on the strength
of it: re-run the same brief on the already-proven route for that model. The OpenCode
DeepSeek route and the Grok route were unaffected on the same instance.

The failure produced no partial edits, so the relaunch started from a clean scope. If a
401 ever lands *after* partial writes, re-check the working tree before relaunching
instead of assuming a clean scope.

## User quota steering — 2026-10-31

The user reports Grok has 32% of its weekly quota remaining; this is not a live catalog measurement or a model-quality finding. Preserve existing Grok assignments. Avoid new Grok assignments by default; select DeepSeek V4.1 Flash or Codex Terra according to task fit. Sol is reserved for integration and MiniMax remains disabled. Do not restart working Grok jobs because of this quota report.

Root reports Polar usage modes, grants and shared factory accepted in commit `6ff0c67c`; native helpers are available for reuse. Documentation reconciliation remains pending. This does not imply global migration completion or grant an execution lease.
