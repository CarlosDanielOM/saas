set -eu
export DIMA_LINKS_REFERENCE_DIR=/artifacts/moderation-text-benchmark/attempt2/links-reference
export DIMA_MODERATION_NORMALIZE_FIXTURE_DIR=/artifacts/moderation-text-benchmark/attempt2/normalize-reference
export DIMA_MODERATION_NORMALIZE_FIXTURE_SHA256=4d5418b0721f68bc790b4333ed81cb93cbb394796f981d133573c36b1687c354
cargo test --locked --offline --no-default-features --features moderation-links,moderation-normalize --test moderation_links --test moderation_normalize -- --ignored --nocapture
cargo test --release --locked --offline --no-default-features --features moderation-links,moderation-normalize --test moderation_text_benchmark --no-run --message-format=json > /artifacts/moderation-text-benchmark/attempt2/benchmark-build.jsonl
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
