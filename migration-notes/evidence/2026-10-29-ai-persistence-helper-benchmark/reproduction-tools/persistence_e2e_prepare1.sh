set -eu
. /task-tools/persistence_e2e_env1.sh
node tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs --write "$DIMA_AI_PERSISTENCE_BENCH_DIR"
