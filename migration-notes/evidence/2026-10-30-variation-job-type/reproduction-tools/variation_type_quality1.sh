set -eu
export TZ=UTC
export DIMA_VARIATION_SCHEMA_FIXTURE_DIR=/artifacts/variation-type/attempt1/oracle
export DIMA_VARIATION_SCHEMA_FIXTURE_SHA256=2d446d970060e76f3a0ef37e3fe71d9d135b57bc30eed68a0213f3422c2ba4a7
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema -- --include-ignored --nocapture --test-threads=1
cargo clippy --locked --offline --no-default-features --features moderation-variation-storage --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
