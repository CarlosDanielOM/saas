set -eu
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ai-usage-lock/attempt1/reference
export DIMA_AI_LOCK_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_LOCK_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_LOCK_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --features ai-usage-lock --all-targets
cargo clippy --locked --offline --no-default-features --features ai-usage-lock --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features ai-usage-lock --lib utils::ai_usage_lock -- --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-lock --test ai_usage_lock -- --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
