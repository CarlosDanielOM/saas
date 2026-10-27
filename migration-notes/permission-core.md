# Permission core Rust port

## Status and scope

The pure Rust permission core is source-backed and verified as an opt-in library module behind Cargo feature `permissions`. The final capped compile and test checks passed; this does not represent production caller adoption or production acceptance. No production caller, worker, or release changed. The TypeScript permission implementation remains the only live implementation. [`TAG_PERMISSION_SYSTEM.md`](../TAG_PERMISSION_SYSTEM.md) is planning guidance; the current oracle is the TypeScript source under [`dimabot/src/utils/permissions`](../dimabot/src/utils/permissions/index.ts).

The port covers trusted identity snapshots, badge-derived level and tags, expression validation and evaluation, command and rule decisions, flat access plans, and legacy-level parsing in [`permissions.rs`](../dimabot/src/utils/permissions/index.rs). It excludes live callers, role-cache IO, identity resolution, admin middleware, AST origin checks, and permission-error rate limiting. The independent `permissions` feature stays outside Cargo defaults, `bot-utils`, and worker profiles. It reuses Serde dependencies and enables `serde_json/float_roundtrip`; it adds no crate dependency.

## API and behavior

`CompiledPermission` owns an immutable compiled snapshot. `compile` validates a present expression once, owns its sanitized tree, and prepares a flat plan for recognized flat-access shapes. Repeated `decide` and `allowed` calls do not revalidate raw JSON. Callers replace the value when configuration changes; the module has no global policy cache.

Flat access decisions remain separate from general Boolean expression evaluation. This preserves the source's named-account, specific-role, and `everyone` precedence, as well as its order-sensitive recognition of flat shapes. General expressions preserve three-valued `true`/`false`/`unknown` logic through `not`; unknown denies at the final decision boundary. Both `ValidatedExpression::evaluate` and `CompiledPermission::decide` apply the broadcaster override to valid policies, while invalid policies deny even broadcasters. Only the compiled gate applies flat-access precedence. Decisions expose a reason; validation errors preserve source messages and add stable codes and paths.

The usage snippet in [`dimabot/RUST.md`](../dimabot/RUST.md#opt-in-permission-core) is illustrative; the README snippet itself was not compiled as a doctest. Compatibility details:

- Account IDs remain strings, including leading zeroes and valid 20-digit IDs; numeric coercion is not performed.
- `parse_user_identity` accepts a trusted internal snapshot, not client-supplied proof of role claims. It preserves known supplied tags, truncates and clamps a valid snapshot level, and adds `everyone`. The basic constructor does not invent roles or founder inheritance; founder-to-subscription expansion belongs to badge derivation.
- A missing or `null` expression selects legacy-level mode. A missing or falsy config wrapper denies, while a truthy empty object follows the legacy level-zero behavior. Stored legacy levels are not clamped and retain the source's `parseInt`-prefix behavior.
- Diagnostic JSON object key order can differ from JavaScript because Rust uses `serde_json::Value`'s ordered map. Compatibility is not claimed for arbitrary JavaScript prototypes, functions, or lone UTF-16 surrogates.

No permission or role-cache behavior changed in TypeScript or at runtime. Cache hardening remains deferred to coordinated TypeScript/Rust cache adoption: refresh publication currently uses `DEL`/`SADD`/`EXPIRE` without atomic publication, and an ID miss can fall back to login lookup when the ID set is populated. That work needs snapshot fencing and atomic publication plus an authoritative ID-lookup policy; two `RENAMES` alone do not prevent stale-writer races. Replacing role-cache `KEYS` with `SCAN` is a separate storage follow-up.

## Source-backed parity corpus

[`permission_core_reference.mjs`](../dimabot/tests/fixtures/permission_core_reference.mjs) extracts pure declarations from the current TypeScript sources into an isolated VM and checks or regenerates [`permission_core_cases.json`](../dimabot/tests/fixtures/permission_core_cases.json). It excludes service setup and does not access a database, cache, network, environment, or clock. The corpus contains **3,681 cases** and has `corpusHash` `f0512d014273ddd92ebee1bfbf194d754c50f2063a11db49850a5aae0f2c38c3`.

| Operation | Cases |
| --- | ---: |
| `access` | 2,061 |
| `evaluate` | 1,331 |
| `validate` | 118 |
| `config` | 36 |
| `parse_identity` | 36 |
| `badge_level` | 29 |
| `badge_tags` | 29 |
| `role_tag` | 18 |
| `inspect` | 13 |
| `serialize_identity` | 10 |

The corpus records source SHA-256 values for `expression.ts` (`34a3d2900bbad64bde838504e16a73f361bf7d317ef4089dcbf58fe0b1e79ab2`), `index.ts` (`14364559e21b5a801a9229015fc03583bfb5bf9310d8de9477b483398404f6cd`), `roles.ts` (`9469ce3029c6aedce85cc7a6ad3c180adf097051ef6d5c1aa0cac68b7396df20`), and shared fixture `ops/fixtures/permission-expressions.json` (`88ea4ed9276eb48c0ac6a65c75acbdbf985b690fd5b793d22328307540d997a2`). The Node oracle `--check` passed for all 3,681 cases, and the existing TypeScript permission suite had passed 64 tests. The runner confirmed source hashes matched before and after Rust validation. Rust parity coverage lives in [`permission_core_parity.rs`](../dimabot/tests/permission_core_parity.rs).

## Verification

Fresh validation passed in `/root/.local/state/rust-permission-core-20261025-5lmmgo3o/artifacts/quality-{receipt.json,bootstrap.log,format.log,check.log,clippy.log,compile-tests.log,dependency-graphs.log,tests.log}`. The checks used pinned Rust 1.99.1 in a disposable container, capped at 3 CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. The receipt records 24 monitoring samples, 12,138,987,520 bytes minimum startup availability, 11,788,525,568 bytes minimum availability during the run, a 404,172,800-byte peak cache, and 45.656 seconds elapsed after warm dependency reuse. This duration is validation time, not an application performance benchmark. The temporary compiler container was removed automatically.

- `cargo fmt --all -- --check` passed.
- `cargo check --locked --all-targets --no-default-features` passed with no features, with `permissions`, and with `permissions,bot-utils`.
- Clippy with `-D warnings` passed with `permissions` and with `permissions,bot-utils`.
- Network-disconnected tests passed: `permissions` ran 15 library tests (14 permission-core tests plus one existing JS-compatibility test), three parity integration tests over the source corpus, and two doctests; `permissions,bot-utils` ran 32 library tests and the same three parity tests; the no-feature build ran zero library tests. That is 55 successful test executions including repeated profile coverage and doctests, not 55 unique tests or 7,362 distinct parity cases.
- Cargo dependency graphs for Mongo, Mongo/Redis, dashboard, and supervisor profiles were byte-identical to baseline after path normalization. `Cargo.lock` was unchanged. The only feature change is the opt-in Serde wiring and `float_roundtrip` setting noted above.

An earlier attempt was stopped by the then-current startup memory reserve. The user lowered that reserve on 2026-10-25, and the fresh capped validation above passed the updated guard. This is a library verification result only; there is no production deployment or live-caller adoption.
