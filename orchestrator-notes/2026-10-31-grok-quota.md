# Grok quota routing — 2026-10-31

The user reports that Grok 4.7 has 32% of its weekly quota remaining and may be unavailable after the initial four-team setup. Preserve existing Grok assignments so they can finish; avoid assigning new Grok work by default until the user updates availability. Route new work to DeepSeek V4.1 Flash or GPT-6.1 Terra when suitable for the task, with Sol retaining integration and verification ownership.

This is a user-reported quota constraint, not a live API check, quality finding, benchmark, or broad change to the model tier. MiniMax remains disabled for new migration work under the [existing user preference](2026-10-31-minimax-disabled.md). Current quota-routing values are recorded in `/root/.local/state/dimabot-migration-teams-20261031/manifest.json`. The modified `orchestrator-notes/README.md` is intentionally left untouched.
