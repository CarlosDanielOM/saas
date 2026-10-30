# Rust startup guard: 5 GiB threshold for the explicit 4 GiB cap

On 2026-10-30, the user authorized lowering the minimum `MemAvailable` required at startup for the explicit 4 GiB Rust compiler cap from 8 GiB to 5 GiB. The supported caps remain 4 and 6 GiB; the default 6 GiB cap still requires 10 GiB at startup. Both caps keep the 4 GiB in-flight `MemAvailable` floor and the existing CPU/load, disk, no-swap, PID, Cargo job, cache, global-lock, and isolation safeguards.

## Verification

Run `compiler-1793322221706941276` passed three focused Python unit-test methods in a capped disposable compiler-phase container:

- `test_lower_memory_rust_headroom_requires_5_gib_at_start_and_4_gib_while_running` checks the explicit 4 GiB cap's 5 GiB startup threshold and 4 GiB in-flight floor.
- `test_rust_headroom_requires_10_gib_at_start_and_4_gib_while_running` checks the default 6 GiB cap's 10 GiB startup threshold and the same 4 GiB in-flight floor.
- `test_rust_headroom_refuses_host_load_and_disk_pressure` checks refusal under excessive host load or insufficient disk headroom.

The two threshold tests exercise one KiB below, exactly at, and one KiB above each startup and in-flight boundary. Values below each minimum are refused; values at and above it pass. The run log records `Ran 3 tests ... OK`. This was Python resource-guard unit validation only. It did not compile Rust features, run application or worker code, access production data, measure performance, or deploy anything.

The capped container limits recorded in the receipt were 6 CPUs, 4 GiB memory with memory-swap equal to 4 GiB (no swap), 256 PIDs, and two Cargo jobs. Receipt headroom samples were 11,107,282,944 bytes (`MemAvailable` at start) and 10,987,978,752 bytes (minimum observed); these are environment samples, not a performance result.

## Source and hash provenance

The tests used the separately retained files under [`inputs/ops/`](inputs/ops/). Their hashes bind the tested guard inputs to commit `40561131f5051bdbb00614346b6c0c94b8660763`:

| Tested input | SHA-256 |
|---|---|
| `ops/saas_ops.py` | `b6e5824340f73c99be25563d8156fa6d55383a43be2b53cac9065a740776ae30` |
| `ops/tests/test_ops.py` | `b7d2c068138b02001e44ee818f739d7a1d00524c173448b7fd0cc6686c026384` |

The compressed run receipt's `source_hashes` and `source_tree_sha256` describe the separate migration driver's Rust source snapshot (`f7f1151d5974eedf0082091f640112e85d763742994dedbb1e72b60b2f8b2919`); they do **not** identify the `ops/` code tested by these Python unit tests. The `guardInputHashes` in [`verification.json`](verification.json) are the provenance for the tested ops files.

## Production baseline

The user confirmed that they removed `piper-tts` to free memory before the run. The retained before/after snapshots show the remaining 18 production containers unchanged; [`acknowledgement.json`](baseline/acknowledgement.json) records that removal as user-performed and records no assistant production mutation. No production service or data was changed or used by this verification.

## Retained artifacts

- [`verification.json`](verification.json): test scope, tested input hashes, compiler limits, thresholds, and production-baseline acknowledgement.
- [`test-command.sh`](test-command.sh): the exact three-test command.
- [`inputs/ops/`](inputs/ops/): the tested source and test snapshots.
- [`run/compiler-1793322221706941276.log.gz`](run/compiler-1793322221706941276.log.gz) and [`run/compiler-1793322221706941276-receipt.json.gz`](run/compiler-1793322221706941276-receipt.json.gz): compressed run log and receipt.
- [`baseline/before.json`](baseline/before.json), [`baseline/after.json`](baseline/after.json), and [`baseline/acknowledgement.json`](baseline/acknowledgement.json): production-container comparison and user confirmation.
