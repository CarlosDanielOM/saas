set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-variations-provider --test js_unicode_nfc --test moderation_variations --test moderation_variations_provider
DIMA_VARIATIONS_REFERENCE=/artifacts/moderation-variations/attempt1/reference/moderation-variations-reference.json DIMA_VARIATIONS_REFERENCE_SHA256=1d3ab58bd78a0d34b60e139b24901920fe32d1e32de3e96bd6db486b14e39c54 cargo test --locked --offline --no-default-features --features moderation-variations-provider --test moderation_variations --test moderation_variations_provider -- --ignored --test-threads=1 --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-variations-provider --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
