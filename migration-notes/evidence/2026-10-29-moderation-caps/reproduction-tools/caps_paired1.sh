set -eu
export DIMA_CAPS_SOURCE_ROOT=/source/dimabot
export DIMA_CAPS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_CAPS_UNICODE_DIR=/artifacts/moderation-caps/unicode-initial
export DIMA_CAPS_REFERENCE_DIR=/artifacts/moderation-caps/attempt2/reference
export DIMA_CAPS_NODE_PATH=/usr/local/bin/node
export DIMA_CAPS_BENCH_BINARY=/artifacts/moderation-caps/attempt2/bin/moderation_caps_benchmark
export DIMA_CAPS_BINARY_PROVENANCE=/artifacts/moderation-caps/attempt2/binary-provenance.json
export DIMA_CAPS_COMPILER_RECEIPT=/artifacts/compiler-1793305057976047544-receipt.json
export DIMA_CAPS_BUILD_LOG=/artifacts/moderation-caps/attempt2/benchmark-build.jsonl
export DIMA_CAPS_BENCH_REPETITIONS=2000
export DIMA_CAPS_PAIRED_DIR=/artifacts/moderation-caps/attempt2/paired1
/usr/local/bin/node /task-tools/caps_paired_coordinator.cjs
/usr/local/bin/node tests/fixtures/moderation_caps_reference.cjs --check /artifacts/moderation-caps/attempt2/reference
