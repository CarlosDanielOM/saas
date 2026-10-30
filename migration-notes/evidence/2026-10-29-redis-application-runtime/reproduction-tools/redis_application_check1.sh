set -eu
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --features redis-application-runtime --all-targets
cargo clippy --locked --offline --no-default-features --features redis-application-runtime --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --features moderation-permit,moderation-offenses --all-targets
cargo clippy --locked --offline --no-default-features --features moderation-permit,moderation-offenses --all-targets -- -D warnings
