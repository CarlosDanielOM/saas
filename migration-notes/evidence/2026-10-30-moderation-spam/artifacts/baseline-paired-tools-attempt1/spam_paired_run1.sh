#!/bin/sh
# Parent supplies every DIMA_MATCHED_PAIRED_* path and independent digest, plus
# the DIMA_ADVANCED_RE2_FIXTURE_* pins. Run only in the capped Node container.
set -eu
: "${DIMA_MATCHED_PAIRED_SOURCE_ROOT:?}" "${DIMA_MATCHED_PAIRED_FIXTURE:?}" "${DIMA_MATCHED_PAIRED_LOADER_SHA256:?}" "${DIMA_MATCHED_PAIRED_BENCHMARK_SHA256:?}" "${DIMA_MATCHED_PAIRED_CONFIG_SHA256:?}"
export DIMA_ADVANCED_SOURCE_ROOT="$DIMA_MATCHED_PAIRED_SOURCE_ROOT"
export DIMA_SPAM_LOADER_SHA256="$DIMA_MATCHED_PAIRED_LOADER_SHA256"
export DIMA_SPAM_BENCH_READER_SHA256="$DIMA_MATCHED_PAIRED_BENCHMARK_SHA256"
export DIMA_MATCHED_PAIRED_CONFIG=/task-tools/spam_paired_config.json
fixture_dir=$(dirname "$DIMA_MATCHED_PAIRED_FIXTURE")
"$DIMA_MATCHED_PAIRED_NODE" "$DIMA_ADVANCED_SOURCE_ROOT/tests/fixtures/moderation_spam_benchmark.cjs" --check "$fixture_dir"
"$DIMA_MATCHED_PAIRED_NODE" /task-tools/matched_paired_coordinator.cjs
"$DIMA_MATCHED_PAIRED_NODE" "$DIMA_ADVANCED_SOURCE_ROOT/tests/fixtures/moderation_spam_benchmark.cjs" --check "$fixture_dir"
