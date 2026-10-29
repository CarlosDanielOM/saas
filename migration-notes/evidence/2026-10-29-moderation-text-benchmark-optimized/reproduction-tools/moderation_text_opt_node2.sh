set -eu
export DIMA_MODERATION_TEXT_SOURCE_ROOT=/source/dimabot
export DIMA_MODERATION_TEXT_BENCH_DIR=/artifacts/moderation-text-benchmark/attempt2/prepared
export DIMA_MODERATION_TEXT_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
/usr/local/bin/node tests/fixtures/moderation_text_benchmark.cjs --write
/usr/local/bin/node tests/fixtures/moderation_text_benchmark.cjs --check

set -eu
export DIMA_LINKS_SOURCE_ROOT=/source/dimabot
export DIMA_LINKS_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
/usr/local/bin/node tests/fixtures/moderation_links_reference.cjs --write /artifacts/moderation-text-benchmark/attempt2/links-reference
/usr/local/bin/node tests/fixtures/moderation_links_reference.cjs --check /artifacts/moderation-text-benchmark/attempt2/links-reference
export DIMA_MODERATION_NORMALIZE_SOURCE_ROOT=/source/dimabot
export DIMA_MODERATION_NORMALIZE_NODE_SHA256="$DIMA_LINKS_NODE_SHA256"
/usr/local/bin/node tests/fixtures/moderation_normalize_reference.cjs --write /artifacts/moderation-text-benchmark/attempt2/normalize-reference
/usr/local/bin/node tests/fixtures/moderation_normalize_reference.cjs --check /artifacts/moderation-text-benchmark/attempt2/normalize-reference
