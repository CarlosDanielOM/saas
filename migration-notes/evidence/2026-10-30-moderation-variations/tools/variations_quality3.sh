set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-variations-provider --test js_unicode_nfc --test moderation_variations --test moderation_variations_provider
DIMA_VARIATIONS_REFERENCE=/artifacts/moderation-variations/attempt1/reference/moderation-variations-reference.json DIMA_VARIATIONS_REFERENCE_SHA256=1d3ab58bd78a0d34b60e139b24901920fe32d1e32de3e96bd6db486b14e39c54 cargo test --locked --offline --no-default-features --features moderation-variations-provider --test moderation_variations --test moderation_variations_provider -- --ignored --test-threads=1 --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-variations-provider --all-targets --keep-going -- -D warnings
DIMA_JS_NFC_DIR=/artifacts/js-unicode-nfc/attempt1/reference DIMA_JS_NFC_SHA256=240e640f72398185a7912cc3653ca1a3de6a67092f24e2c056364609f70f3a3f cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfc replay_all_codepoints_and_contexts_from_pinned_node -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
test ! -e /artifacts/moderation-variations/release-attempt1.jsonl
cargo test --release --locked --offline --no-default-features --features moderation-variations --test moderation_variations_benchmark --no-run --message-format=json > /artifacts/moderation-variations/release-attempt1.jsonl
