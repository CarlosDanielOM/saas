# Parallel migration teams — 2026-10-31

The user requested four independent top-level feature teams, with MiniMax M3.1 Flash exploration paired with DeepSeek, Grok, or Terra implementation, plus the existing root integration thread and its Sol peer. This structure is authorized and has been created through T3; it is not constrained by the local four-subagent slot count. The four team threads and their T3 links are in `/root/.local/state/dimabot-migration-teams-20261031/manifest.json`. Metadata reads confirmed each coordinator thread uses provider `minimax` and model `m:minimax:MiniMax-M3.1-Flash:v:thinking`; creation requested full access and `bypassPermissions`. This is MiniMax Code, not OpenCode. Creation returned `starting`, and one-time handshakes confirmed the four team leads running; this does not establish that every implementation delegate is already running.

| Team | Owned feature areas | Baseline rows |
|---|---|---:|
| Billing/AI | Billing, Polar, credits/ledger, AI services, referral | 137 |
| API/data | Accounts, OAuth, API/data services, generic data models | 207 |
| Bot/AST | Bot runtime, AST/commands, Twitch/EventSub, moderation, domain events, workers | 316 |
| Speech/media | Speech/TTS/pets, assets/media/overlays/widgets, roulette/duel/goals | 140 |

The manifest assigns all 800 in-scope baseline source rows; six React Email templates are explicitly exempt. Root integration exclusively owns central Cargo/module/registry/ops files and the migration ledger. Temporary path reservations supersede permanent ownership until released. The existing Polar immediate/grant/factory worker retains the single heavy-execution lease until its handoff; file-route and announcements jobs are authored but unverified and await integration review/leases.

Teams may author concurrently. Heavy Node, Rust, formatting, test, and container phases run serially under one global nonblocking lease: six CPUs, 4 GiB memory, no swap, 256 PIDs, two Cargo jobs, 5 GiB startup headroom, 4 GiB in-flight headroom, 5 GiB disk floor, and 8 GiB private-cache limit. Compare all 18 production container identities before and after; if production changes unexpectedly, stop and report. Do not mutate production, push, or deploy. Preserve user-dirty files. A ready message includes owned paths, source tree and proof paths; blocked/completed notifications are event-driven, with no routine polling. Authored work is not accepted: root/Sol integration verifies contracts and adapters before local-completion status. Functional Rust coverage comes first; benchmarks are deferred.

See the [routing observation](../orchestrator-notes/2026-10-31-independent-team-routing.md) and manifest for exact paths, temporary leases, thread links, and protocol fields.
