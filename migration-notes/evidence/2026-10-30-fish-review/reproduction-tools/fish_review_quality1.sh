set -eux
export FISH_FAVORITES_ORACLE=/artifacts/fish-review/attempt1/oracle/channel_fish_voice_favorites.json
export FISH_FAVORITES_ORACLE_SHA256=5e38de829d73754dd6f26f2d6b46fa47c0cf05b1bf2ea1e548d1b7604a51ff12
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features channel-fish-voice-favorites --test channel_fish_voice_favorites
cargo test --locked --offline --no-default-features --features channel-fish-voice-favorites --test channel_fish_voice_favorites source_oracle_pure_and_protocol -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features permissions --lib utils::js_compat::tests::javascript_whitespace_differs_from_rust -- --exact --nocapture
cargo clippy --locked --offline --no-default-features --features channel-fish-voice-favorites --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
