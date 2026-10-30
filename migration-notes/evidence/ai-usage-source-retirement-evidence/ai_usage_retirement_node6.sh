set -eu
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-abcdefgh:
export KEYWORD_FIXTURE_NAMESPACE=keyword-fixture-fca01b6f57a8:
export TZ=UTC
old=/artifacts/ai-usage-retirement/attempt5
wave=/artifacts/ai-usage-retirement/attempt6
mkdir -p "$wave/backfill" "$wave/persistence" "$wave/queries"
node tests/fixtures/ai_usage_source_resolver.test.cjs
node tests/fixtures/ai_usage_lossless_reference.cjs --check "$old/lossless"
node tests/fixtures/ai_usage_producer_reference.cjs --check "$old/producer"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$old/parser"
node tests/fixtures/posthog_tracking_reference.cjs --check "$old/tracking"
node tests/fixtures/polar_cache_usage_reference.cjs --check "$old/polar"
node tests/fixtures/ai_usage_lock_reference.cjs --check "$old/lock"
export DIMA_AI_LOCK_REFERENCE_DIR="$old/lock"
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --write "$wave/backfill"
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --check "$wave/backfill"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$wave/persistence"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$wave/persistence"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$wave/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$wave/queries"
node tests/fixtures/ai_usage_daily_reducer_benchmark.cjs --check "$old/daily"
node tests/fixtures/ai_usage_producer_benchmark.cjs --check-input "$old/producer-benchmark"
node tests/fixtures/posthog_tracking_benchmark.cjs --check-input "$old/tracking-benchmark"
sh /task-tools/ai_usage_retirement_e2e_check.sh
