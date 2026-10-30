set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features ai-credit-reader --test ai_credit_reader --test ai_credit_reader_protocol
sh /task-tools/credit_reader_runtime2.sh
cargo clippy --locked --offline --no-default-features --features ai-credit-reader --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
