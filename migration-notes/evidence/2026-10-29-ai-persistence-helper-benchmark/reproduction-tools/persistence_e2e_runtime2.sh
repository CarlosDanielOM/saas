set -eu
. /task-tools/persistence_e2e_env2.sh
. /task-tools/persistence_e2e_digests2.sh
export DIMA_AI_PERSISTENCE_BENCH_NATIVE_SHA256=2455084bda9caac87f015890a10b7403e42cf2b3c521514adba566e47d48ca67
wave=/artifacts/ledger-persistence-e2e/attempt2
printf '%s  %s\n' "$DIMA_AI_PERSISTENCE_BENCH_NATIVE_SHA256" "$wave/bin/ai_usage_persistence_e2e_benchmark" | sha256sum -c -
find "$wave/prepared" "$wave/bin" -type f -exec sha256sum {} \; | sort > "$wave/runtime-before.sha256"
node tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs --check "$wave/prepared"
"$wave/bin/ai_usage_persistence_e2e_benchmark" real_persistence_helpers_matched_trials --ignored --exact --nocapture --test-threads=1
node tests/fixtures/ai_usage_persistence_e2e_benchmark.cjs --check "$wave/prepared"
find "$wave/prepared" "$wave/bin" -type f ! -name report.json ! -name samples.ndjson -exec sha256sum {} \; | sort > "$wave/runtime-after.sha256"
cmp "$wave/runtime-before.sha256" "$wave/runtime-after.sha256"
