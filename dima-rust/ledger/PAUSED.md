# Paused on 2026-11-12

The owner paused the Rust migration on 2026-11-12, about 12:00 MST. `master` stays TypeScript and is
what runs in production. This branch, `rust-v2`, is left as it was at that moment: everything merged
into it passed its gate in the lead's checkout, and nothing here has been deployed anywhere.

## Where it stands

About 40% of the server-side TypeScript is ported and merged: roughly 45,000 of 111,000 lines, with
6,300 more lines found not to need a port at all (dead files, one-off scripts, dropped features). The
figure is a tally of package sizes, not a measurement.

**Done, reviewed by GPT-6.1 Sol, fixes merged.** The lower layers: `dima-text`, `dima-core`,
`dima-store`, `dima-telemetry`, `dima-http`, `dima-web`, `dima-socketio` (on the patched `engineioxide`
under `vendor/`), `dima-model` (101 collections; every document of the production copy decodes),
`dima-commands`, `dima-engine` (syntax, blocks, evaluator, budgets), `dima-twitch` (tokens with
recovery, Helix wrappers, EventSub management), `dima-events`, `dima-billing` (complete), `dima-email`,
`dima-tts`, `dima-stream` (complete), `dima-platform` (S3, media library, fulfilment, TTS usage, clips and
thumbnails, authentication, access, OAuth), part of `dima-ai` (Qdrant, clients, prompts, threads, the
memory store). The small services: `dimadb-server`, `hoststats`, `dimafx-server`, `analytics`.

**Done, not yet reviewed.** Ten of the 76 packages of the upper layers (`upper-layers.md`, status table
at its end): the skeleton of the new crates and the `api` and `bot` binaries, the command lookup and its
cache, the plain chat send, the bot's EventSub endpoint, the command host core (all 2,217 stored command
texts give the TypeScript's result), the chat message handler, moderation rules, roulette with duel and
bits rules, widgets with the widget feed, the API application shell with the OAuth routes; and the
`cron` binary with its supervisor and three workers.

**Not started.** The other 63 upper-layer packages: the 99 host functions of the command language in
their four groups, the AI chat, moderation's handler, the realtime layer, the site agent, the services,
about twenty route packages, the remaining cron workers, and the assembly of the three binaries. No
binary does useful work yet, and the first end-to-end comparison (a custom chat command answered by the
Rust bot) has not been run: its library pieces are merged, the bot binary is not assembled.

## What was stopped unfinished

Four workers were running when the pause came. Their state:

| Package | State |
|---|---|
| P4-CHAT-MESSAGE (Opus) | Its six commits were complete; the lead gated and merged them (`c0b7bd06`). It never wrote its report, and nobody has reviewed it |
| P4-ACT-AI-A (Opus) | Stopped mid-work. Branch `t3/rust-ai-openrouter-billing`, commit `2249a38a`: six new files under `crates/actions/src/ai/`, never compiled as a whole, no tests |
| P4-FEAT-PETS (Sol) | Stopped mid-work. Branch `t3/port-pet-features`, commit `29260755`: a first cut of `crates/features/src/pets/` with a recorder and a fixture, not gated |
| P4-SVC-COMMANDS (Opus) | Stopped before it had written anything |

The two unfinished branches are on `origin` under the same names (pushed at the pause, at the owner's
word). Merge nothing from them as they are: they are starting points, not finished work.

## To pick it up again

1. Read `MIGRATION.md` (the rules), `upper-layers.md` (the plan and its status table) and `packages.md`
   (the lower layers, the owner's decisions, the cutover steps collected so far).
2. Work in a checkout of `rust-v2`. Every cargo command goes through `tools/cargo`; the gate of a crate
   is `eval "$(./tools/test-env)" && ./tools/check <crate>`, with the local MongoDB, Dragonfly, Qdrant and
   PostgreSQL containers running. `cargo check --workspace --all-targets` must stay clean.
3. Next in order, by the plan's critical path: assemble the first part of the bot binary and run the rig
   scenario of the vertical slice (`rig/scenarios/dimabot-bot/`); P4-ACT-AI-A (from its branch) and then
   P4-ACT-AI-B; P4-SVC-COMMANDS; P4-FEAT-PETS (from its branch); the four groups of host functions;
   P4-MOD-RUN; the model packages still open (F-MODEL-07c, F-MODEL-NATIVE); P2-CRON-02.
4. Reviews still owed: P2-TWITCH-02, P2-TWITCH-01d, F-SOCKETIO-c, P2-PLATFORM-AUTH-b, E-ENGINE-02d,
   P2-BILLING-02c, P2-PLATFORM-SVC, and every upper-layer package merged so far.
5. Small packages listed and not started: RIG-02e, F-STORE-DF-c, the trailing work items named in the
   status rows ("wanted from shared crates").

## Decisions the owner still has open

They are collected in `packages.md` under "Waiting for the owner". With the migration paused, the ones
about the running TypeScript no longer wait for a cutover: see `typescript-findings.md`.

## What was left on the laptop

- The lead's checkout `~/Projects/saas-rust-v2` (branch `rust-v2`), sources only, about 240 MB. Its
  build directory and the shared build cache were deleted at the pause (58 GB on disk: cargo keeps every
  old version of every test binary and library, and they had piled up over some eighty merges). The next
  build starts from nothing and takes about an hour; clear `dima-rust/target` now and then.
- Ignored directories installed in the main checkout for recordings: `dimafx/server/node_modules`,
  `dimafx/server/dist`, `dima-analytics/node_modules`. They are untracked build products.
- The Docker image `dimabot-ref:0c71108e` (the TypeScript backend frozen at that commit, used as the
  reference by the rig).
- No test database, test key or scratch collection: the local stores were checked and cleaned at the
  pause.
