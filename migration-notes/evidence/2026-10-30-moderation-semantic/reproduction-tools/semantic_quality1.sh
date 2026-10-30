set -eu
cargo fmt --all -- --check
. /task-tools/semantic_node_env1.sh
export DIMA_SEMANTIC_REFERENCE=/artifacts/moderation-semantic/attempt2/reference/moderation-semantic-reference.json
export DIMA_SEMANTIC_REFERENCE_SHA256=a7570c80dcf5c28ebcc5c3230ad3c1202bc69e39a04d4d308865ab513f74a61d
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-semantic --test moderation_semantic --test moderation_semantic_provider
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-semantic --test moderation_semantic_source -- --include-ignored --nocapture --test-threads=1
cargo clippy --locked --offline --no-default-features --features moderation-semantic --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
