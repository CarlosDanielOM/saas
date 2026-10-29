set -eu
export TZ=UTC
wave=/artifacts/ledger-reducer-benchmark/attempt3
printf '%s  %s\n' '6cbbd36240ca756a58a12dcd8a91594a076377a41eaf77b936e246c1e40d8031' '/artifacts/ledger-reducer-benchmark/attempt3/bin/ai_usage_daily_reducer_benchmark' | sha256sum -c -
printf '%s  %s\n' 'f7963d55a3c7d1b7756ff1f5cf3441cd0e7b8bd83c4367439e4c5d73c300324d' '/artifacts/ledger-reducer-benchmark/attempt3/bin/ai_usage_ledger_persistence' | sha256sum -c -
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-persistence/attempt3/lock
mkdir "$wave/persistence-reference"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$wave/persistence-reference"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$wave/persistence-reference"
export DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR="$wave/persistence-reference"
export DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY=/usr/local/bin/node
export DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT=/source/dimabot
"$wave/bin/ai_usage_ledger_persistence" --nocapture
"$wave/bin/ai_usage_ledger_persistence" complete_actual_source_replay --ignored --exact --nocapture
export DIMA_DAILY_REDUCER_BENCH_DIR="$wave/prepared"
export DIMA_DAILY_REDUCER_NODE=/usr/local/bin/node
export DIMA_DAILY_REDUCER_INPUT_SHA256=a65715ff6e119fe68be6f89a096e397e20018ea022ea4f9f035816a530ae71c5
export DIMA_DAILY_REDUCER_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
find "$wave/prepared" "$wave/bin" -type f -exec sha256sum {} \; | sort > "$wave/runtime-before.sha256"
"$wave/bin/ai_usage_daily_reducer_benchmark" prepared_daily_reducer_matched_trials --ignored --exact --nocapture
node tests/fixtures/ai_usage_daily_reducer_benchmark.cjs --check "$wave/prepared"
find "$wave/prepared" "$wave/bin" -type f ! -name rust-node-trials.json -exec sha256sum {} \; | sort > "$wave/runtime-after.sha256"
cmp "$wave/runtime-before.sha256" "$wave/runtime-after.sha256"
