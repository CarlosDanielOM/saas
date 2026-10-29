set -eu
export TZ=UTC
wave=/artifacts/ledger-reducer-benchmark/attempt1/prepared
node tests/fixtures/ai_usage_daily_reducer_benchmark.cjs --write "$wave"
node tests/fixtures/ai_usage_daily_reducer_benchmark.cjs --check "$wave"
sha256sum "$wave/inputs.json" /usr/local/bin/node
