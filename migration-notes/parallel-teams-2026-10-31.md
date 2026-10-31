# Parallel migration teams — 2026-10-31

## Initial topology (superseded)

The user initially requested four independent feature teams with MiniMax M3.1 Flash exploration paired with DeepSeek, Grok, or Terra implementation, plus the existing root integration thread and Sol peer. Four separate T3 team threads were created; their IDs, links, ownership map, and protocol are recorded in `/root/.local/state/dimabot-migration-teams-20261031/manifest.json`. Initial metadata confirmed MiniMax Code (`provider=minimax`, `m:minimax:MiniMax-M3.1-Flash:v:thinking`), requested with full access and `bypassPermissions` (not OpenCode). Initial handshakes confirmed the four leads were running, not that every implementation delegate was running.

| Team | Owned feature areas | Baseline rows |
|---|---|---:|
| Billing/AI | Billing, Polar, credits/ledger, AI services, referral | 137 |
| API/data | Accounts, OAuth, API/data services, generic data models | 207 |
| Bot/AST | Bot runtime, AST/commands, Twitch/EventSub, moderation, domain events, workers | 316 |
| Speech/media | Speech/TTS/pets, assets/media/overlays/widgets, roulette/duel/goals | 140 |

The manifest assigns all 800 in-scope source rows; six React Email templates are exempt. Root integration owns central Cargo/module/registry/ops files and the migration ledger. Temporary path reservations supersede permanent ownership until released. At initial handoff, the Polar immediate/grant/factory worker held the single heavy-execution lease until handoff; file-route and announcements jobs were authored but unverified and awaited integration review/leases.

Teams could author concurrently, while heavy Node, Rust, formatting, test, and container phases were serialized under one global nonblocking lease: six CPUs, 4 GiB memory, no swap, 256 PIDs, two Cargo jobs, 5 GiB startup headroom, 4 GiB in-flight headroom, 5 GiB disk floor, and an 8 GiB private-cache limit. The protocol required comparison of all 18 production container identities, no production mutation, push, or deployment, preservation of user-dirty files, and ready messages with owned paths, source tree, and proof paths. Blocked/completed notifications were event-driven, with no routine polling. Root/Sol integration verifies contracts and concrete adapters before local-completion status; authored work alone is not acceptance. Functional coverage precedes benchmarks.

## Current routing override — 2026-10-31

The user then explicitly steered: “We should not use MiniMax, is failing the threads”. Root stopped all four MiniMax lead turns and reconfigured the same four top-level threads through `t3_thread_configure` to provider `codex`, model `gpt-6.1-terra`, requested reasoning effort `high`. A one-time metadata read confirmed all four now report Codex/Terra and no active MiniMax runs. Root resumed the four coordinators with their existing context and ownership. Existing DeepSeek, Grok, and Terra implementation workers, claims, ready messages, and results were preserved; they were not duplicated or restarted. No new top-level threads or worktrees were created.

The manifest records the current override and thread team pattern. MiniMax is disabled for new migration coordination, exploration, and implementation assignments until the user changes this preference. This is explicit operational feedback, not a formal capability benchmark or broad tier conclusion. Two recent MiniMax lead turns failed, one was interrupted, and one was cancelled; cause analysis was not performed, so no cause or replacement-quality claim is inferred.

Root integration and the Sol peer remain responsible for shared central paths, contract review, and serialized heavy validation. Continue to preserve task ownership, leases, resource limits, and production safeguards above. The initial MiniMax routing is retained here only as dated history; the current routing observation is in [independent team routing](../orchestrator-notes/2026-10-31-independent-team-routing.md), and the user preference is detailed in [MiniMax disabled](../orchestrator-notes/2026-10-31-minimax-disabled.md).

The current accepted code base is `e803ab78`; accepted documentation commit is `dd7426e1`. Polar modes functional checks passed, but final broad quality has not yet been accepted. This note does not claim whole Rust migration completion or production deployment.
