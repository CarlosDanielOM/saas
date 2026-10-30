set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-advanced --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
test ! -e /artifacts/moderation-advanced/benchmark-attempt1/release-build.jsonl
cargo test --release --locked --offline --no-default-features --features moderation-advanced --test moderation_advanced_benchmark --no-run --message-format=json > /artifacts/moderation-advanced/benchmark-attempt1/release-build.jsonl
