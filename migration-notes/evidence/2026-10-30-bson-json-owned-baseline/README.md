# Owned BSON/JSON benchmark baseline evidence

Captured for the 2026-10-30 documentation record. See the [benchmark note](../../bson-js-json-benchmark.md) for methodology and interpretation. Payload bytes are preserved as stored; no gzip payloads were present in the retained source artifacts. For every listed file, raw and stored SHA-256 are identical because the file is uncompressed.

## Bundle contents

- `artifacts/`: original benchmark input and reports, parent facts, production readback, and the immutable release benchmark executable.
- `source/`: 14 files retrieved only from `git show 65d600dc:<path>` and pinned to the input manifest.
- `receipts/`: timing, compiler, final input-reconstruction, and strict compiler/fixture run receipts with their corresponding logs.
- `tools-current-static/`: static copies observed in `/tmp/dimabot-full-migration-tools` on 2026-10-30. These are reference snapshots only; they were not executed to prepare this evidence.

## Payload inventory

| Payload | Bytes | Raw SHA-256 | Stored SHA-256 |
|---|---:|---|---|
| [`artifacts/bson-js-json-input.json`](artifacts/bson-js-json-input.json) | 637964 | `65c16f8fbd2545584bef7c8a23a684e890bc465e7c23872b7c72310e06cf38f5` | `65c16f8fbd2545584bef7c8a23a684e890bc465e7c23872b7c72310e06cf38f5` |
| [`artifacts/bson-js-json-node.json`](artifacts/bson-js-json-node.json) | 2156 | `fb5fc0de9eca2c24b54650477903f7fbf01b84b73c818900150425667b9a21af` | `fb5fc0de9eca2c24b54650477903f7fbf01b84b73c818900150425667b9a21af` |
| [`artifacts/bson-js-json-rust.json`](artifacts/bson-js-json-rust.json) | 2155 | `862cd502d40834320f78a4d322d79f54eb540f60f8640e2468a761d0d0b4cc9e` | `862cd502d40834320f78a4d322d79f54eb540f60f8640e2468a761d0d0b4cc9e` |
| [`artifacts/owned-baseline-benchmark`](artifacts/owned-baseline-benchmark) | 1748328 | `5b82ac1ceaf3150d72461eed62c10f8503aea89a2df3e25d1e7addcc30eb542d` | `5b82ac1ceaf3150d72461eed62c10f8503aea89a2df3e25d1e7addcc30eb542d` |
| [`artifacts/parent-final-facts.json`](artifacts/parent-final-facts.json) | 4133 | `980dcc245aa9323d12623bd8029cd5f4dc6b95e367e1456cd8ac257d332af5c6` | `980dcc245aa9323d12623bd8029cd5f4dc6b95e367e1456cd8ac257d332af5c6` |
| [`artifacts/production-readback.json`](artifacts/production-readback.json) | 27004 | `f2ca9666f572dabcd0a01214be66f91767927c5d0487c7dda4f0a5cae9f641a4` | `f2ca9666f572dabcd0a01214be66f91767927c5d0487c7dda4f0a5cae9f641a4` |
| [`receipts/compiler-1793354095104743193-receipt.json`](receipts/compiler-1793354095104743193-receipt.json) | 178396 | `5e2c4d0e95924a8884da657298dc0cc25a2a75dbee2fc741eb08fc39617bff42` | `5e2c4d0e95924a8884da657298dc0cc25a2a75dbee2fc741eb08fc39617bff42` |
| [`receipts/compiler-1793354095104743193.log`](receipts/compiler-1793354095104743193.log) | 2334 | `119833b1a6e7f0d95a67cfa6972d90d6c306dcc52e890edc94ac030c1ffceb04` | `119833b1a6e7f0d95a67cfa6972d90d6c306dcc52e890edc94ac030c1ffceb04` |
| [`receipts/compiler-fixtures-1793353821109683319-receipt.json`](receipts/compiler-fixtures-1793353821109683319-receipt.json) | 178411 | `f462919b3bea4f60e4308ce1871b4eeafd5ba926b4330b182fa99a1427163c6f` | `f462919b3bea4f60e4308ce1871b4eeafd5ba926b4330b182fa99a1427163c6f` |
| [`receipts/compiler-fixtures-1793353821109683319.log`](receipts/compiler-fixtures-1793353821109683319.log) | 6012 | `38fe5601f3f20bd10f128dca1cfb6328c5005f6942e61bbc0abd64285ff047ca` | `38fe5601f3f20bd10f128dca1cfb6328c5005f6942e61bbc0abd64285ff047ca` |
| [`receipts/node-1793353414300906233-receipt.json`](receipts/node-1793353414300906233-receipt.json) | 178267 | `4441db45479ec7f12141b91041a10cbf7647735de59ec8d00e0cf21fe00fdeed` | `4441db45479ec7f12141b91041a10cbf7647735de59ec8d00e0cf21fe00fdeed` |
| [`receipts/node-1793353414300906233.log`](receipts/node-1793353414300906233.log) | 547 | `6218bbb4aa27b72bc328fc4ebde5c37bed1d4aee49cd048b3875c596d48387bf` | `6218bbb4aa27b72bc328fc4ebde5c37bed1d4aee49cd048b3875c596d48387bf` |
| [`receipts/node-1793354263387812460-receipt.json`](receipts/node-1793354263387812460-receipt.json) | 178264 | `fc3f6fe742ad4af9a48f0bcdfc7e3a766fb310cf4a2c87b340f1d7231e687e9c` | `fc3f6fe742ad4af9a48f0bcdfc7e3a766fb310cf4a2c87b340f1d7231e687e9c` |
| [`receipts/node-1793354263387812460.log`](receipts/node-1793354263387812460.log) | 328 | `a5d87ad7fae1cf7625d60cace92edaa37045f522ab01d396eb3d990797b73594` | `a5d87ad7fae1cf7625d60cace92edaa37045f522ab01d396eb3d990797b73594` |
| [`source/dimabot/Cargo.lock`](source/dimabot/Cargo.lock) | 143130 | `787333fa269752a606040d7393767040ef749ce1e01c2512386bf305bcd7a2c3` | `787333fa269752a606040d7393767040ef749ce1e01c2512386bf305bcd7a2c3` |
| [`source/dimabot/Cargo.toml`](source/dimabot/Cargo.toml) | 14570 | `4882343e9af14f7d0369fad879863c19ce5d379d72a577c914481b36b0f6225d` | `4882343e9af14f7d0369fad879863c19ce5d379d72a577c914481b36b0f6225d` |
| [`source/dimabot/package-lock.json`](source/dimabot/package-lock.json) | 265283 | `abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7` | `abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7` |
| [`source/dimabot/package.json`](source/dimabot/package.json) | 3640 | `cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef` | `cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef` |
| [`source/dimabot/rust-toolchain.toml`](source/dimabot/rust-toolchain.toml) | 86 | `b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2` | `b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2` |
| [`source/dimabot/src/utils/bson_js_json.rs`](source/dimabot/src/utils/bson_js_json.rs) | 11059 | `942bc7bb97b9ac6073ac954d5f7c755bcbc6074db31837ec9fc213552429482c` | `942bc7bb97b9ac6073ac954d5f7c755bcbc6074db31837ec9fc213552429482c` |
| [`source/dimabot/src/utils/credit_policy.rs`](source/dimabot/src/utils/credit_policy.rs) | 14807 | `0b17b85d9191d921b68490bccdbcb53495537f526599d69b5e94ec1db9a7cec3` | `0b17b85d9191d921b68490bccdbcb53495537f526599d69b5e94ec1db9a7cec3` |
| [`source/dimabot/src/utils/js_string.rs`](source/dimabot/src/utils/js_string.rs) | 12897 | `17b3e6a6bcd0d92210851eca25da44bbcdb2c2d9e196feb5dab58d06b75d4aed` | `17b3e6a6bcd0d92210851eca25da44bbcdb2c2d9e196feb5dab58d06b75d4aed` |
| [`source/dimabot/src/utils/json_number.rs`](source/dimabot/src/utils/json_number.rs) | 6036 | `f463c65a55bcd611ed9bad2444e50acff697969bb910b7b4c17371d0af21f419` | `f463c65a55bcd611ed9bad2444e50acff697969bb910b7b4c17371d0af21f419` |
| [`source/dimabot/src/utils/lossless_json.rs`](source/dimabot/src/utils/lossless_json.rs) | 15780 | `81655862a29d68c01ab49a79027788c569d688bc1f7c9e55cbea20816dc7f2a6` | `81655862a29d68c01ab49a79027788c569d688bc1f7c9e55cbea20816dc7f2a6` |
| [`source/dimabot/tests/bson_js_json.rs`](source/dimabot/tests/bson_js_json.rs) | 5892 | `98583001ce4b2d30414f67a85f833038ae5e60ce402d5a0285bfda69b80ceada` | `98583001ce4b2d30414f67a85f833038ae5e60ce402d5a0285bfda69b80ceada` |
| [`source/dimabot/tests/bson_js_json_benchmark.rs`](source/dimabot/tests/bson_js_json_benchmark.rs) | 6890 | `6de0a386eb78ad165329697bbf4b41d90018389d2c24bdf1c9644f62e0e7fed4` | `6de0a386eb78ad165329697bbf4b41d90018389d2c24bdf1c9644f62e0e7fed4` |
| [`source/dimabot/tests/fixtures/bson_js_json_benchmark.cjs`](source/dimabot/tests/fixtures/bson_js_json_benchmark.cjs) | 7551 | `f759723915c29b76969bac9245a888a354530ab724305b97e4eed18ff673177a` | `f759723915c29b76969bac9245a888a354530ab724305b97e4eed18ff673177a` |
| [`source/dimabot/tests/fixtures/bson_js_json_reference.cjs`](source/dimabot/tests/fixtures/bson_js_json_reference.cjs) | 9129 | `5f9f57aa6ee9402a1653a561ecfbad1f5f343cfba11545d6f8286106daee6193` | `5f9f57aa6ee9402a1653a561ecfbad1f5f343cfba11545d6f8286106daee6193` |
| [`tools-current-static/bson_json_benchmark_release1.sh`](tools-current-static/bson_json_benchmark_release1.sh) | 424 | `ee18b878defaa5c509ed94ec61d6e326cac610e85da024b2f4929271a65cdef4` | `ee18b878defaa5c509ed94ec61d6e326cac610e85da024b2f4929271a65cdef4` |
| [`tools-current-static/final_readback.py`](tools-current-static/final_readback.py) | 1324 | `3a155b75c91670db92df884bd110daeba0cfc3c364f652c1affe02e5e4936c14` | `3a155b75c91670db92df884bd110daeba0cfc3c364f652c1affe02e5e4936c14` |
| [`tools-current-static/freeze_credit_reader.py`](tools-current-static/freeze_credit_reader.py) | 2053 | `e9c97281662e95b93c108048bd735d03c17d5346c8cf1dd739e6e6e6093e34bc` | `e9c97281662e95b93c108048bd735d03c17d5346c8cf1dd739e6e6e6093e34bc` |
| [`tools-current-static/freeze_semantic_worker.py`](tools-current-static/freeze_semantic_worker.py) | 245 | `eed24158ebe36d52a3db92b7b34b5fcfbecb17b8a9b581d631abf968ae4b5a76` | `eed24158ebe36d52a3db92b7b34b5fcfbecb17b8a9b581d631abf968ae4b5a76` |
| [`tools-current-static/semantic_node_env1.sh`](tools-current-static/semantic_node_env1.sh) | 977 | `57b32a76cabbbfc172c305428a14bd82c6ae85fced12845a1099f2136bdce7a8` | `57b32a76cabbbfc172c305428a14bd82c6ae85fced12845a1099f2136bdce7a8` |
| [`tools-current-static/semantic_worker_node1.sh`](tools-current-static/semantic_worker_node1.sh) | 1077 | `ff2820d031ff320e7751b3cc4e4a897f9fae29d9937d3a7f24205ce65ae58d99` | `ff2820d031ff320e7751b3cc4e4a897f9fae29d9937d3a7f24205ce65ae58d99` |
| [`tools-current-static/semantic_worker_node3.sh`](tools-current-static/semantic_worker_node3.sh) | 529 | `7985a233b16faab2846bf27f849a70e874f0a6b4fdd712217b0a918c8cb5aa64` | `7985a233b16faab2846bf27f849a70e874f0a6b4fdd712217b0a918c8cb5aa64` |
| [`tools-current-static/validate.py`](tools-current-static/validate.py) | 12955 | `12039de7b3fb152783d1446ce409a7ab0272b1f773624b207cf12763e645e7be` | `12039de7b3fb152783d1446ce409a7ab0272b1f773624b207cf12763e645e7be` |

The JSON source manifest records 14 relevant source and build-input hashes. The SHA-256 values of those files under `source/` were compared to the manifest during assembly. The exact 128-value input SHA-256 before and after timing is recorded in `artifacts/parent-final-facts.json`.

The supplementary `artifact-sha256.json` is the complete machine-readable inventory, including this README and source bindings. It records stored hashes before decompression and raw hashes afterward for every payload except itself; earlier tables and indices describe the originally packaged payloads.
