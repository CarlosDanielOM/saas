set -eu
cargo test --release --locked --offline --no-default-features --features moderation-blacklist --test moderation_blacklist_benchmark --no-run --message-format=json > /artifacts/moderation-blacklist/attempt1/benchmark-build.jsonl
