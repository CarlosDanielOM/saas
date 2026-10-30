set -eu
cargo fmt --all -- --check
test ! -e /artifacts/moderation-spam/release-attempt1.jsonl
cargo test --release --locked --offline --no-default-features --features moderation-spam --test moderation_spam_benchmark --no-run --message-format=json > /artifacts/moderation-spam/release-attempt1.jsonl
