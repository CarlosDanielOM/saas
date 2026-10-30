#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export FISH_FAVORITES_ORACLE=/artifacts/fish-favorites/optimized3/oracle/channel_fish_voice_favorites.json
export FISH_FAVORITES_ORACLE_SHA256=96a218de85eaf7103096cd31e24ec6edfe9f136186f7698c5ec77dfcb8971441
export JS_ASCII_LOWER_ORACLE=/artifacts/fish-favorites/optimized3/ascii-lower/js_unicode_ascii_lower.json
export JS_ASCII_LOWER_ORACLE_SHA256=7f9fc55ff0d0839f86475454870c31a462b98781718636235057b3ceed8200f4
export JS_NFKD_ORACLE=/artifacts/fish-favorites/optimized3/nfkd/js_unicode_nfkd.json
export JS_NFKD_ORACLE_SHA256=a35aa665a8aef93e7291e901593ff1afc571abf0aab55f2c14f89525bdee1bc0
export DIMA_JS_NFC_DIR=/artifacts/fish-favorites/optimized3/nfc
export DIMA_JS_NFC_SHA256=a6bf30f803bf12e2a3420a0d972ee24b13c77f2954362b624e46ed99af30328d
cargo fmt --all -- --check
DIMA_RUST_TEST_RESOURCE_OWNER=fish-voice-favorites FISH_FAVORITES_MONGO_URI=mongodb://keyword-mongo:27017 FISH_FAVORITES_NAMESPACE=fish-favorites-fca01b6f57a8: cargo test --locked --offline --no-default-features --features channel-fish-voice-favorites --test channel_fish_voice_favorites -- --include-ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode --test js_unicode_nfc --test js_unicode_nfkd --test js_unicode_ascii_lower
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_ascii_lower pinned_node_all_scalars_and_mixed_boundaries -- --ignored --exact
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfkd pinned_node_all_scalar_and_mixed_nfkd -- --ignored --exact
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfc replay_all_codepoints_and_contexts_from_pinned_node -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features channel-fish-voice-favorites --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
