# Persistence model retirements — 2026-10-30

**Verified local source retirement.** Four OAuth persistence models and the
moderation action-log model now have native Rust schema definitions. Their five
TypeScript source files were moved byte-for-byte into the TypeScript archive.
This closes the local feature and direct/transitive dependency scope of these
models. It does not establish TypeScript caller adoption, production cutover,
or total migration completion.

The source-bearing post-archive snapshot is commit
`6af3a89731e4219d66a4dfa99a7ce128a0edb825` with 1,480 frozen inputs and tree
SHA-256
`18d0d5c5dcf9353e69ad85d9237cdf365c97fecff11adde29038b3cfe75d9e80`.
The source binding accounts for 1,470 Git inputs and ten previously captured
SDK inputs; every hash matched. Five new archive files are exact copies of the
pre-retirement TypeScript bytes. The archive grew from 31 to 36 entries, with
the earlier 31 files and archive metadata unchanged.

| Retired source | Archived source | Native model and exported surface |
|---|---|---|
| `dimabot/src/schemas/oauth_client.schema.ts` | `archives/dimabot-typescript/2026-10-28/src/schemas/oauth_client.schema.ts` | `oauth_client.schema.rs`: `OAuthClient` model descriptor |
| `dimabot/src/schemas/oauth_grant.schema.ts` | `archives/dimabot-typescript/2026-10-28/src/schemas/oauth_grant.schema.ts` | `oauth_grant.schema.rs`: `OAuthGrant` model descriptor |
| `dimabot/src/schemas/oauth_refresh_token.schema.ts` | `archives/dimabot-typescript/2026-10-28/src/schemas/oauth_refresh_token.schema.ts` | `oauth_refresh_token.schema.rs`: `OAuthRefreshToken` model descriptor |
| `dimabot/src/schemas/oauth_session.schema.ts` | `archives/dimabot-typescript/2026-10-28/src/schemas/oauth_session.schema.ts` | `oauth_session.schema.rs`: `OAuthSession` model descriptor |
| `dimabot/src/schemas/moderation_action_log.schema.ts` | `archives/dimabot-typescript/2026-10-28/src/schemas/moderation_action_log.schema.ts` | `moderation_action_log.schema.rs`: `IModerationActionLog`, `ModerationActionLogSchema`, and repository accessor |

## Dependency and behavior closure

Each TypeScript source imports runtime `Schema` and `model` from Mongoose and
no other package. The four OAuth modules export one model each and no named
types. The action-log module exports its interface and model. The concrete
native implementation uses the pinned MongoDB Rust crate and the existing
`SchemaDefinition`, casting, validation, BSON compatibility, date, index
installation, and `SchemaRepository` components. It does not depend on an
unported application adapter. Its action enum reuses the already accepted
`ModerationAction` enum from channel-moderation settings, so that shared enum is
not a missing dependency.

The native descriptors retain model/collection names, field types, required
constraints, defaults, timestamps, hidden projections, version keys, and index
semantics. The action-log source sets `createdAt` to `Date.now` and has no
custom static or middleware hook. Its 200-unit excerpt limit follows JavaScript
UTF-16 length through the shared string type. Its source index metadata carries
`background: true`; the pinned MongoDB driver's deprecated background option
has no effect; the native schema descriptor omits that deprecated metadata. The native descriptor installs
the indexes directly, including the 2,592,000-second TTL index. This is a
documented driver metadata difference, not an unported application feature.

## Verification

Two validation epochs are retained rather than conflated:

- **Pre-retirement action-log acceptance:** Node receipt
  `1793360989182975978` generated and checked the pinned Mongoose fixture;
  capped compiler receipt `1793361084297861260` passed the action-log Rust
  suite, isolated Mongo CRUD/index checks, actual-source replay, formatting,
  scoped Clippy, no-default all-target check, and all-feature strict Clippy.
  Its fixture covered 32 cases. The earlier generated action-log fixture's
  nine semantic fields (versions, Node executable, compiled source, model,
  collection, indexes, fixed time, cases, and wire) match the corresponding
  post-archive fixture. These pre-retirement passes establish the accepted
  native action-log model; they are not counted as post-retirement source
  validation.
- **Post-archive source validation:** Node receipt `1793362118754074174` passed
  in 9.358 seconds total (8.004 seconds for the check step). Its actual-source
  fixtures cover 11 application schemas and 70 cases plus 32 action-log cases.
  Compared with the embedded pre-archive golden output, all five application
  fields (`sources`, `fixedNow`, `definitions`, `cases`, `workloads`) match;
  all nine action-log semantic fields listed above also match. The source
  resolver verifies the pinned archive and refuses a retired live-source
  fallback. Capped compiler receipt `1793362234253284528` passed in 126.763
  seconds total (111.969 seconds of phase work), with a 4 GiB memory/no-swap
  limit, six CPUs, two Cargo jobs, and a 256 PID limit. Minimum available
  memory was 8,891,187,200 bytes and the private cache peak was 8,019,623,936
  bytes. It passed the 70-case application-schema replay, action-log ordinary
  schema checks, the isolated Mongo CRUD/index and actual Mongoose replays,
  formatting, scoped Clippy, no-default all-target check, and all-feature
  all-target Clippy. Format receipt `1793362062445951357` passed. Final
  readback found 18 production records unchanged and no owned containers,
  networks, or volumes remaining.

The action-log validation epoch also performed scoped private-cache
maintenance: its audit records 21 completed task-owned debug test binaries,
542,461,952 allocated bytes freed, and a cache decrease from 8,531,124,224 to
7,988,662,272 bytes. An earlier moderation-leaf cache-maintenance audit is also retained; it
records a failed 700 MiB minimum-free assertion after cleanup and does not
claim cleanup success. Neither audit changed source or production resources.

The frozen validation inputs restore four in-progress native DTO schema edits
only inside the frozen snapshot and exclude the unwired DeleteTwitch draft;
these were not validated or included in this retirement. No benchmark or new
timing claim is made. The reproducible evidence, raw and compressed artifact
hashes, exact receipts/logs, fixture outputs, source bindings, archive proofs,
and reproduction tools are in the [indexed evidence package](evidence/2026-10-30-persistence-model-retirement/README.md).

## Adoption and completion status

The application still has TypeScript consumers of these schemas. Those callers
remain active and unadopted, and the retirement was authorized in the
migration checkout despite those imports. The action-log model's native
repository accessor is a completed local persistence model; application
actions have not switched to it. Production remains on the accepted baseline
with the prior Piper removal acknowledged. No deployment or push occurred.

This closes five local source features and their required native persistence
dependencies. It does not close the full `dimabot` migration: the dependency
matrix still reports total completion as `null`, with 23 complete and 24
partial reviewed features in its updated reviewed subset. The repository-wide
baseline includes 770 live TypeScript rows (including six explicitly excluded
React Email templates) and the 36 archived files.
