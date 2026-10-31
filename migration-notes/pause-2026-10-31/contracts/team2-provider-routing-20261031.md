# team2-api-data — provider routing note — 2026-10-31

## Observed provider/environment failure (NOT a model-quality finding)

`delegate_task` to `opencode` with model `openai/gpt-6.1-terra` failed immediately with:

```
[failed]: Request failed: 401
```

No files were created or modified by that attempt; the slice scope was untouched.

The same provider instance was healthy for a second concurrent child
(`opencode-go/deepseek-v4.1-flash`, also `opencode`), which continued running normally.
So the failure is scoped to the OpenCode **Terra** route, not to the OpenCode driver as a whole.

## Working fallback for GPT-6.1 Terra

Relaunched the identical brief on the **codex** driver with model `gpt-6.1-terra` and
option `reasoningEffort: high` (`runtimeMode` omitted so the child inherits the parent's
full-access, because the codex provider does not advertise its own runtime modes).

This matches the previously proven route recorded in
`orchestrator-notes/2026-10-27-terra-roster.md` ("GPT-6.1 Terra (`gpt-6.1-terra`) at high via
Codex"). No model-tier change and no escalation is implied; the baseline routing order
(MiniMax M3.1 Flash -> DeepSeek V4.1 Flash -> Grok 4.7 -> GPT-6.1 Sol -> Astra) is unchanged,
and Astra was not used.

## Lane assignment actually used by team2-api-data

| Slice | Provider instance | Model | Option | Mode |
|---|---|---|---|---|
| 1 — OAuth desktop-beta API | `grok` | `grok-4.7` | `reasoningEffort: high` | `full-access` (advertised) |
| 2 — site analytics collector + site/analytics APIs | `codex` | `gpt-6.1-terra` | `reasoningEffort: high` | inherited full-access |
| 3 — follow relationship ledger schema + collector + queue | `opencode` | `opencode-go/deepseek-v4.1-flash` | `variant: high` | `full-access` (advertised) |

All three are authoring-only: no Cargo, rustfmt, Node, test, benchmark, Docker, network,
install, commit or push activity is permitted in this wave.

## 2026-10-31 — user quota steering

The user reports Grok has 32% weekly quota remaining; this is user-reported, not live catalog evidence or a model-quality finding. Preserve and finish existing Grok assignments without cancelling or restarting them for this reason. Avoid new Grok assignments by default; choose DeepSeek V4.1 Flash or Codex Terra according to task fit, with Sol reserved for integration. MiniMax remains disabled. Root reports Polar usage modes, grants and shared factory accepted as `6ff0c67c`; native helpers are available for reuse, while documentation reconciliation remains pending. Authoring-only restrictions remain; execution requires root's lease.
