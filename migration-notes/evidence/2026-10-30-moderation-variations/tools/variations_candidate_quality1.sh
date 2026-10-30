set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-variations-provider --test js_unicode_nfc --test moderation_variations --test moderation_variations_provider
DIMA_VARIATIONS_REFERENCE=/artifacts/moderation-variations/attempt1/reference/moderation-variations-reference.json DIMA_VARIATIONS_REFERENCE_SHA256=1d3ab58bd78a0d34b60e139b24901920fe32d1e32de3e96bd6db486b14e39c54 cargo test --locked --offline --no-default-features --features moderation-variations-provider --test moderation_variations --test moderation_variations_provider -- --ignored --test-threads=1 --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-variations-provider --all-targets --keep-going -- -D warnings
DIMA_JS_NFC_DIR=/artifacts/js-unicode-nfc/attempt2/reference DIMA_JS_NFC_SHA256=d6d4deec7f2b4374d062c66cef705f146e72c96c8e7f2c4e4183390e43cfa721 cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfc replay_all_codepoints_and_contexts_from_pinned_node -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --features moderation-types --all-targets
cargo test --locked --offline --no-default-features --features channel-moderation-settings,moderation-seed-plan --test channel_moderation_settings_schema --test moderation_seed_plan
cargo test --locked --offline --no-default-features --features moderation-advanced --test moderation_advanced --test moderation_advanced_policy
cargo test --locked --offline --no-default-features --features moderation-advanced --lib moderation::advanced::tests
MODERATION_ADVANCED_FIXTURE=/artifacts/moderation-advanced/attempt1/reference/moderation-advanced-reference.json MODERATION_ADVANCED_FIXTURE_SHA256=dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a cargo test --locked --offline --no-default-features --features moderation-advanced --test moderation_advanced fixture::replay_all_464_source_cases -- --ignored --exact
DIMA_MODERATION_ADVANCED_FIXTURE=/artifacts/moderation-advanced/attempt1/reference/moderation-advanced-reference.json DIMA_MODERATION_ADVANCED_FIXTURE_SHA256=dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a cargo test --locked --offline --no-default-features --features moderation-advanced-policy --test moderation_advanced_policy source_semantic_subset_replay -- --ignored --exact
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
test ! -e /artifacts/moderation-variations/release-attempt2.jsonl
cargo test --release --locked --offline --no-default-features --features moderation-variations --test moderation_variations_benchmark --no-run --message-format=json > /artifacts/moderation-variations/release-attempt2.jsonl
