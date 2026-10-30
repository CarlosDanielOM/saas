#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export FISH_FAVORITES_ORACLE=/artifacts/fish-favorites/optimized2/oracle/channel_fish_voice_favorites.json
export FISH_FAVORITES_ORACLE_SHA256=ae44ad54424ad745e99179830fd4bc6d726fa14020c58fde1923d9ca31b971bd
cargo fmt --all -- --check
DIMA_RUST_TEST_RESOURCE_OWNER=fish-voice-favorites FISH_FAVORITES_MONGO_URI=mongodb://keyword-mongo:27017 FISH_FAVORITES_NAMESPACE=fish-favorites-fca01b6f57a8: cargo test --locked --offline --no-default-features --features channel-fish-voice-favorites --test channel_fish_voice_favorites -- --include-ignored --nocapture --test-threads=1
cargo clippy --locked --offline --no-default-features --features channel-fish-voice-favorites --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
