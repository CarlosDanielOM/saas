# Permission error limiter source retirement — 2026-10-30

## Scope and result

The local `shouldLogPermissionError` helper and its original two-group TypeScript test were archived byte-for-byte. Its native local feature and standard-library/`JsString` dependencies were already verified; this epoch verifies the *retired-source boundary* as well. It does not complete wider permissions behavior or the existing TypeScript callers.

The native implementation is `dimabot/src/utils/permissions/error_rate_limit.rs`, exposed through `dimabot/src/utils/permissions/index.rs`. It keeps per-instance and process-wide APIs, uses a 300,000 ms default interval, limits the ordered key set to 2,000, preserves JavaScript UTF-16 string-key identity and binary64 time comparison, and evicts the least recently logged key. Omitted time and interval inputs use defaults. Out-of-contract JavaScript runtime casts are excluded, and the entry-count cap does not bound bytes consumed by arbitrary long strings.

## Frozen epochs

The pre-retirement live-source epoch used tree SHA-256 `dc5a3310e807e17c79f107e1db615507ea125e4bc05ee8dcab710e9a587acf6f`. Formatting `1793380190514967230`, Node source check `1793380222382398184`, and compiler `1793380236411653689` passed. The source fixture SHA-256 was `89a854cd91ea8006ba08361d5b6189e2380facfb8614f15de23ad54f3bfd04dc`.

After retirement, the source-bound tree SHA-256 was `2ceee1f1290b9f96fc7652e683c57904f227b64fd83140737c3646fd65643ef7`. The 1,507 inputs comprise 1,494 Git inputs from default commit `1754f30a56fe49ceea4a52e373b000917799d117`, ten reused SDK inputs, and three independently verified variation-schema inputs retained from `97026cc411ba7938a94dc9ba9377e547cae82399`. This per-input mixed epoch is captured explicitly in `source-bindings-committed.json`; it must not be described as one-commit binding. All input hashes were verified.

The pre-retirement formatter receipt `1793380190514967230` is retained, and the post-retirement compiler reran formatting checks. Node `1793380680742937577` regenerated and checked the fixture, and compiler `1793380709412805634` passed replay and strict checks. Six Rust tests, formatting, scoped Clippy, minimal and all-feature strict checks passed. The fixture SHA changed to `3dfe38fdb78816861c438311defde8c738a28134898fdab388039c0a0750c130` because source locations and manifest identity changed. The independent semantic comparison found all 2,113 operation results and final ordered 2,000-key state identical; no behavioral source change was observed.

The archive adds exactly `src/utils/permissions/error_rate_limit.ts` (SHA-256 `4e840093ef500738588ea7990f4303ea18f9368abd4d9e898557af73e08e8d56`) and `src/utils/permissions/error_rate_limit.test.ts` (SHA-256 `95bee599c425783a84f093c637624eb1ceed5713669c21da596557e95981f0fa`). Manifest growth is 47 to 49 entries; all earlier entries remain unchanged. Production readback found all 18 containers unchanged and zero task-owned resources.

## Limits and evidence

Validation used six CPUs, a 4 GiB memory limit with no swap, 256 PIDs and two Cargo jobs. The explicit 4 GiB compiler policy requires 5 GiB available at startup and a 4 GiB in-flight floor; these guards remained in force.

The helper's local native dependency closure is complete. The larger permissions module, roles, moderation/message handlers and caller adoption remain open. No benchmark, RSS or end-to-end performance result, deployment or push is claimed.

The [handoff](permission-error-rate-limit-handoff.md) records the contract and maps. The [evidence package](evidence/2026-10-30-permission-retirement/README.md) indexes both frozen epochs, source bindings, oracle payloads, semantic comparison, production readbacks, five receipts/logs and inert reproduction scripts.
