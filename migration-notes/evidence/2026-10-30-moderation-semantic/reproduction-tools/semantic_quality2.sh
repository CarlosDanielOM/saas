set -eu
cargo fmt --all -- --check
. /task-tools/semantic_node_env1.sh
export DIMA_SEMANTIC_REFERENCE=/artifacts/moderation-semantic/attempt3/reference/moderation-semantic-reference.json
export DIMA_SEMANTIC_REFERENCE_SHA256=8dfa5ea7abaebf8b5cd52bce83a563d1fc0573f89da3bbac84898ec6b108b986
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-semantic --test moderation_semantic --test moderation_semantic_provider
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-semantic --test moderation_semantic_source -- --include-ignored --nocapture --test-threads=1
export DIMA_SPAM_REFERENCE=/artifacts/moderation-spam/attempt4/reference/moderation-spam-reference.json
export DIMA_SPAM_REFERENCE_SHA256=f6f59d6c0a021ce609ac507ed88af22960eb2cf683c31d19ec3c146a2aebc222
cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam
cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_pure_source_records -- --ignored --exact --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-semantic --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
