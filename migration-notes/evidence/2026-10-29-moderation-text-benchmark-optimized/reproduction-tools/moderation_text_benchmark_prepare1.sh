set -eu
export DIMA_MODERATION_TEXT_SOURCE_ROOT=/source/dimabot
export DIMA_MODERATION_TEXT_BENCH_DIR=/artifacts/moderation-text-benchmark/attempt1/prepared
export DIMA_MODERATION_TEXT_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
/usr/local/bin/node tests/fixtures/moderation_text_benchmark.cjs --write
/usr/local/bin/node tests/fixtures/moderation_text_benchmark.cjs --check
