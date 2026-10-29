set -eu
export DIMA_JS_UNICODE_DATA_DIR=/artifacts/js-unicode17/accepted
export DIMA_JS_UNICODE_DATA_SHA256=aba3756c8cacc9a25432c282f15141dc5d34da317c13618cfcfa43253c0e3246
export DIMA_JS_UNICODE_SOURCE_DIR=/artifacts/js-unicode17/core-attempt1/reference
export DIMA_JS_UNICODE_SOURCE_SHA256=40285eaaee4cfcb9fa381fa27ea3eb36b7f69f04174d5ce7d908e767406744f0
cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode replay_node_unicode17_and_actual_source -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
