set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-advanced --all-targets --keep-going -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-advanced --lib moderation::advanced::tests
cargo test --locked --offline --no-default-features --features moderation-advanced --test moderation_advanced
MODERATION_ADVANCED_FIXTURE=/artifacts/moderation-advanced/attempt1/reference/moderation-advanced-reference.json MODERATION_ADVANCED_FIXTURE_SHA256=dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a cargo test --locked --offline --no-default-features --features moderation-advanced --test moderation_advanced fixture::replay_all_464_source_cases -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
test ! -e /artifacts/moderation-advanced/benchmark-attempt2/release-build.jsonl
cargo test --release --locked --offline --no-default-features --features moderation-advanced --test moderation_advanced_benchmark --no-run --message-format=json > /artifacts/moderation-advanced/benchmark-attempt2/release-build.jsonl
