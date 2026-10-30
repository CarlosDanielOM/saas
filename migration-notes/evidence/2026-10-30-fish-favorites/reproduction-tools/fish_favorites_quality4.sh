#!/bin/sh
set -eu
cd /source/dimabot
export FISH_FAVORITES_ORACLE=/artifacts/fish-favorites/attempt4/oracle/channel_fish_voice_favorites.json
export FISH_FAVORITES_ORACLE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["FISH_FAVORITES_ORACLE"],"rb").read()).hexdigest())')"
export DIMA_RUST_TEST_RESOURCE_OWNER=fish-voice-favorites
export FISH_FAVORITES_MONGO_URI=mongodb://keyword-mongo:27017
export FISH_FAVORITES_NAMESPACE=fish-favorites-fca01b6f57a8:
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features channel-fish-voice-favorites --test channel_fish_voice_favorites -- --include-ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings_schema
cargo clippy --locked --offline --no-default-features --features channel-fish-voice-favorites --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
