set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-links,moderation-normalize --all-targets -- -D warnings
cargo test --release --locked --offline --no-default-features --features moderation-links,moderation-normalize --test moderation_text_benchmark --no-run --message-format=json > /artifacts/moderation-text-benchmark/attempt1/benchmark-build.jsonl
