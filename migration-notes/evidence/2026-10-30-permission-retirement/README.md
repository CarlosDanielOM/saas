# Permission error limiter retirement evidence

This package preserves two separately frozen verification epochs. `artifacts/attempt1/` is the pre-retirement live-source epoch; `artifacts/attempt2/` is the post-retirement epoch. The second binding is intentionally mixed by source origin: 1,494 Git inputs from `1754f30a56fe49ceea4a52e373b000917799d117`, ten reused SDK inputs, and three explicit variation-schema historical overrides from `97026cc411ba7938a94dc9ba9377e547cae82399`, for 1,507 independently verified inputs and tree SHA-256 `2ceee1f1290b9f96fc7652e683c57904f227b64fd83140737c3646fd65643ef7`.

The source and original test are byte-exact archive entries. The pre-retirement fixture SHA-256 is `89a854cd91ea8006ba08361d5b6189e2380facfb8614f15de23ad54f3bfd04dc`; post-retirement it is `3dfe38fdb78816861c438311defde8c738a28134898fdab388039c0a0750c130`. The semantic comparison records 2,113 identical operation results, identical final ordered state of 2,000 keys, and only source-location/manifest provenance changes.

| Phase | Receipt IDs | Result |
|---|---|---|
| Format | `1793380190514967230` | Passed |
| Pre-retirement Node | `1793380222382398184` | Passed |
| Pre-retirement compiler | `1793380236411653689` | Passed |
| Post-retirement Node | `1793380680742937577` | Passed |
| Post-retirement compiler | `1793380709412805634` | Passed |

Both source checks, six native permission tests, formatting, scoped Clippy, minimal and all-feature strict checks passed. Production readback found all 18 containers unchanged and zero task-owned resources. The archive grew from 47 to 49 entries and the previous entries remain unchanged. Caller adoption remains open; this is not a deployment or performance claim.

`index.json` records every stored payload's original absolute origin, raw and stored SHA-256, and byte sizes. Large JSON and all logs/receipts are losslessly gzip-compressed; reproduction scripts are exact inert copies and were not rerun for this documentation package. The package excludes mutable snapshots, caches and binaries. It is not a source snapshot substitute; use the frozen source maps and bindings for provenance.
