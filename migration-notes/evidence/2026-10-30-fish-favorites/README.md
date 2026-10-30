# Fish favorites baseline evidence

This is the losslessly indexed evidence package for the accepted typed-record baseline described in [`../../channel-fish-voice-favorites.md`](../../channel-fish-voice-favorites.md).

`artifact-index.json` inventories 60 payloads. Every entry records the immutable source path, uncompressed SHA-256 and byte size, stored SHA-256 and byte size, and whether the stored payload is raw or gzip-compressed. Gzip members are lossless. The package includes the attempt 1–4 source-final maps and captured overrides, Fish oracle and benchmark reports/inputs, source and binary bindings, compiler metadata, cache maintenance audits, production readbacks, and the relevant formatter, Node, and compiler receipts and logs. Failed runs are retained as failures in their original receipts.

The run receipts and logs originate from `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/`. Large JSON reports, logs, and source overrides are compressed without altering their bytes. Mutable snapshots, target directories, and toolchain binaries are not included.
