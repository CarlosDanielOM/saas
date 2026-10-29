set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features ai-usage-ledger-persistence --lib --test ai_usage_daily_reducer_benchmark --test ai_usage_ledger_persistence -- -D warnings
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-persistence --test ai_usage_daily_reducer_benchmark --no-run --message-format=json > /artifacts/ledger-reducer-benchmark/attempt3/benchmark-build.jsonl
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-persistence --test ai_usage_ledger_persistence --no-run --message-format=json > /artifacts/ledger-reducer-benchmark/attempt3/persistence-build.jsonl
