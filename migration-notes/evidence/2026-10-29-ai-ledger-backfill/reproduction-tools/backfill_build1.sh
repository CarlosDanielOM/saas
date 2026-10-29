set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features ai-usage-ledger-backfill --lib --test ai_usage_ledger_backfill -- -D warnings
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-backfill --test ai_usage_ledger_backfill --no-run --message-format=json > /artifacts/ledger-backfill/attempt1/backfill-build.jsonl
