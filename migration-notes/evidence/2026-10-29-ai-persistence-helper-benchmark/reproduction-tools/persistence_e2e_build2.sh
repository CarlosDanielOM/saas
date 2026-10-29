set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features ai-usage-ledger-persistence --lib --test ai_usage_persistence_e2e_benchmark -- -D warnings
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-persistence --test ai_usage_persistence_e2e_benchmark --no-run --message-format=json > /artifacts/ledger-persistence-e2e/attempt2/benchmark-build.jsonl
